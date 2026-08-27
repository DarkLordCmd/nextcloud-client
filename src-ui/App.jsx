import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import LoginForm from './components/LoginForm';
import FileExplorer from './components/FileExplorer';
import FileList from './components/FileList';
import Toolbar from './components/Toolbar';
import Breadcrumb from './components/Breadcrumb';
import ProgressPanel from './components/ProgressPanel';

function MainScreen() {
  const { inputRef, dragOver, uploadFiles } = useApp();

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-nc-border bg-nc-panel px-4 py-2">
        <Breadcrumb />
        <Toolbar />
      </header>

      <div className="flex min-h-0 flex-1">
        <FileExplorer />
        <FileList />
      </div>

      <ProgressPanel />

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            uploadFiles(Array.from(e.target.files));
          }
          e.target.value = '';
        }}
      />

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-nc-accent/20 backdrop-blur-sm">
          <div className="rounded-lg border-2 border-dashed border-nc-accent bg-nc-panel px-10 py-8 text-center">
            <div className="text-4xl">📤</div>
            <div className="mt-2 text-lg font-semibold">Drop to upload</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Root() {
  const { auth, authLoading } = useApp();

  if (authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin rounded-full border-4 border-nc-border border-t-nc-accent" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  return auth && auth.logged_in ? <MainScreen /> : <LoginForm />;
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}