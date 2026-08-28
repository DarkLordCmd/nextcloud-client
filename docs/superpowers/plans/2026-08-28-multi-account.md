# Multi-Account (Telegram-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram-style multi-account support: store several NextCloud accounts (users/servers) on disk, switch between them from the toolbar, add accounts via a dedicated modal.

**Architecture:** Rust backend keeps a `Vec<AuthState>` + active index in memory; WebDAV uses the active account. Electron main persists the account list in `settings.json` and imports it into the backend at startup. Frontend gets an account menu in the toolbar, a new AddAccountModal, and LoginForm for the empty state.

**Tech Stack:** Rust/axum, React 18, electron-builder. No new dependencies.

## Global Constraints

- No new npm dependencies.
- Accounts stored in `settings.json` (server, username, password) — plain text, per approved design.
- Backend never returns passwords in `GET /api/auth/status`.
- Dedup by (server, username); adding an existing account updates its password.
- `require_auth` uses the active account; empty list → `NotAuthenticated`.
- `Log out` deletes the active account; if none remain → `logged_in: false`.
- No release / no installer / no version bump in this task. Commits only.
- UI strings go through `t()` (EN/RU) in `src-ui/i18n.jsx`.
- Rust must compile (`cargo build`), UI must build (`vite build`).

---

### Task 1: Backend — multi-account AppState + login/status/require_auth

**Files:**
- Modify: `src-rust/src/server.rs` (AppState fields + router)
- Modify: `src-rust/src/auth.rs`

**Interfaces:**
- Produces:
  - `AppState.accounts: Arc<RwLock<Vec<AuthState>>>`, `AppState.active: Arc<AtomicUsize>` (usize::MAX = none).
  - `require_auth(state) -> Result<AuthState, AppError>` returns active account.
  - `login`, `status`, `logout`, `switch_account`, `delete_account`, `import_accounts` handlers (Rust).
  - Response shape for `status`/`login`/`switch`/`delete`/`logout`:
    `{ logged_in: bool, server?, username?, accounts: [{server, username}], active: {server, username} | null }`.
  - `import` request body: `{ accounts: [{server, username, password}] }`; response: same account-state shape.

- [ ] **Step 1: Rewrite `AppState` auth fields in `server.rs`**

Replace in `src-rust/src/server.rs`:

```rust
pub struct AppState {
    /// All saved accounts. In-memory copy; Electron persists the list on disk.
    pub accounts: Arc<RwLock<Vec<AuthState>>>,
    /// Index of the active account in `accounts`; `usize::MAX` when none.
    pub active: Arc<std::sync::atomic::AtomicUsize>,
    ...
}
```

In `AppState::new`, replace `auth: Arc::new(RwLock::new(None)),` with:

```rust
accounts: Arc::new(RwLock::new(Vec::new())),
active: Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX)),
```

In `build_router`, add routes:

```rust
.route("/api/auth/switch", post(auth::switch_account))
.route("/api/auth/account", axum::routing::delete(auth::delete_account))
.route("/api/auth/import", post(auth::import_accounts))
```

- [ ] **Step 2: Rewrite `auth.rs`**

Full replacement of `src-rust/src/auth.rs`:

```rust
use std::sync::atomic::Ordering;

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    models::{ApiOk, AppError},
    nextcloud,
    server::AppState,
};

/// Saved connection credentials. Stored in memory and persisted to disk by Electron.
#[derive(Debug, Clone)]
pub struct AuthState {
    pub server: String,
    pub username: String,
    pub password: String,
}

impl AuthState {
    /// Root WebDAV URL for this user, e.g. `https://host/remote.php/dav/files/alice/`.
    pub fn dav_base(&self) -> String {
        let username = nextcloud::encode_segment(&self.username);
        format!(
            "{}/remote.php/dav/files/{}/",
            self.server.trim_end_matches('/'),
            username
        )
    }
}

