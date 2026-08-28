# EN/RU Language Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an English/Russian language switcher to the NextCloud client UI, persisted in `settings.json`, with translated interface strings and backend error codes.

**Architecture:** Lightweight custom i18n via a new `src-ui/i18n.jsxx` module (dictionaries + React context + `t()`/`useI18n()`). Language state lives in `AppContext`, persisted through the existing `settings:get`/`settings:update` IPC (`downloads.js`). Rust `AppError` gains a stable `error_code` string surfaced in JSON responses; the frontend maps codes to translations.

**Tech Stack:** React 18 (no i18n library added), Rust/axum, electron-builder.

## Global Constraints

- No new npm dependencies.
- Default language is `'en'`; stored value is `'en'` or `'ru'`.
- Translations live in `src-ui/i18n.jsxx`; UI components call `t('key', vars)` only.
- Backend error codes: `not_authenticated`, `bad_request`, `nextcloud`, `xml`, `network`, `internal` (one string per `AppError` variant).
- Do NOT make a release or bump the app version in this task.
- Rust must still compile (`cargo build`), UI must build (`vite build`).
- The server-provided `message` in NextCloud errors stays as-is (detail).

---

### Task 1: Create the i18n module with dictionaries

**Files:**
- Create: `src-ui/i18n.jsxx`

**Interfaces:**
- Consumes: nothing.
- Produces: `I18nProvider({ language, children })`, `useI18n()`, `translateError(t, err)`. Dictionary keys used by every later task — list below is authoritative.

- [ ] **Step 1: Create `src-ui/i18n.jsx` with full EN/RU dictionaries**

Key set (used by later tasks):

```
language, login.subtitle, login.serverUrl, login.username, login.password,
login.rememberMe, login.connecting, login.connect,
toolbar.upload, toolbar.uploadTitle, toolbar.newFolder, toolbar.download,
toolbar.downloadTitle, toolbar.delete, toolbar.deleteTitle, toolbar.refreshTitle,
toolbar.settingsTitle, toolbar.folderName, toolbar.deleteConfirm, toolbar.selected,
folders.title, folders.root,
filelist.name, filelist.size, filelist.modified, filelist.loading, filelist.empty,
menu.download, menu.preview, menu.rename, menu.delete, menu.refresh, menu.save,
menu.deleteConfirm,
progress.operation, progress.failed, progress.retry, progress.done,
settings.title, settings.language, settings.uploadLimit, settings.downloadLimit,
settings.downloadDir, settings.browse, settings.askSave, settings.checking,
settings.upToDate, settings.available, settings.downloading, settings.checkError,
settings.checkUpdates, settings.cancel, settings.save, settings.saving,
preview.title, preview.prev, preview.next, preview.zoomHint, preview.download,
preview.close, preview.notFound, preview.loading, preview.loadError,
preview.docUnsupported, preview.docDownload, preview.unavailable, preview.footer,
app.dropToUpload, breadcrumb.rootTitle,
errors.not_authenticated, errors.bad_request, errors.network, errors.xml,
errors.internal, errors.nextcloud_401, errors.nextcloud_403, errors.nextcloud_404,
errors.nextcloud_405, errors.nextcloud_409, errors.nextcloud_412,
errors.nextcloud_423, errors.nextcloud_507
```

