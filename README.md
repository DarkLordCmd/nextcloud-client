# NextCloud Client

Десктопный клиент для [NextCloud](https://nextcloud.com) с Rust-бэкендом и фронтендом на Electron + React.

- **Бэкенд:** Rust (`axum`), локальный HTTP-сервер, общается с NextCloud через WebDAV / OCS
- **Фронтенд:** Electron + React + Vite + TailwindCSS
- **Прогресс:** ход операций передаётся по SSE (Server-Sent Events)

```
┌─────────────────────────────────────────────────────┐
│                  Electron (GUI)                      │
│              React + Vite + TailwindCSS              │
│                                                      │
│   LoginForm │ FileExplorer │ FileList │ Toolbar      │
│                      │                               │
│              fetch → localhost:7842                  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP + SSE
┌──────────────────────▼──────────────────────────────┐
│                  Rust Backend                        │
│            axum HTTP server :7842                    │
│                                                      │
│   auth.rs │ nextcloud.rs │ upload.rs │ download.rs   │
│                      │                               │
│         WebDAV / OCS API requests                    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
              ┌────────▼────────┐
              │  NextCloud      │
              │  Server         │
              └─────────────────┘
```

## Возможности

- Вход по адресу сервера, логину и паролю (данные хранятся в памяти, на диск ничего не пишется)
- Двухпанельный файловый менеджер: дерево папок слева, список файлов справа
- Навигация по breadcrumb, клик по папке — переход внутрь, двойной клик по файлу — скачивание
- Сортировка по колонкам (Имя, Размер, Изменён), папки всегда сверху
- Загрузка файлов с живыми прогресс-барами через SSE, мультивыбор и drag & drop
- Создание папок, удаление, переименование (WebDAV MKCOL / DELETE / MOVE)
- Скачивание со стримингом напрямую с сервера
- Контекстное меню, горячие клавиши (F5 обновить, Backspace вверх, Del удалить, Ctrl+A выделить всё, Ctrl+U загрузка)
- Иконки файлов по MIME-типу
- Встроенный просмотрщик (двойной клик или «Preview» в контекстном меню): фото, видео, аудио, PDF, txt, md, docx, xls/xlsx (старый .doc — скачивание); навигация ◀/▶ и колесо мыши по файлам того же типа, масштаб Ctrl+колесо

## Требования

- Rust toolchain (rustc 1.85+)
- Node.js 18+ и npm

## Разработка

```bash
npm install
npm run dev        # запускает Vite dev server + Electron (поднимает Rust-бэкенд)
```

## Сборка и упаковка

```bash
npm run build       # release-сборка Rust-бэкенда + Vite-сборка UI
npm run package:win # установщик NSIS (Windows)
npm run package:mac # DMG (macOS)
npm run package:linux # AppImage (Linux)
```

Rust-бинарник встраивается в приложение через `electron-builder` `extraResources`.
Обратите внимание: имя бинарника (`nextcloud-client` vs `nextcloud-client.exe`)
зависит от платформы — при сборке для macOS/Linux поправьте `electron-builder.yml`.

## API (локальный бэкенд)

| Метод | Путь | Описание |
|-------|------|----------|
| `POST` | `/api/auth/login` | Сохранить адрес сервера и учётные данные, проверить соединение |
| `GET` | `/api/auth/status` | Проверить наличие сохранённых учётных данных |
| `POST` | `/api/auth/logout` | Очистить учётные данные |
| `GET` | `/api/files?path=/` | Листинг файлов и папок по пути |
| `GET` | `/api/files/download?path=...` | Стриминг файла клиенту; `&inline=1` — `Content-Disposition: inline`, проброс `Range` (перемотка медиа, показ PDF) |
| `POST` | `/api/files/upload?path=...` | Загрузить файл (multipart) |
| `DELETE` | `/api/files?path=...` | Удалить файл или папку |
| `POST` | `/api/files/mkdir?path=...` | Создать папку |
| `PATCH` | `/api/files/rename` | Переименовать файл/папку |
| `GET` | `/api/files/progress` | SSE-поток прогресса операций |

## Лицензия

[MIT](LICENSE)