/// Active account, or `NotAuthenticated` when there is none.
pub async fn require_auth(state: &AppState) -> Result<AuthState, AppError> {
    let idx = state.active.load(Ordering::SeqCst);
    let guard = state.accounts.read().await;
    guard.get(idx).cloned().ok_or(AppError::NotAuthenticated)
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub server: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AccountMeta {
    pub server: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct AccountState {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub accounts: Vec<AccountMeta>,
    pub active: Option<AccountMeta>,
}

/// Build the current account-state response (list + active, no passwords).
async fn account_state(state: &AppState) -> AccountState {
    let guard = state.accounts.read().await;
    let idx = state.active.load(Ordering::SeqCst);
    let active = guard.get(idx).map(|a| AccountMeta {
        server: a.server.clone(),
        username: a.username.clone(),
    });
    AccountState {
        logged_in: active.is_some(),
        server: active.as_ref().map(|a| a.server.clone()),
        username: active.as_ref().map(|a| a.username.clone()),
        accounts: guard
            .iter()
            .map(|a| AccountMeta {
                server: a.server.clone(),
                username: a.username.clone(),
            })
            .collect(),
        active,
    }
}

/// `POST /api/auth/login` — validate, upsert, activate.
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    if req.username.trim().is_empty() {
        return Err(AppError::BadRequest("Username is required.".into()));
    }
    let auth = AuthState {
        server: normalize_server(&req.server)?,
        username: req.username.trim().to_string(),
        password: req.password,
    };

    nextcloud::verify_auth(&state.http, &auth).await?;

    let mut guard = state.accounts.write().await;
    let mut idx = guard
        .iter()
        .position(|a| a.server == auth.server && a.username == auth.username);
    if let Some(i) = idx {
        guard[i] = auth.clone();
    } else {
        guard.push(auth.clone());
        idx = Some(guard.len() - 1);
    }
    state.active.store(idx.unwrap(), Ordering::SeqCst);
    drop(guard);

    tracing::info!(server = %auth.server, username = %auth.username, "login success");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `GET /api/auth/status` — account list + active (no passwords).
pub async fn status(State(state): State<AppState>) -> Result<Json<ApiOk<AccountState>>, AppError> {
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/switch { server, username }` — activate an existing account.
#[derive(Deserialize)]
pub struct SwitchRequest {
    pub server: String,
    pub username: String,
}

pub async fn switch_account(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let guard = state.accounts.read().await;
    let idx = guard
        .iter()
        .position(|a| a.server == req.server && a.username == req.username)
        .ok_or_else(|| AppError::BadRequest("Account not found.".into()))?;
    drop(guard);
    state.active.store(idx, Ordering::SeqCst);
    tracing::info!(server = %req.server, username = %req.username, "switch account");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `DELETE /api/auth/account { server, username }` — remove an account.
#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    pub server: String,
    pub username: String,
}

pub async fn delete_account(
    State(state): State<AppState>,
    Json(req): Json<DeleteAccountRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let mut guard = state.accounts.write().await;
    let idx = guard
        .iter()
        .position(|a| a.server == req.server && a.username == req.username)
        .ok_or_else(|| AppError::BadRequest("Account not found.".into()))?;
    guard.remove(idx);
    let active = state.active.load(Ordering::SeqCst);
    if active == idx {
        state.active.store(if guard.is_empty() { usize::MAX } else { 0 }, Ordering::SeqCst);
    } else if active > idx {
        state.active.store(active - 1, Ordering::SeqCst);
    }
    drop(guard);
    tracing::info!(server = %req.server, username = %req.username, "account deleted");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/import` — replace the account list (called at startup by Electron).
#[derive(Deserialize)]
pub struct ImportRequest {
    pub accounts: Vec<LoginRequest>,
}

pub async fn import_accounts(
    State(state): State<AppState>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let accounts = req
        .accounts
        .into_iter()
        .map(|a| AuthState {
            server: normalize_server(&a.server).unwrap_or_else(|_| a.server),
            username: a.username.trim().to_string(),
            password: a.password,
        })
        .collect::<Vec<_>>();
    *state.accounts.write().await = accounts;
    state.active.store(if req.accounts.is_empty() { usize::MAX } else { 0 }, Ordering::SeqCst);
    tracing::info!(count = state.accounts.read().await.len(), "accounts imported");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/logout` — remove the active account (Telegram-style Log out).
pub async fn logout(State(state): State<AppState>) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let idx = state.active.load(Ordering::SeqCst);
    let mut guard = state.accounts.write().await;
    if idx < guard.len() {
        guard.remove(idx);
    }
    state.active.store(if guard.is_empty() { usize::MAX } else { 0 }, Ordering::SeqCst);
    drop(guard);
    tracing::info!("logout");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

fn normalize_server(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Server URL is required.".into()));
    }
    let mut url = trimmed.to_string();
    if !url.contains("://") {
        url = format!("https://{url}");
    }
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| AppError::BadRequest("Invalid server URL.".into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::BadRequest(
            "Server URL must start with http:// or https://".into(),
        ));
    }
    Ok(url.trim_end_matches('/').to_string())
}
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cargo build --manifest-path src-rust/Cargo.toml`
Expected: `Finished` without errors.

- [ ] **Step 4: Commit**

```bash
git add src-rust/src/server.rs src-rust/src/auth.rs
git commit -m "feat: multi-account backend (accounts list, switch, delete, import)"
```

---

### Task 2: Electron main — persist accounts and import at startup

**Files:**
- Modify: `src-electron/downloads.js` (default settings + IPC)
- Modify: `src-electron/preload.js` (bridge)
- Modify: `src-electron/main.js` (import at startup)

**Interfaces:**
- Produces:
  - `defaultSettings().accounts = []`.
  - IPC `accounts:save` (payload `{ accounts: [{server, username, password}], active: {server, username} | null }`) → saves to `settings.json`.
  - IPC `accounts:load` → returns `settings.accounts`.
  - preload: `saveAccounts(accounts, active)`.
  - `main.js` calls import after backend ready.

- [ ] **Step 1: Add accounts to default settings + IPC handlers in `downloads.js`**

In `src-electron/downloads.js` `defaultSettings()`, add `accounts: []`:

```js
function defaultSettings() {
  return {
    downloadDir: '',
    askDownloadLocation: true,
    uploadSpeedLimit: 0,
    downloadSpeedLimit: 0,
    language: 'en',
    accounts: [],
  };
}
```

In `initDownloadsModule`, after the `settings:choose-dir` handler, add:

```js
  ipcMain.handle('accounts:load', () => loadSettings().accounts || []);
  ipcMain.handle('accounts:save', (_e, { accounts, active }) => {
    const s = loadSettings();
    s.accounts = Array.isArray(accounts) ? accounts : [];
    saveSettings();
    return s.accounts;
  });
```

- [ ] **Step 2: Expose bridge in `preload.js`**

In `src-electron/preload.js` `contextBridge.exposeInMainWorld('nextcloud', {...})`, add:

```js
  // Accounts
  loadAccounts: () => ipcRenderer.invoke('accounts:load'),
  saveAccounts: (accounts, active) => ipcRenderer.invoke('accounts:save', { accounts, active }),
```

- [ ] **Step 3: Import accounts at startup in `main.js`**

In `src-electron/main.js`, in `onBackendReady()`, import accounts before creating the window. Modify:

```js
function onBackendReady() {
  backendReady = true;
  importAccounts();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.loadURL(uiUrl());
  }
}

// Load saved accounts from settings.json and push them into the backend.
function importAccounts() {
  const { loadSettings } = require('./downloads');
  const accounts = (loadSettings().accounts || []).filter(
    (a) => a && a.server && a.username && a.password
  );
  const body = JSON.stringify({ accounts });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: backendPort,
      path: '/api/auth/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: backendToken ? `Bearer ${backendToken}` : '',
      },
    },
    (res) => res.resume()
  );
  req.on('error', (e) => console.error('[import-accounts]', e.message));
  req.write(body);
  req.end();
}
```

Note: `http` is already imported at the top of `main.js`.

- [ ] **Step 4: Syntax check**

Run: `node --check src-electron/main.js; node --check src-electron/preload.js; node --check src-electron/downloads.js`
Expected: no errors, exit 0 each.

- [ ] **Step 5: Commit**

```bash
git add src-electron/downloads.js src-electron/preload.js src-electron/main.js
git commit -m "feat: persist accounts in settings and import at startup"
```

---

### Task 3: API client — switch/remove/login without remember

**Files:**
- Modify: `src-ui/api.js`

**Interfaces:**
- Produces:
  - `api.switchAccount(server, username)` → `POST /api/auth/switch`, returns `AccountState`.
  - `api.removeAccount(server, username)` → `DELETE /api/auth/account`, returns `AccountState`.
  - `api.login(creds)` — drops `remember`.
  - `api.logout()`, `api.authStatus()` — return new `AccountState`.

- [ ] **Step 1: Update `api.js`**

In `src-ui/api.js`:

Replace `login` with (remove `remember` field, keep the call site compatible):

```js
  login(creds) {
    return request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
  },
```

Add after `logout()`:

```js
  switchAccount(server, username) {
    return request('/api/auth/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, username }),
    });
  },
  removeAccount(server, username) {
    return request('/api/auth/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, username }),
    });
  },
```

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/api.js
git commit -m "feat: add switchAccount/removeAccount to api client"
```

---

### Task 4: Frontend — AppContext account handling

**Files:**
- Modify: `src-ui/context/AppContext.jsx`

**Interfaces:**
- Consumes: `api.switchAccount`, `api.removeAccount`, `window.nextcloud.saveAccounts`.
- Produces on context:
  - `auth` shape: `{ logged_in, server, username, accounts: [{server, username}], active: {server, username} | null }`.
  - `login(creds)`, `logout()`, `switchAccount(server, username)`, `persistAccounts()`.

- [ ] **Step 1: Update login/logout and add switchAccount + persistence**

In `src-ui/context/AppContext.jsx`:

Replace the `login` callback:

```js
  const login = useCallback(async (creds) => {
    const data = await api.login(creds);
    setAuth(data);
    setCurrentPath('/');
    invalidateCache('/');
    loadFiles('/');
    if (window.nextcloud && window.nextcloud.saveAccounts) {
      window.nextcloud.saveAccounts(data.accounts, data.active).catch(() => {});
    }
  }, [invalidateCache, loadFiles]);
```

Replace the `logout` callback:

```js
  const logout = useCallback(async () => {
    try {
      const data = await api.logout();
      setAuth(data);
      if (data.accounts && data.accounts.length > 0) {
        setCurrentPath('/');
        invalidateCache('/');
        loadFiles('/');
      } else {
        setFiles([]);
        setSelected(new Set());
        setOperations([]);
      }
      if (window.nextcloud && window.nextcloud.saveAccounts) {
        window.nextcloud.saveAccounts(data.accounts, data.active).catch(() => {});
      }
    } catch {
      setAuth({ logged_in: false, accounts: [], active: null });
    }
  }, [invalidateCache, loadFiles]);
```

Add after `logout`:

```js
  const switchAccount = useCallback(
    async (server, username) => {
      const data = await api.switchAccount(server, username);
      setAuth(data);
      setCurrentPath('/');
      setSelected(new Set());
      invalidateCache('/');
      loadFiles('/');
      if (window.nextcloud && window.nextcloud.saveAccounts) {
        window.nextcloud.saveAccounts(data.accounts, data.active).catch(() => {});
      }
    },
    [invalidateCache, loadFiles]
  );

  const removeAccount = useCallback(
    async (server, username) => {
      const data = await api.removeAccount(server, username);
      setAuth(data);
      if (data.logged_in) {
        setCurrentPath('/');
        invalidateCache('/');
        loadFiles('/');
      } else {
        setFiles([]);
        setSelected(new Set());
        setOperations([]);
      }
      if (window.nextcloud && window.nextcloud.saveAccounts) {
        window.nextcloud.saveAccounts(data.accounts, data.active).catch(() => {});
      }
    },
    [invalidateCache, loadFiles]
  );
```

Add `switchAccount` and `removeAccount` to the context `value` object and its dependency array.

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/context/AppContext.jsx
git commit -m "feat: account switching and persistence in app context"
```

---

### Task 5: i18n keys for accounts

**Files:**
- Modify: `src-ui/i18n.jsx`

**Interfaces:**
- Produces keys (EN/RU): `accounts.add`, `accounts.addAccount`, `accounts.logout`, `accounts.add`, `accounts.cancel`, `accounts.serverUrl`, `accounts.username`, `accounts.password`, `accounts.adding`, `accounts.switchHint`.

- [ ] **Step 1: Add keys to both dictionaries**

In `src-ui/i18n.jsx`, in the `en` dictionary add:

```js
    'accounts.add': 'Add account',
    'accounts.logout': 'Log out',
    'accounts.serverUrl': 'Server URL',
    'accounts.username': 'Username',
    'accounts.password': 'Password',
    'accounts.adding': 'Adding…',
    'accounts.switchHint': 'Switch account',
    'accounts.cancel': 'Cancel',
    'accounts.empty': 'No accounts',
```

In the `ru` dictionary add:

```js
    'accounts.add': 'Добавить аккаунт',
    'accounts.logout': 'Выйти',
    'accounts.serverUrl': 'Адрес сервера',
    'accounts.username': 'Имя пользователя',
    'accounts.password': 'Пароль',
    'accounts.adding': 'Добавление…',
    'accounts.switchHint': 'Переключить аккаунт',
    'accounts.cancel': 'Отмена',
    'accounts.empty': 'Аккаунтов нет',
```

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/i18n.jsx
git commit -m "feat: i18n keys for account management"
```

---

### Task 6: AddAccountModal + AccountMenu components

**Files:**
- Create: `src-ui/components/AddAccountModal.jsx`
- Create: `src-ui/components/AccountMenu.jsx`

**Interfaces:**
- Consumes: `useApp()` (`login`, `switchAccount`, `auth`, `logout`), `useI18n()` (`t`), `translateError`.
- Produces: `<AddAccountModal onClose={...} />`, `<AccountMenu />`.

- [ ] **Step 1: Create `AddAccountModal.jsx`**

```jsx
import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function AddAccountModal({ onClose }) {
  const { login } = useApp();
  const { t } = useI18n();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login({ server, username, password });
      onClose();
    } catch (err) {
      setError(translateError(t, err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[420px] rounded-xl border border-nc-border bg-nc-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-nc-text">{t('accounts.add')}</h2>

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.serverUrl')}</label>
        <input
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.com"
          className={`mb-4 ${inputCls}`}
          required
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.username')}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className={`mb-4 ${inputCls}`}
          required
          autoComplete="username"
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className={`mb-4 ${inputCls}`}
          required
          autoComplete="current-password"
        />

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            {t('accounts.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
          >
            {loading ? t('accounts.adding') : t('accounts.add')}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Create `AccountMenu.jsx`**

```jsx
import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
import AddAccountModal from './AddAccountModal';

const MENU_ITEM =
  'w-full px-4 py-2 text-left text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function AccountMenu() {
  const { auth, switchAccount, logout } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const accounts = auth?.accounts || [];
  const active = auth?.active || null;
  const label = auth?.username || '';

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 rounded-lg border border-nc-border bg-nc-bg px-3 py-1.5 text-sm hover:bg-nc-hover"
        onClick={() => setOpen((v) => !v)}
        title={t('accounts.switchHint')}
      >
        👤 {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-nc-border bg-nc-panel py-1 shadow-2xl">
          {accounts.length === 0 && (
            <div className="px-4 py-2 text-sm text-nc-muted">{t('accounts.empty')}</div>
          )}
          {accounts.map((acc) => {
            const isActive =
              active && active.server === acc.server && active.username === acc.username;
            return (
              <button
                key={`${acc.server}|${acc.username}`}
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) switchAccount(acc.server, acc.username);
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {acc.username}
                    <span className="block truncate text-xs text-nc-muted">{acc.server}</span>
                  </span>
                  {isActive && <span className="text-nc-accent">✔</span>}
                </span>
              </button>
            );
          })}
          <div className="my-1 border-t border-nc-border" />
          <button className={MENU_ITEM} onClick={() => { setOpen(false); setShowAdd(true); }}>
            ➕ {t('accounts.add')}
          </button>
          <button
            className={`${MENU_ITEM} text-red-300 hover:bg-red-500/20`}
            onClick={() => { setOpen(false); logout(); }}
          >
            🚪 {t('accounts.logout')}
          </button>
        </div>
      )}

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src-ui/components/AddAccountModal.jsx src-ui/components/AccountMenu.jsx
git commit -m "feat: add account modal and toolbar account menu"
```

---

### Task 7: Wire AccountMenu into Toolbar; LoginForm without remember

**Files:**
- Modify: `src-ui/components/Toolbar.jsx`
- Modify: `src-ui/components/LoginForm.jsx`

**Interfaces:**
- Consumes: `<AccountMenu />` from Task 6.

- [ ] **Step 1: Add AccountMenu to Toolbar**

In `src-ui/components/Toolbar.jsx`:
1. Add import: `import AccountMenu from './AccountMenu';`
2. Add `<AccountMenu />` right before the settings gear button:

```jsx
      <AccountMenu />
      <button className={BTN} onClick={() => setShowSettings(true)} title={t('toolbar.settingsTitle')}>
        ⚙️
      </button>
```

- [ ] **Step 2: Remove Remember-me from LoginForm**

In `src-ui/components/LoginForm.jsx`:
1. Remove the `remember` state and its usage.
2. Remove the checkbox block and the `login({ ..., remember })` field:

```jsx
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login({ server, username, password });
      if (server) localStorage.setItem(STORAGE_KEY, server);
    } catch (err) {
      setError(translateError(t, err));
    } finally {
      setLoading(false);
    }
  };
```

Remove `const [remember, setRemember] = useState(true);` and the entire `<label>` block containing the checkbox.

- [ ] **Step 3: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src-ui/components/Toolbar.jsx src-ui/components/LoginForm.jsx
git commit -m "feat: wire account menu into toolbar, drop remember-me flag"
```

---

### Task 8: Final build + smoke verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full UI build**

Run: `npm run build:ui`
Expected: succeeds (476 modules).

- [ ] **Step 2: Full Rust build**

Run: `cargo build --release --manifest-path src-rust/Cargo.toml`
Expected: `Finished` without errors.

- [ ] **Step 3: Syntax check JS**

Run: `node --check src-electron/main.js; node --check src-electron/preload.js; node --check src-electron/downloads.js; node --check src-ui/api.js`
Expected: no errors.

- [ ] **Step 4: Smoke-run packaged dir (no release)**

Run: `npx electron-builder --dir` then launch `dist\win-unpacked\NextCloud Client.exe` for a few seconds; verify no main-process crash in stderr.

- [ ] **Step 5: Confirm no release artifacts**

Verify `git tag` has no new tag and `package.json` version is unchanged.