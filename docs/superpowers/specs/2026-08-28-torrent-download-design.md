# Дизайн: скачивание торрентов в Nextcloud через aria2c

Дата: 2026-08-28. Статус: утверждён.

## Цель

Дать пользователю возможность добавлять торренты (magnet-ссылка или .torrent файл) в приложение, скачивать их через `aria2c` на локальную машину и автоматически загружать скачанные файлы в выбранную папку Nextcloud (с сохранением структуры вложенных папок).

## Решения (согласованы)

- **Движок:** внешний `aria2c` 1.37.0 (win-64), встроенный в установщик как `resources/bin/aria2c.exe`.
- **Добавление:** magnet-ссылка ИЛИ .torrent файл (диалог выбора).
- **Целевая папка:** выбирается пользователем при добавлении торрента.
- **Структура:** файлы загружаются с сохранением структуры папок торрента.
- **Управление:** пауза / возобновление / отмена / прогресс.
- Коммиты делаются, релиз/установщик не публикуется в этой задаче (кроме локальной сборки для проверки).

## Архитектура

### 1. Сборка — встраивание aria2c

- `aria2c.exe` (1.37.0 win-64, ~2.4 МБ zip) кладётся в `resources/` при сборке.
- `electron-builder.yml` — добавить `extraResources`:
  ```yaml
  extraResources:
    - from: src-rust/target/release/nextcloud-client.exe
      to: bin/nextcloud-client.exe
    - from: build/aria2c.exe
      to: bin/aria2c.exe
  ```
- Dev-пути поиска aria2c: `process.resourcesPath/bin/aria2c.exe`, `src-rust/target/debug/aria2c.exe` (dev), рядом с приложением.
- Файл `build/aria2c.exe` — скачивается один раз (официальный GitHub release aria2) и кладётся в репозиторий (или скачивается скриптом при сборке).

### 2. Electron main — менеджер торрентов `src-electron/torrents.js`

**Запуск aria2c при старте приложения:**
```js
spawn(aria2Path, [
  '--enable-rpc', '--rpc-listen-all=false',
  '--rpc-listen-port=<свободный>',
  '--dir=<temp>/nextcloud-torrents',
  '--seed-time=0',
  '--bt-save-metadata=false',
  '--console-log-level=warn',
])
```
- Порт — свободный (аналогично `find_free_port` для бэкенда).
- aria2c — фоновый процесс, убивается при выходе (как Rust-бэкенд).

**JSON-RPC клиент** (HTTP POST `http://127.0.0.1:<port>/jsonrpc`):
- `aria2.addUri([magnet])`, `aria2.addTorrent(base64, [], { dir })`
- `aria2.tellStatus(gid)`, `aria2.tellActive()`, `aria2.tellWaiting(0,n)`, `aria2.tellStopped(0,n)`
- `aria2.pause(gid)`, `aria2.unpause(gid)`, `aria2.remove(gid)`

**Поток данных:**
- Поллинг каждые ~1с: `tellActive` + `tellStopped` → статусы (gid, имя, completedLength, totalLength, downloadSpeed, status).
- События → renderer через `webContents.send('torrent:status', {...})`.
- По завершении (`complete`): собрать локальные файлы (рекурсивно из `--dir`), запустить загрузку в Nextcloud (Секция 4), затем очистить temp.

**IPC:**
- `torrent:add` (invoke): `{ source: magnetString | torrentPath, targetDir }` → gid.
- `torrent:pause` / `torrent:unpause` / `torrent:remove` (invoke): gid.
- `torrent:list` (invoke): текущие статусы.
- `torrent:pick-torrent` (invoke): диалог выбора .torrent файла → путь.

### 3. UI — панель «Torrents»

- Кнопка в Toolbar (иконка) → панель/модалка.
- Форма добавления:
  - Поле «Magnet link», кнопка «Выбрать .torrent».
  - Поле «Папка в Nextcloud» (ввод пути, дефолт `/`).
  - Кнопка «Добавить».
- Список торрентов: имя, прогресс-бар (скачивание), скорость, статус (downloading / seeding / uploading-to-cloud / done / error / paused), кнопки ⏸/▶/✕.
- Прогресс загрузки в Nextcloud — в существующей панели операций (через `download:progress`).
- Все строки через `t()` (EN/RU) — новые ключи в `i18n.jsx`.

### 4. Загрузка скачанного в Nextcloud (сохранение структуры)

- После завершения торрента main-процесс рекурсивно обходит `--dir`.
- Для каждого файла:
  1. Для вложенных папок — `mkdir` через `POST /api/files/mkdir?path=...`.
  2. `POST /api/files/upload?path=<dir>&name=<name>` с телом = содержимое файла на диске (потоково).
- Крупные файлы — существующий chunked upload v2 (порог 8 МБ в бэкенде уже есть; из main шлём поток — бэкенд сам решает).
- Прогресс загрузки → renderer через `download:progress` (существующий канал).
- После успешной загрузки файла — удалить локальную копию.
- Используется активный аккаунт (токен бэкенда).

### 5. Безопасность и ограничения

- aria2c RPC слушает только 127.0.0.1.
- Temp: `app.getPath('temp')/nextcloud-torrents`.
- Загрузка в Nextcloud — через активный аккаунт (учётка уже в бэкенде).
- Отмена торрента → `aria2.remove` + очистка temp.
- После загрузки всех файлов в облако — очистка temp-директории торрента.
- При выходе приложения — убить aria2c.

### 6. Вне объёма

- Streaming-скачивание на лету (без диска).
- Resume magnet-сессий после перезапуска приложения.
- Множественные одновременные торренты в разных аккаунтах.

## Тестирование

- Rust/UI: `cargo build`, `vite build` без ошибок.
- Локальная сборка `electron-builder --dir` + проверка, что aria2c в `resources/bin`.
- Ручной: добавить торрент (magnet/файл) с маленьким контентом, дождаться скачивания, проверить загрузку в Nextcloud (структура папок), отмену/паузу.
- Релиз/установщик не публикуется.