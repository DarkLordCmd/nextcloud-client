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
  // Sequence guard so a stale list() response cannot overwrite a newer one.
  const listSeq = useRef(0);
  // Short-lived listing cache (path -> { files, ts }) for instant back-navigation.
  const listCache = useRef(new Map());
  const LIST_CACHE_TTL = 20000;

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

  const invalidateCache = useCallback((path) => {
    listCache.current.delete(path);
    if (path && path !== '/') {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      listCache.current.delete(parent);
    }
  }, []);

  const loadFiles = useCallback(async (path) => {
    const seq = ++listSeq.current;
    setError(null);

    // Serve a fresh cache entry instantly, then refresh in the background.
    const cached = listCache.current.get(path);
    if (cached && Date.now() - cached.ts < LIST_CACHE_TTL) {
      setFiles(cached.files);
      setLoading(false);
      try {
        const data = await api.list(path);
        if (seq !== listSeq.current) return;
        setFiles(data.files || []);
        listCache.current.set(path, { files: data.files || [], ts: Date.now() });
      } catch (e) {
        if (seq === listSeq.current) setError(e.message);
      } finally {
        if (seq === listSeq.current) setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const data = await api.list(path);
      if (seq !== listSeq.current) return;
      setFiles(data.files || []);
      listCache.current.set(path, { files: data.files || [], ts: Date.now() });
    } catch (e) {
      if (seq !== listSeq.current) return;
      setError(e.message);
    } finally {
      if (seq === listSeq.current) setLoading(false);
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

    // Throttle progress updates: accumulate events by id and flush at most
    // every ~150ms, except terminal (done/error) events which flush at once.
    const pending = new Map();
    let flushTimer = null;
    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const updates = Array.from(pending.entries());
      pending.clear();
      if (updates.length === 0) return;
      setOperations((prev) => {
        const next = [...prev];
        for (const [id, evt] of updates) {
          const idx = next.findIndex((op) => op.id === id);
          if (idx === -1) next.push(evt);
          else next[idx] = evt;
        }
        return next;
      });
    };
    const schedule = (evt) => {
      pending.set(evt.id, evt);
      if (evt.status === 'done' || evt.status === 'error') {
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, 150);
      }
    };

    es.addEventListener('progress', (e) => {
      try {
        schedule({ ...JSON.parse(e.data), status: 'active' });
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('done', (e) => {
      try {
        schedule({ ...JSON.parse(e.data), status: 'done' });
        const id = JSON.parse(e.data).id;
        setTimeout(() => {
          setOperations((prev) => prev.filter((op) => op.id !== id));
        }, 2000);
      } catch {
        // ignore
      }
    });
    es.addEventListener('error', (e) => {
      try {
        schedule({ ...JSON.parse(e.data), status: 'error' });
      } catch {
        // ignore
      }
    });

    return () => {
      es.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
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
      invalidateCache(dir);
      // Upload several files in parallel with a small concurrency limit.
      const CONCURRENCY = 3;
      let next = 0;
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, filesToUpload.length) },
        async () => {
          while (next < filesToUpload.length) {
            const file = filesToUpload[next];
            next += 1;
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
        }
      );
      await Promise.all(workers);
      loadFiles(dir);
    },
    [loadFiles, invalidateCache]
  );

  const createFolder = useCallback(
    async (name) => {
      const dir = pathRef.current;
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
      await api.mkdir(full);
      invalidateCache(dir);
      loadFiles(dir);
    },
    [loadFiles, invalidateCache]
  );

  const deleteSelected = useCallback(async () => {
    const sel = selectedRef.current;
    const dir = pathRef.current;
    for (const p of sel) {
      try {
        await api.remove(p);
      } catch (e) {
        setError(e.message);
      }
    }
    setSelected(new Set());
    invalidateCache(dir);
    loadFiles(dir);
  }, [loadFiles, invalidateCache]);

  const renameItem = useCallback(
    async (path, newName) => {
      await api.rename(path, newName);
      invalidateCache(pathRef.current);
      loadFiles(pathRef.current);
    },
    [loadFiles, invalidateCache]
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