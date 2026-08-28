# Дизайн: мультиаккаунты (как в Telegram)

Дата: 2026-08-28. Статус: утверждён.

## Цель

Дать возможность хранить несколько аккаунтов NextCloud (разные пользователи на одном сервере и/или разные серверы) и мгновенно переключаться между ними из главного окна, как в Telegram. Аккаунты сохраняются на диск и переживают перезапуск.

## Решения (согласованы)

- **Хранение:** список аккаунтов (server, username, password) в `settings.json` (userData), рядом с остальными настройками.
- **Модель бэкенда:** Rust хранит `Vec<AuthState>` + активный индекс в памяти. Все WebDAV-запросы используют активный аккаунт.
- **Добавление:** отдельное модальное окно (не LoginForm) — `AddAccountModal`.
- **Пустое состояние:** если аккаунтов нет — экран входа (существующая LoginForm).
- **Переключатель:** кнопка-меню в правой части Toolbar с текущим логином; dropdown со списком аккаунтов, «Add account», «Log out».
- **Remember me:** флажок убирается, аккаунты всегда сохраняются на диск.
- **Log out:** удаляет аккаунт из списка; если он был последним — переход на экран входа.
- **Коммиты** делаются, **релиз/установщик не выпускается** в этой задаче.

## Архитектура

### 1. Бэкенд (Rust)

**`src-rust/src/server.rs` — `AppState`:**
- `pub auth: Arc<RwLock<Option<AuthState>>>` заменяется на:
  - `pub accounts: Arc<RwLock<Vec<AuthState>>>`
  - `pub active: Arc<std::sync::atomic::AtomicUsize>` — индекс активного аккаунта; `std::usize::MAX` при пустом списке или отсутствии активного.
- `AppState::new` инициализирует пустой список.

**`src-rust/src/auth.rs`:**
- `require_auth` — возвращает клон активного аккаунта; если список пуст или активный индекс вне диапазона → `AppError::NotAuthenticated`.
- `LoginRequest` — без поля `remember` (всегда сохраняем).
- `POST /api/auth/login`:
  - валидирует сервер/логин, проверяет соединение (`verify_auth`);
  - добавляет аккаунт в `accounts` с дедупом по (server, username): если существует — обновляет пароль;
  - устанавливает активный индекс на этот аккаунт;
  - возвращает `{ server, username, accounts: [...], active: {server, username} }`.
- `GET /api/auth/status`:
  - возвращает `{ logged_in, server, username, accounts: [{server, username}], active: {server, username} | null }`. Пароли НЕ возвращаются.
- `POST /api/auth/switch { server, username }`:
  - находит аккаунт по (server, username); если нет — `BadRequest`;
  - ставит активный индекс; возвращает данные активного.
- `DELETE /api/auth/account { server, username }`:
  - удаляет аккаунт из списка;
  - если удалён активный — активируется первый оставшийся (индекс 0), либо `std::usize::MAX` если список пуст;
  - возвращает обновлённое состояние.
- `POST /api/auth/import`:
  - принимает `{ accounts: [{server, username, password}] }`;
  - заменяет содержимое `accounts` (merge по (server, username), отсутствующие убираются), не трогая активный индекс (сбрасывает на 0);
  - используется Electron-ом при старте для передачи сохранённых учёток.
- `POST /api/auth/logout` — удаляет активный аккаунт из списка (как «Log out» в Telegram). Если список пуст — `logged_in: false`.

**Роутер (`server.rs`):**
- `POST /api/auth/switch`, `DELETE /api/auth/account`, `POST /api/auth/import` добавляются.

### 2. Electron main — персистентность

**`src-electron/downloads.js`:**
- `defaultSettings()` добавляет `accounts: []` (поле верхнего уровня).
- Новый IPC-хэндлер `accounts:save` — принимает `{ accounts, active }`, сохраняет в `settings.accounts` и записывает `settings.json`.
- Новый IPC-хэндлер `accounts:load` — возвращает `settings.accounts` (массив `{server, username, password}`).

