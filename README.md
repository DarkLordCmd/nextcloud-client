# NextCloud Client

Desktop client for [NextCloud](https://nextcloud.com) with a Rust backend and an Electron + React frontend.

- **Backend:** Rust (`axum`) local HTTP server that talks to NextCloud via WebDAV / OCS
- **Frontend:** Electron + React + Vite + TailwindCSS
- **Progress:** file operations stream progress over SSE (Server-Sent Events)

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

## Features

- Login with server URL, username and password (in-memory credentials, no tokens stored)
- Two-pane file browser: folder tree on the left, file list on the right
- Breadcrumb navigation, click a folder to navigate, double-click a file to download
- Sortable columns (Name, Size, Modified), folders always on top
- Upload with live progress bars over SSE, multi-file selection and drag & drop
- Create folders, delete, rename (WebDAV MKCOL / DELETE / MOVE)
- Download streams files straight from the server
- Context menu, keyboard shortcuts (F5 refresh, Backspace up, Del delete, Ctrl+A select all, Ctrl+U upload)
- File icons by MIME type

## Requirements

- Rust toolchain (rustc 1.85+)
- Node.js 18+ and npm

## Development

```bash
npm install
npm run dev        # starts Vite dev server + Electron (spawns the Rust backend)
```

## Build & package

```bash
npm run build       # release build of the Rust backend + Vite build of the UI
npm run package:win # NSIS installer (Windows)
npm run package:mac # DMG (macOS)
npm run package:linux # AppImage (Linux)
```

The Rust binary is bundled into the app via `electron-builder` `extraResources`.
Note: the packaged binary name (`nextcloud-client` vs `nextcloud-client.exe`) is
platform-specific — adjust `electron-builder.yml` when packaging for macOS/Linux.

## API (local backend)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Save server + credentials and verify the connection |
| `GET` | `/api/auth/status` | Check whether credentials are present |
| `POST` | `/api/auth/logout` | Clear credentials |
| `GET` | `/api/files?path=/` | List files and folders by path |
| `GET` | `/api/files/download?path=...` | Stream a file to the client |
| `POST` | `/api/files/upload?path=...` | Upload a file (multipart) |
| `DELETE` | `/api/files?path=...` | Delete a file or folder |
| `POST` | `/api/files/mkdir?path=...` | Create a folder |
| `PATCH` | `/api/files/rename` | Rename a file/folder |
| `GET` | `/api/files/progress` | SSE stream of operation progress |

## License

[MIT](LICENSE)