```js
import React, { createContext, useContext, useMemo } from 'react';

const messages = {
  en: {
    language: 'Language',
    'login.subtitle': 'Connect to your cloud storage',
    'login.serverUrl': 'Server URL',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.rememberMe': 'Remember me',
    'login.connecting': 'Connecting…',
    'login.connect': 'Connect',
    'toolbar.upload': 'Upload',
    'toolbar.uploadTitle': 'Upload (Ctrl+U)',
    'toolbar.newFolder': 'New Folder',
    'toolbar.download': 'Download',
    'toolbar.downloadTitle': 'Download',
    'toolbar.delete': 'Delete',
    'toolbar.deleteTitle': 'Delete (Del)',
    'toolbar.refreshTitle': 'Refresh (F5)',
    'toolbar.settingsTitle': 'Settings',
    'toolbar.folderName': 'Folder name:',
    'toolbar.deleteConfirm': 'Delete {count} item(s)?\n\n{names}',
    'toolbar.selected': '{count} selected',
    'folders.title': 'Folders',
    'folders.root': 'Root',
    'filelist.name': 'Name',
    'filelist.size': 'Size',
    'filelist.modified': 'Modified',
    'filelist.loading': 'Loading…',
    'filelist.empty': 'This folder is empty',
    'menu.download': 'Download',
    'menu.preview': 'Preview',
    'menu.rename': 'Rename',
    'menu.delete': 'Delete',
    'menu.refresh': 'Refresh',
    'menu.save': 'Save',
    'menu.deleteConfirm': 'Delete "{name}"?',
    'progress.operation': 'Operation',
    'progress.failed': 'Failed',
    'progress.retry': 'Retry',
    'progress.done': 'Done',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.uploadLimit': 'Upload speed limit (KB/s, 0 = unlimited)',
    'settings.downloadLimit': 'Download speed limit (KB/s, 0 = unlimited)',
    'settings.downloadDir': 'Default download location',
    'settings.browse': 'Browse…',
    'settings.askSave': 'Ask where to save each download',
    'settings.checking': 'Checking for updates…',
    'settings.upToDate': "You're up to date.",
    'settings.available': 'Update available',
    'settings.downloading': 'Downloading update…',
    'settings.checkError': 'Could not check for updates.',
    'settings.checkUpdates': 'Check for updates',
    'settings.cancel': 'Cancel',
    'settings.save': 'Save',
    'settings.saving': 'Saving…',
    'preview.title': 'Preview',
    'preview.prev': 'Previous (←)',
    'preview.next': 'Next (→)',
    'preview.zoomHint': 'Ctrl+wheel — zoom',
    'preview.download': 'Download',
    'preview.close': 'Close',
    'preview.notFound': 'File not found',
    'preview.loading': 'Loading…',
    'preview.loadError': 'Failed to load: {error}',
    'preview.docUnsupported':
      'Preview of legacy .doc files is not supported. Download the file and open it in Word.',
    'preview.docDownload': 'Download',
    'preview.unavailable': 'Preview is not available for this file type.',
    'preview.footer': '{index} / {total} · wheel to switch, Ctrl+wheel to zoom',
    'app.dropToUpload': 'Drop to upload',
    'breadcrumb.rootTitle': 'Cloud root',
    'errors.not_authenticated': 'Not authenticated. Please log in first.',
    'errors.bad_request': 'Invalid request.',
    'errors.network': 'Network error.',
    'errors.xml': 'Failed to parse server response.',
    'errors.internal': 'Internal server error.',
    'errors.nextcloud_401': 'Invalid credentials or insufficient permissions.',
    'errors.nextcloud_403': 'Access denied by the server.',
    'errors.nextcloud_404': 'File or folder not found.',
    'errors.nextcloud_405': 'Operation not supported by the server.',
    'errors.nextcloud_409': 'Conflict: a file or folder with this name already exists.',
    'errors.nextcloud_412': 'Precondition failed.',
    'errors.nextcloud_423': 'The resource is locked.',
    'errors.nextcloud_507': 'The server is out of storage space.',
  },
  ru: {
    language: 'Язык',
    'login.subtitle': 'Подключитесь к вашему облачному хранилищу',
    'login.serverUrl': 'Адрес сервера',
    'login.username': 'Имя пользователя',
    'login.password': 'Пароль',
    'login.rememberMe': 'Запомнить меня',
    'login.connecting': 'Подключение…',
    'login.connect': 'Войти',
    'toolbar.upload': 'Загрузить',
    'toolbar.uploadTitle': 'Загрузить (Ctrl+U)',
    'toolbar.newFolder': 'Новая папка',
    'toolbar.download': 'Скачать',
    'toolbar.downloadTitle': 'Скачать',
    'toolbar.delete': 'Удалить',
    'toolbar.deleteTitle': 'Удалить (Del)',
    'toolbar.refreshTitle': 'Обновить (F5)',
    'toolbar.settingsTitle': 'Настройки',
    'toolbar.folderName': 'Имя папки:',
    'toolbar.deleteConfirm': 'Удалить {count} элемент(ов)?\n\n{names}',
    'toolbar.selected': 'Выбрано: {count}',
    'folders.title': 'Папки',
    'folders.root': 'Корень',
    'filelist.name': 'Имя',
    'filelist.size': 'Размер',
    'filelist.modified': 'Изменён',
    'filelist.loading': 'Загрузка…',
    'filelist.empty': 'Эта папка пуста',
    'menu.download': 'Скачать',
    'menu.preview': 'Просмотр',
    'menu.rename': 'Переименовать',
    'menu.delete': 'Удалить',
    'menu.refresh': 'Обновить',
    'menu.save': 'Сохранить',
    'menu.deleteConfirm': 'Удалить «{name}»?',
    'progress.operation': 'Операция',
    'progress.failed': 'Ошибка',
    'progress.retry': 'Повторить',
    'progress.done': 'Готово',
    'settings.title': 'Настройки',
    'settings.language': 'Язык',
    'settings.uploadLimit': 'Лимит скорости загрузки (КБ/с, 0 — без ограничения)',
    'settings.downloadLimit': 'Лимит скорости скачивания (КБ/с, 0 — без ограничения)',
    'settings.downloadDir': 'Папка для скачивания по умолчанию',
    'settings.browse': 'Обзор…',
    'settings.askSave': 'Спрашивать, куда сохранять каждый файл',
    'settings.checking': 'Проверка обновлений…',
    'settings.upToDate': 'У вас актуальная версия.',
    'settings.available': 'Доступно обновление',
    'settings.downloading': 'Загрузка обновления…',
    'settings.checkError': 'Не удалось проверить обновления.',
    'settings.checkUpdates': 'Проверить обновления',
    'settings.cancel': 'Отмена',
    'settings.save': 'Сохранить',
    'settings.saving': 'Сохранение…',
    'preview.title': 'Просмотр',
    'preview.prev': 'Предыдущий (←)',
    'preview.next': 'Следующий (→)',
    'preview.zoomHint': 'Ctrl+колесо — масштаб',
    'preview.download': 'Скачать',
    'preview.close': 'Закрыть',
    'preview.notFound': 'Файл не найден',
    'preview.loading': 'Загрузка…',
    'preview.loadError': 'Не удалось загрузить: {error}',
    'preview.docUnsupported':
      'Предпросмотр старых .doc файлов не поддерживается. Скачайте файл и откройте его в Word.',
    'preview.docDownload': 'Скачать',
    'preview.unavailable': 'Предпросмотр для этого типа недоступен.',
    'preview.footer': '{index} / {total} · колесо — переключение, Ctrl+колесо — масштаб',
    'app.dropToUpload': 'Перетащите файлы, чтобы загрузить',
    'breadcrumb.rootTitle': 'Корень облака',
    'errors.not_authenticated': 'Не авторизован. Пожалуйста, войдите.',
    'errors.bad_request': 'Некорректный запрос.',
    'errors.network': 'Сетевая ошибка.',
    'errors.xml': 'Не удалось разобрать ответ сервера.',
    'errors.internal': 'Внутренняя ошибка сервера.',
    'errors.nextcloud_401': 'Неверные учётные данные или недостаточно прав.',
    'errors.nextcloud_403': 'Сервер запретил доступ.',
    'errors.nextcloud_404': 'Файл или папка не найдены.',
    'errors.nextcloud_405': 'Операция не поддерживается сервером.',
    'errors.nextcloud_409': 'Конфликт: файл или папка с таким именем уже существует.',
    'errors.nextcloud_412': 'Не выполнено предусловие.',
    'errors.nextcloud_423': 'Ресурс заблокирован.',
    'errors.nextcloud_507': 'На сервере закончилось место.',
  },
};

const I18nContext = createContext({ language: 'en', t: (k) => k });

export function I18nProvider({ language, children }) {
  const value = useMemo(() => {
    const dict = messages[language] || messages.en;
    const t = (key, vars) => {
      let s = dict[key] ?? messages.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.split(`{${k}}`).join(v);
        }
      }
      return s;
    };
    return { language, t };
  }, [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

// Map an error object ({ code, status, message }) to a translated string.
// Falls back to the raw message when the code is unknown.
export function translateError(t, err) {
  if (!err) return '';
  if (err.code === 'nextcloud' && err.status) {
    const key = `errors.nextcloud_${err.status}`;
    const s = t(key);
    if (s !== key) return s;
    return err.message || t('errors.nextcloud_405');
  }
  if (err.code) {
    const key = `errors.${err.code}`;
    const s = t(key);
    if (s !== key) return s;
  }
  return err.message || '';
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src-ui/i18n.jsx`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src-ui/i18n.jsx
git commit -m "feat: add i18n module with EN/RU dictionaries"
```

---

### Task 2: Wire language state into AppContext and settings persistence

**Files:**
- Modify: `src-electron/downloads.js:38-45` (default settings)
- Modify: `src-ui/context/AppContext.jsx` (language state, provider, setLanguage)

**Interfaces:**
- Consumes: `I18nProvider`, `useI18n` from Task 1.
- Produces: `language` and `setLanguage(lang)` exposed on the app context; wraps children in `<I18nProvider language={language}>`; persists via `updateSettings({ language })`.

- [ ] **Step 1: Add `language: 'en'` to default settings**

In `src-electron/downloads.js`, change `defaultSettings()` to include `language: 'en'`:

```js
function defaultSettings() {
  return {
    downloadDir: '',
    askDownloadLocation: true,
    uploadSpeedLimit: 0,
    downloadSpeedLimit: 0,
    language: 'en',
  };
}
```

- [ ] **Step 2: Add language state and provider in AppContext**

In `src-ui/context/AppContext.jsx`:

1. Import `I18nProvider` from `../i18n`.
2. Add state: `const [language, setLanguageState] = useState('en');`
3. In the settings-loading effect (lines ~66-73), initialize language from settings:
```js
useEffect(() => {
  if (window.nextcloud && window.nextcloud.getSettings) {
    window.nextcloud
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (s.language === 'en' || s.language === 'ru') setLanguageState(s.language);
      })
      .catch(() => {});
  }
}, []);
```
4. Add `setLanguage` callback:
```js
const setLanguage = useCallback(async (lang) => {
  if (lang !== 'en' && lang !== 'ru') return;
  setLanguageState(lang);
  if (document.documentElement) document.documentElement.lang = lang;
  if (window.nextcloud && window.nextcloud.updateSettings) {
    await window.nextcloud.updateSettings({ language: lang }).catch(() => {});
  }
}, []);
```
5. Add `language` and `setLanguage` to the `useMemo` value and its dependency array.
6. Wrap the returned JSX:
```js
return (
  <AppContext.Provider value={value}>
    <I18nProvider language={language}>{children}</I18nProvider>
  </AppContext.Provider>
);
```

- [ ] **Step 3: Verify build**

Run: `npm run build:ui`
Expected: vite build succeeds (475 modules transformed).

- [ ] **Step 4: Commit**

```bash
git add src-electron/downloads.js src-ui/context/AppContext.jsx
git commit -m "feat: persist language in settings and expose via context"
```

---

### Task 3: Language switcher on LoginForm + translate it

**Files:**
- Modify: `src-ui/components/LoginForm.jsx`

**Interfaces:**
- Consumes: `useI18n()` (Task 1), `useApp()`.
- Produces: nothing new.

- [ ] **Step 1: Translate LoginForm and add language select**

Full replacement of `src-ui/components/LoginForm.jsx`:

```jsx
import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';