**`src-electron/main.js`:**
- При старте, после `startBackend()` и готовности бэкенда (`onBackendReady`), загрузить `accounts:load` и вызвать `POST /api/auth/import`.
- Порядок: `backendReady` → import → создать окно (чтобы UI сразу видел аккаунты).

**`src-electron/preload.js`:**
- Экспонировать `saveAccounts(accounts, active)` → `ipcRenderer.invoke('accounts:save', ...)`.

### 3. API-клиент — `src-ui/api.js`

- `authStatus()` — уже есть, формат ответа расширяется: `accounts` (без паролей) + `active`.
- `switchAccount(server, username)` → `POST /api/auth/switch`.
- `removeAccount(server, username)` → `DELETE /api/auth/account`.
- `login(creds)` — без `remember`.
- `logout()` — прежний.

### 4. Фронтенд (React)

**`src-ui/context/AppContext.jsx`:**
- `auth` стейт: `{ logged_in, server, username, accounts: [...], active: {...} | null }`.
- `login(creds)` — вызывает `api.login`, обновляет `auth`, сбрасывает `currentPath` на `/`, инвалидирует кэш, грузит корень.
- `logout()` — вызывает `api.logout` (удаляет активный), обновляет `auth`; при пустом списке — `logged_in: false`.
- `switchAccount(server, username)` — `api.switchAccount`, сброс пути, инвалидация, перезагрузка корня.
- `removeAccount(server, username)` — для будущего использования (опционально).
- При каждом изменении аккаунтов — вызвать `window.nextcloud.saveAccounts(accounts, active)` для персистентности.
- `authLoading` остаётся.

**`src-ui/components/AccountMenu.jsx` (новый):**
- Кнопка `👤 {username}` в правой части Toolbar; клик открывает dropdown:
  - список аккаунтов (галочка у активного, клик = переключение);
  - разделитель;
  - «Add account» — открывает `AddAccountModal`;
  - «Log out» — `logout()`.
- Использует `useApp()` и `useI18n()`.

**`src-ui/components/AddAccountModal.jsx` (новый):**
- Модальное окно: поля Server URL / Username / Password (без «Remember me»), кнопки «Add»/«Cancel».
- После успешного входа — закрывается, аккаунт активен.
- Ошибки показываются через `translateError`.

**`src-ui/components/Toolbar.jsx`:**
- В правую часть добавить `<AccountMenu />` (рядом с gear-иконкой).

**`src-ui/components/LoginForm.jsx`:**
- Убрать чекбокс «Remember me» (всегда сохраняем).
- После входа аккаунт сохраняется (через login → saveAccounts в AppContext).
- Оставить язык-селект.

### 5. i18n — новые ключи

В `src-ui/i18n.jsx` добавить (EN/RU):
- `accounts.add`, `accounts.switch`, `accounts.logout`, `accounts.empty`, `accounts.title`, `accounts.addAccount`, `accounts.add`, `accounts.cancel`, `accounts.serverUrl`, `accounts.username`, `accounts.password`, `accounts.adding`.

### 6. Обработка ошибок и крайние случаи

- Переключение на несуществующий аккаунт → `BadRequest` («Account not found.»).
- Удаление активного → активируется первый оставшийся; пустой список → `logged_in: false`.
- Дедуп по (server, username).
- `GET /api/auth/status` не возвращает пароли (только `server`, `username`).
- Импорт при старте: если `settings.json` повреждён — пустой список (как сейчас с настройками).

## Тестирование

- Dev: `npm run dev` → добавить два аккаунта (разные пользователи/серверы), переключение, перезапуск приложения (аккаунты сохранились), удаление, пустое состояние.
- Rust: `cargo build` без ошибок; проверка API через curl на активном бэкенде (switch/import/accounts).
- UI: `vite build` без ошибок.
- Релиз/установщик не собирается.

## Вне объёма

- Разные окна на разные аккаунты одновременно.
- Шифрование паролей на диске.
- OAuth/токены NextCloud (только basic auth, как сейчас).