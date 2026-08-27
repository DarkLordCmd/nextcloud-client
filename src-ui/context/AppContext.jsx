import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';

const AppContext = createContext(null);

export function useApp() {
  return useContext(AppContext);
}

export function AppProvider({ children }) {
  const [auth, setAuth] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState('/');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [operations, setOperations] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [treeNodes, setTreeNodes] = useState({ '/': [] });
  const [preview, setPreview] = useState(null);

  const pathRef = useRef('/');
  const filesRef = useRef([]);
  const selectedRef = useRef(new Set());
  const inputRef = useRef(null);
  const operationsRef = useRef([]);

  useEffect(() => {
    pathRef.current = currentPath;
  }, [currentPath]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    operationsRef.current = operations;
  }, [operations]);

  // On mount, check whether credentials are already saved.
  useEffect(() => {
    api
      .authStatus()
      .then((data) => setAuth(data))
      .catch(() => setAuth({ logged_in: false }))
      .finally(() => setAuthLoading(false));
  }, []);

  const loadFiles = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.list(path);
      setFiles(data.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load root contents once authenticated.
  useEffect(() => {
    if (auth && auth.logged_in) {
      loadFiles('/');
      const data = auth;
      setAuth(data);
    }
  }, [auth && auth.logged_in]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = useCallback(
    (path) => {
      setCurrentPath(path);
      loadFiles(path);
      setSelected(new Set());
    },
    [loadFiles]
  );

  const goUp = useCallback(() => {
    const p = pathRef.current;
    if (p === '/') return;
    const parent = p.slice(0, p.lastIndexOf('/')) || '/';
    navigate(parent);
  }, [navigate]);

  const refresh = useCallback(() => {
    loadFiles(pathRef.current);
  }, [loadFiles]);

  const login = useCallback(async (creds) => {
    const data = await api.login(creds);
    setAuth({ logged_in: true, server: data.server, username: data.username });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setAuth({ logged_in: false });
    setFiles([]);
    setSelected(new Set());
    setOperations([]);
  }, []);

  // --- Selection helpers ---
  const toggleSelect = useCallback((path, multi = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else {
        next.clear();
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filesRef.current.map((f) => f.path)));
  }, []);

  const replaceSelection = useCallback((paths) => {
    setSelected(new Set(paths));
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const openPreview = useCallback((path) => setPreview(path), []);
  const closePreview = useCallback(() => setPreview(null), []);

  // --- Operations (uploads) + SSE ---
  useEffect(() => {
    if (!auth || !auth.logged_in) return;
    const es = new EventSource(api.progressUrl());

    const upsert = (evt) => {
      setOperations((prev) => {
        const idx = prev.findIndex((op) => op.id === evt.id);
        if (idx === -1) return [...prev, evt];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
    };

    es.addEventListener('progress', (e) => {
      try {
        upsert({ ...JSON.parse(e.data), status: 'active' });
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('done', (e) => {
      try {
        upsert({ ...JSON.parse(e.data), status: 'done' });
        setTimeout(() => {
          setOperations((prev) => prev.filter((op) => op.id !== JSON.parse(e.data).id));
        }, 2000);
      } catch {
        // ignore
      }
    });
    es.addEventListener('error', (e) => {
      try {
        upsert({ ...JSON.parse(e.data), status: 'error' });
      } catch {
        // ignore
      }
    });

    return () => es.close();
  }, [auth && auth.logged_in]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissOperation = useCallback((id) => {
    setOperations((prev) => prev.filter((op) => op.id !== id));
  }, []);

  // --- File operations ---
  const downloadFile = useCallback(async (path) => {
    const blob = await api.downloadBlob(path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const uploadFiles = useCallback(
    async (filesToUpload) => {
      const dir = pathRef.current;
      for (const file of filesToUpload) {
        try {
          await api.upload(dir, file);
        } catch (e) {
          setOperations((prev) => [
            ...prev,
            {
              id: `local-${Date.now()}-${file.name}`,
              kind: 'error',
              filename: file.name,
              error: e.message,
              status: 'error',
            },
          ]);
        }
      }
      loadFiles(dir);
    },
    [loadFiles]
  );

  const createFolder = useCallback(
    async (name) => {
      const dir = pathRef.current;
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
      await api.mkdir(full);
      loadFiles(dir);
    },
    [loadFiles]
  );

  const deleteSelected = useCallback(async () => {
    const sel = selectedRef.current;
    for (const p of sel) {
      try {
        await api.remove(p);
      } catch (e) {
        setError(e.message);
      }
    }
    setSelected(new Set());
    loadFiles(pathRef.current);
  }, [loadFiles]);

  const renameItem = useCallback(
    async (path, newName) => {
      await api.rename(path, newName);
      loadFiles(pathRef.current);
    },
    [loadFiles]
  );

  const openUploadDialog = useCallback(() => {
    if (inputRef.current) inputRef.current.click();
  }, []);

  // --- Tree (FileExplorer lazy loading) ---
  const ensureNode = useCallback(async (path) => {
    try {
      const data = await api.list(path);
      setTreeNodes((prev) => ({ ...prev, [path]: data.files || [] }));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // --- Hotkeys ---
  useEffect(() => {
    if (!auth || !auth.logged_in) return;
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'F5') {
        e.preventDefault();
        refresh();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        goUp();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        if (selectedRef.current.size > 0) deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        openUploadDialog();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [auth && auth.logged_in, refresh, goUp, deleteSelected, selectAll, openUploadDialog]);

  // --- Drag & drop from OS ---
  useEffect(() => {
    if (!auth || !auth.logged_in) return;
    const onDragOver = (e) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    const onDrop = (e) => {
      e.preventDefault();
      setDragOver(false);
      const filesToUpload = Array.from(e.dataTransfer?.files || []);
      if (filesToUpload.length > 0) uploadFiles(filesToUpload);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [auth && auth.logged_in, uploadFiles]);

  const value = useMemo(
    () => ({
      auth,
      authLoading,
      currentPath,
      files,
      loading,
      error,
      selected,
      operations,
      dragOver,
      treeNodes,
      preview,
      setError,
      inputRef,
      login,
      logout,
      navigate,
      goUp,
      refresh,
      loadFiles,
      toggleSelect,
      selectAll,
      replaceSelection,
      clearSelection,
      downloadFile,
      uploadFiles,
      createFolder,
      deleteSelected,
      renameItem,
      openUploadDialog,
      dismissOperation,
      ensureNode,
      openPreview,
      closePreview,
      setDragOver,
    }),
    [
      auth,
      authLoading,
      currentPath,
      files,
      loading,
      error,
      selected,
      operations,
      dragOver,
      treeNodes,
      preview,
      login,
      logout,
      navigate,
      goUp,
      refresh,
      loadFiles,
      toggleSelect,
      selectAll,
      replaceSelection,
      clearSelection,
      downloadFile,
      uploadFiles,
      createFolder,
      deleteSelected,
      renameItem,
      openUploadDialog,
      dismissOperation,
      ensureNode,
      openPreview,
      closePreview,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}