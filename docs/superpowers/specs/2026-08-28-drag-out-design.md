# Дизайн: Drag-and-drop файлов из приложения в Windows

Дата: 2026-08-28. Статус: утверждён.

## Цель

Дать возможность перетаскивать файлы и папки из окна приложения (список файлов) в папку на Windows через drag-and-drop. При броске Windows копирует файл(ы) в целевую папку, файлы предварительно скачиваются из NextCloud во временную директорию.

## Решения (согласованы)

- **Несколько файлов:** drag нескольких выбранных файлов одновременно.
- **Папки:** тоже перетаскиваются — папка экспортируется как ZIP (рекурсивно), Windows копирует архив.
- **Задержка:** пользователь ждёт скачивания; drag стартует по готовности файлов.
- **Прогресс:** показывается в панели операций (существующий `download:progress` канал).
- **Подход A:** скачивание в temp через бэкенд + `webContents.startDrag()` по готовности.
- Коммиты делаются, релиз/установщик не выпускается в этой задаче.

## Архитектура

### 1. Backend (Rust) — экспорт

**Новый файл `src-rust/src/export.rs`:**
- `GET /api/files/export?path=/X`:
  - Если `path` — файл: стримит содержимое (как `/api/files/download`, без inline).
  - Если `path` — папка: рекурсивно собирает все файлы (через `nextcloud::propfind` на каждом узле), упаковывает в **ZIP** во временный файл, стримит его как `attachment; filename="<folder>.zip"`, затем удаляет временный файл.
- Рекурсия: `collect_entries(state, path)` → обходит подпапки через `propfind` (Depth 1), собирает относительные пути файлов.

**Зависимость:** добавить `zip` в `Cargo.toml`.

**Роутер (`server.rs`):** `.route("/api/files/export", get(export::export_file))`.

**Прогресс:** для экспорта отдельного файла — как в `download.rs` (стрим). Для папки — файлы собираются последовательно; прогресс по числу файлов не обязателен (принято «ждать скачивания»).

### 2. Electron main — temp + startDrag

**`src-electron/downloads.js`** (или новый модуль `dragout.js`):
- IPC `drag:start` (send, не invoke) — payload: `{ paths: [{ path, name }] }` (name — имя файла/папки для имени на диске).
- Алгоритм:
  1. Создать temp-директорию `path.join(app.getPath('temp'), 'nextcloud-drag-' + Date.now())`.
  2. Для каждого элемента: `GET /api/files/export?path=<path>` с токеном (Bearer), сохранить в temp-директорию с именем `name` (для папки — `name.zip`, т.к. бэкенд отдаёт zip).
  3. Прогресс шлётся через `download:progress` (существующий канал `sender.send`) — рендерер уже рисует его в ProgressPanel.
  4. По завершении всех — `getMainWindow().webContents.startDrag({ files: [локальные пути], icon })`.
  5. `startDrag` требует иконку — использовать `nativeImage.createFromDataURL(...)` с встроенным PNG (16x16).
- Ошибка любого файла: остановить, удалить temp-директорию, отправить `download:progress` с `error`.
- Cleanup: при `app.on('before-quit')` — удалять все `nextcloud-drag-*` директории из temp.

**`src-electron/main.js`:** зарегистрировать IPC `drag:start` и cleanup при выходе.

### 3. Renderer (React)

**`src-ui/components/FileList.jsx`:**
- Строки файлов и папок получают `draggable`.
- `onDragStart(e, item)`:
  - `e.dataTransfer.effectAllowed = 'copy'`;
  - `e.dataTransfer.setData('text/plain', item.name)` (совместимость);
  - вызвать `window.nextcloud.startDrag([{ path: item.path, name: item.name }])`.
- Для мультивыбора: если строка уже в `selected`, перетаскиваются все выбранные (только файлы + папки); иначе — только эта строка.

**`src-ui/context/AppContext.jsx`:**
- Функция `startDragOut(paths)` → `window.nextcloud.startDrag(paths)`.

**`src-electron/preload.js`:**
- `startDrag: (paths) => ipcRenderer.send('drag:start', paths)`.

### 4. i18n

- Ключ `progress.preparing` (EN: "Preparing…", RU: "Подготовка…") — необязательно, существующий `progress.operation` подойдёт. Добавить только если нужно.

## Крайние случаи

- Ошибка скачивания одного файла → весь drag прерывается, temp удаляется, ошибка в ProgressPanel.
- Пустой выбор → ничего.
- Папка → zip с именем `<folder>.zip`.
- Очень большие файлы → пользователь ждёт (принято).

## Вне объёма

- Drag папки как каталога (без zip) — Windows не копирует каталог из startDrag надёжно.
- Drag нескольких папок с сохранением структуры — каждая папка отдельным zip.
- Отмена drag после начала скачивания.

## Тестирование

- Rust: `cargo build` без ошибок; `curl /api/files/export?path=/file` и `?path=/folder` (zip) на live-бэкенде.
- UI: `vite build`.
- Ручной: drag файла и папки в проводник → файл/zip копируется в папку.
- Релиз не собирается.