const STORAGE_KEY = 'nextcloud_client_last_server';

export default function LoginForm() {
  const { login, language, setLanguage } = useApp();
  const { t } = useI18n();
  const [server, setServer] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login({ server, username, password, remember });
      if (remember) {
        localStorage.setItem(STORAGE_KEY, server);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      setError(translateError(t, err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-nc-bg">
      <form
        onSubmit={handleSubmit}
        className="relative w-96 rounded-xl border border-nc-border bg-nc-panel p-8 shadow-2xl"
      >
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="absolute right-4 top-4 rounded border border-nc-border bg-nc-bg px-2 py-1 text-xs text-nc-muted"
          aria-label={t('language')}
        >
          <option value="en">English</option>
          <option value="ru">Русский</option>
        </select>

        <div className="mb-6 text-center">
          <div className="text-3xl">☁️</div>
          <h1 className="mt-2 text-xl font-semibold text-nc-text">NextCloud Client</h1>
          <p className="text-sm text-nc-muted">{t('login.subtitle')}</p>
        </div>

        <label className="mb-1 block text-sm text-nc-muted">{t('login.serverUrl')}</label>
        <input
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.com"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('login.username')}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
          autoComplete="username"
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('login.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
          autoComplete="current-password"
        />

        <label className="mb-4 flex items-center gap-2 text-sm text-nc-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-nc-accent"
          />
          {t('login.rememberMe')}
        </label>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-nc-accent px-4 py-2 font-medium text-white hover:bg-nc-accenthover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {loading ? t('login.connecting') : t('login.connect')}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/LoginForm.jsx
git commit -m "feat: translate login form and add language switcher"
```

---

### Task 4: Translate Toolbar

**Files:**
- Modify: `src-ui/components/Toolbar.jsx`

**Interfaces:**
- Consumes: `useI18n()`, `translateError(t, err)`, `useApp()`.

- [ ] **Step 1: Translate Toolbar**

Replace string literals with `t()` and `translateError`. Key edits:
- `useI18n` import and `const { t } = useI18n();`
- `window.prompt('Folder name:')` → `window.prompt(t('toolbar.folderName'))`
- confirm: `window.confirm(t('toolbar.deleteConfirm', { count: names.length, names: names.join('\n') }))`
- alerts: `window.alert(translateError(t, e))`
- buttons: `⬆ {t('toolbar.upload')}`, title attrs `t('toolbar.uploadTitle')` etc.
- `📁 {t('toolbar.newFolder')}`, `⬇ {t('toolbar.download')}`, `🗑 {t('toolbar.delete')}`
- settings gear title → `t('toolbar.settingsTitle')`
- selected span: `t('toolbar.selected', { count: selected.size })`

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/Toolbar.jsx
git commit -m "feat: translate toolbar"
```

---

### Task 5: Translate FileExplorer

**Files:**
- Modify: `src-ui/components/FileExplorer.jsx`

- [ ] **Step 1: Translate FileExplorer**

Add `useI18n`, `const { t } = useI18n();` in `FileExplorer` component; replace `Folders` → `{t('folders.title')}` and `Root` → `{t('folders.root')}`.

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/FileExplorer.jsx
git commit -m "feat: translate file explorer"
```

---

### Task 6: Translate FileList

**Files:**
- Modify: `src-ui/components/FileList.jsx`

- [ ] **Step 1: Translate FileList (incl. date locale)**

Add `useI18n`. `formatDate` becomes a closure using `language`:
```js
const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
};
```
Replace `Name`/`Size`/`Modified` headers with `t('filelist.name')` etc., `Loading…` → `t('filelist.loading')`, `This folder is empty` → `t('filelist.empty')`. Render error via `translateError(t, error)` (error is a string here — wrap: `translateError(t, { message: error })` or `error` directly if it is already local; keep it simple: show `error` as-is).

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/FileList.jsx
git commit -m "feat: translate file list"
```

---

### Task 7: Translate ContextMenu

**Files:**
- Modify: `src-ui/components/ContextMenu.jsx`

- [ ] **Step 1: Translate ContextMenu**

Add `useI18n`, replace:
- confirm: `window.confirm(t('menu.deleteConfirm', { name: item.name }))`
- alerts: `window.alert(translateError(t, e))`
- buttons: `⬇ {t('menu.download')}`, `👁 {t('menu.preview')}`, `✏️ {t('menu.rename')}`, `🗑 {t('menu.delete')}`, `🔄 {t('menu.refresh')}`, `{t('menu.save')}`

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/ContextMenu.jsx
git commit -m "feat: translate context menu"
```

---

### Task 8: Translate ProgressPanel

**Files:**
- Modify: `src-ui/components/ProgressPanel.jsx`

- [ ] **Step 1: Translate ProgressPanel**

Add `useI18n`; `Operation` → `t('progress.operation')`, `Failed` → `t('progress.failed')`, `Retry` → `t('progress.retry')`, `Done` → `t('progress.done')`.

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/ProgressPanel.jsx
git commit -m "feat: translate progress panel"
```

---

### Task 9: Translate SettingsModal + add language select

**Files:**
- Modify: `src-ui/components/SettingsModal.jsx`

**Interfaces:**
- Consumes: `useI18n()`, `useApp()` (`language`, `setLanguage`).

- [ ] **Step 1: Translate SettingsModal and add language select**

Add `const { t } = useI18n();` and destructure `language, setLanguage` from `useApp()`. Add a language select block at the top of the settings body (before upload limit):
```jsx
<div>
  <label className="mb-1 block text-sm text-nc-muted">{t('settings.language')}</label>
  <select
    value={language}
    onChange={(e) => setLanguage(e.target.value)}
    className={inputCls}
  >
    <option value="en">English</option>
    <option value="ru">Русский</option>
  </select>
</div>
```
Replace all remaining literal strings with `t('settings.*')` keys. The update-status spans use `t('settings.checking')`, `t('settings.upToDate')`, `t('settings.available')`, `t('settings.downloading')`, `t('settings.checkError')`, and buttons `t('settings.checkUpdates')`, `t('settings.cancel')`, `t('settings.save')`/`t('settings.saving')`.

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/SettingsModal.jsx
git commit -m "feat: translate settings modal and add language select"
```

---

### Task 10: Translate Breadcrumb + App

**Files:**
- Modify: `src-ui/components/Breadcrumb.jsx`
- Modify: `src-ui/App.jsx`

- [ ] **Step 1: Translate Breadcrumb**

Add `useI18n`; `title="Cloud root"` → `title={t('breadcrumb.rootTitle')}`.

- [ ] **Step 2: Translate App.jsx**

Add `useI18n` inside `MainScreen`; `Drop to upload` → `{t('app.dropToUpload')}`.

- [ ] **Step 3: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src-ui/components/Breadcrumb.jsx src-ui/App.jsx
git commit -m "feat: translate breadcrumb and app shell"
```

---

### Task 11: Translate PreviewPanel

**Files:**
- Modify: `src-ui/components/PreviewPanel.jsx`

- [ ] **Step 1: Translate PreviewPanel**

Add `useI18n` in the component (a hook at top level). Replace all Russian/English literals:
- `'<p>Лист пуст</p>'` (spreadsheet empty) → use `t('preview.emptySheet')` with `'<p>Лист пуст</p>'`/`'<p>Empty sheet</p>'` — add these two keys to `i18n.js` (`preview.emptySheet`).
- error text: `Ошибка загрузки: ...` → `t('preview.loadError', { error: textError })`
- `Загрузка…` → `t('preview.loading')`
- `.doc` unsupported block → `t('preview.docUnsupported')`, button → `t('preview.docDownload')`
- default → `t('preview.unavailable')`
- `Предпросмотр` header → `t('preview.title')`
- `✕ Закрыть` → `✕ {t('preview.close')}`
- `Файл не найден` → `t('preview.notFound')`
- prev/next titles → `t('preview.prev')`, `t('preview.next')`
- zoom hint `Ctrl+колесо — масштаб` → `t('preview.zoomHint')`
- download button `⬇ Скачать` → `⬇ {t('preview.download')}`
- footer → `t('preview.footer', { index: index + 1, total: sameKindFiles.length })`

Also add the `preview.emptySheet` key to both dictionaries in `src-ui/i18n.jsx` (EN: `'Empty sheet'`, RU: `'Лист пуст'`).

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/PreviewPanel.jsx src-ui/i18n.jsx
git commit -m "feat: translate preview panel"
```

---

### Task 12: Backend error_code + api.js error mapping

**Files:**
- Modify: `src-rust/src/models.rs`
- Modify: `src-ui/api.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: backend JSON now includes `"error_code"`; `api.js` errors carry `.code` and `.status`.

- [ ] **Step 1: Add `code()` to AppError and include in response**

In `src-rust/src/models.rs`, inside the existing `impl AppError` block add:

```rust
    /// Stable machine-readable code used by the frontend to translate errors.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotAuthenticated => "not_authenticated",
            AppError::BadRequest(_) => "bad_request",
            AppError::NextCloud { .. } => "nextcloud",
            AppError::Xml(_) => "xml",
            AppError::Network(_) => "network",
            AppError::Internal(_) => "internal",
        }
    }
```

Update `IntoResponse for AppError`:

```rust
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Json(json!({
            "success": false,
            "error": self.to_string(),
            "error_code": self.code(),
        }));
        (self.status(), body).into_response()
    }
}
```

- [ ] **Step 2: Verify Rust compiles**

Run: `cargo build --manifest-path src-rust/Cargo.toml`
Expected: `Finished` without errors.

- [ ] **Step 3: Carry code/status through api.js**

In `src-ui/api.js`, `request()` currently throws `new Error(body.error || ...)`. Change to attach metadata:

```js
  if (!res.ok || body.success === false) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.code = body.error_code || null;
    err.status = res.status;
    throw err;
  }
  return body.data;
```

- [ ] **Step 4: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-rust/src/models.rs src-ui/api.js
git commit -m "feat: expose stable backend error codes for translation"
```

---

### Task 13: Final build verification + smoke test

**Files:**
- None (verification only).

- [ ] **Step 1: Full UI build**

Run: `npm run build:ui`
Expected: succeeds with 475 modules transformed.

- [ ] **Step 2: Full Rust build**

Run: `cargo build --release --manifest-path src-rust/Cargo.toml`
Expected: `Finished` without errors.

- [ ] **Step 3: Syntax-check all modified JS**

Run: `node --check src-ui/i18n.jsx; node --check src-ui/api.js; node --check src-electron/downloads.js`
Expected: no errors.

- [ ] **Step 4: Confirm no release step was run**

Verify git log has no version bump and no tag created for this work.