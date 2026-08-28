# Дизайн: переключатель языка интерфейса (EN/RU)

Дата: 2026-08-28. Статус: утверждён.

## Цель

Дать пользователю возможность переключать язык интерфейса между английским и русским. Переключение мгновенное, без перезапуска; выбор сохраняется в `settings.json` и переживает перезапуск.

## Решения (согласованы)

- Хранение языка: `settings.json` через существующий IPC (`getSettings` / `updateSettings`), поле `language` (`'en'` | `'ru'`).
- Переключатель: и в `SettingsModal`, и на `LoginForm` (доступен до входа — `getSettings` не требует авторизации).
- Язык по умолчанию: `'en'` (текущее поведение сохраняется).
- Механизм: собственный лёгкий i18n-контекст, без новых npm-зависимостей.
- Ошибки бэкенда: полностью переводятся через стабильный `error_code`, который возвращает Rust-бэкенд.

## Архитектура

### 1. i18n-контекст — новый файл `src-ui/i18n.js`

- Словари `messages.en` и `messages.ru` — плоские ключи, интерполяция `{var}`.
- `I18nProvider({ language, children })` — React-контекст; значение: `{ language, t }`.
- `t(key, vars)` — подстановка перевода с fallback: ключ → английский → сам ключ.
- `useI18n()` — хук доступа к контексту.

### 2. Подключение в `src-ui/context/AppContext.jsx`

- Новый стейт `language`; инициализируется из `settings.language` (после загрузки настроек), дефолт `'en'`.
- `setLanguage(lang)` — обновляет стейт и вызывает `updateSettings({ language: lang })`.
- Дерево оборачивается `<I18nProvider language={language}>` (внутри `AppProvider`).
- Смена языка мгновенно ре-рендерит все компоненты.

### 3. Переключатели

- **SettingsModal:** селект «Language / Язык» (English / Русский). Меняет язык сразу при выборе.
- **LoginForm:** компактный селект в углу формы.

### 4. Перевод статичного UI

Все пользовательские строки в компонентах заменяются на `t('...')`:

- `LoginForm.jsx` — «Connect to your cloud storage», «Server URL», «Username», «Password», «Remember me», «Connecting…», «Connect».
- `Toolbar.jsx` — «Upload», «New Folder», «Download», «Delete», «Refresh», «Settings», «N selected», title-подсказки, prompt «Folder name:», confirm «Delete N item(s)?».
- `FileExplorer.jsx` — «Folders», «Root».
- `FileList.jsx` — «Name», «Size», «Modified», «Loading…», «This folder is empty».
- `ContextMenu.jsx` — «Download», «Preview», «Rename», «Delete», «Refresh», «Save», confirm «Delete "name"?».
- `ProgressPanel.jsx` — «Operation», «Failed», «Retry», «Done».
- `SettingsModal.jsx` — все подписи и статусы обновления.
- `Breadcrumb.jsx` — title «Cloud root».
- `App.jsx` — «Drop to upload».
- `PreviewPanel.jsx` — сейчас частично хардкод русского; становится двуязычным (загрузка/ошибки/кнопки/подсказки).
- `FileList.formatDate` — использует язык для `toLocaleDateString`.
- `index.html` — `document.documentElement.lang` обновляется при смене языка (title оставляем статичным).

### 5. Перевод ошибок бэкенда

**Rust — `src-rust/src/models.rs`:**
- У `AppError` добавить метод `code()` → стабильный строковый код:
  - `NotAuthenticated` → `not_authenticated`
  - `BadRequest` → `bad_request`
  - `NextCloud` → `nextcloud` (деталь — HTTP-статус, он уже прокидывается)
  - `Xml` → `xml`
  - `Network` → `network`
  - `Internal` → `internal`
- В `IntoResponse` добавить поле `error_code` в JSON тела ответа:
  `{ "success": false, "error": "...", "error_code": "..." }`.

**Frontend — `src-ui/api.js`:**
- В выбрасываемой ошибке сохранять `code` (из `body.error_code`) и `status` (HTTP-статус).

**Словарь ошибок на фронте (в `i18n.js`):**
- Ключи вида `errors.not_authenticated`, `errors.bad_request`, `errors.nextcloud_401`, `errors.nextcloud_403`, `errors.nextcloud_404`, `errors.network`, `errors.xml`, `errors.internal`.
- Для `nextcloud` — выбор по `error_code` + HTTP-статус; серверный `message` остаётся как деталь (текст чужого сервера локализовать нельзя).

### 6. Совместимость

- Старый бэкенд без `error_code`: фронт показывает текст ошибки как раньше (fallback по `code` не сработал → показываем `error`).

## Тестирование

- Dev: `npm run dev` → вход, переключение языка на LoginForm и в настройках, проверка всех экранов (листинг, загрузка/скачивание, предпросмотр, ошибки).
- Ошибки: проверить 401/404 и сетевые сбои в обоих языках.
- Rust пересобирается для dev (`cargo build`); релиз/установщик в этой задаче не делаем.

## Вне объёма

- Другие языки кроме EN/RU.
- Локализация текста серверных сообщений NextCloud.
- Смена заголовка окна по языку.