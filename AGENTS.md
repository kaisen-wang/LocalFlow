# LocalFlow

Tauri v2 + React 19 + Vite 7 desktop app — a local-only todo/workflow tool.

## Dev commands

```sh
npm run tauri:dev      # launch Tauri dev (frontend on :1420, Rust hot-reloaded)
npm run tauri:build    # production build → src-tauri/target/release/bundle/
npm run release:check  # frontend build + cargo check before release
npm run dev            # Vite-only frontend (no Tauri backend)
```

- `TAURI_DEV_HOST` env var enables network access (Vite HMR on :1421).
- `APPIMAGE_EXTRACT_AND_RUN=1` required for AppImage build on systems without FUSE support.
- Vite ignores `src-tauri/` in its file watcher (Tauri handles Rust recompilation).
- Push tag `v*` to run `.github/workflows/release.yml` (draft GitHub Release).

## Architecture

| Layer | Dir | Entrypoint |
|-------|-----|------------|
| Frontend (React) | `src/` | `src/main.jsx` → `App.jsx` |
| Backend (Rust) | `src-tauri/` | `src/main.rs` → `lib.rs` + `crypto_db.rs` |

- Rust lib crate is **`localflow_lib`** (not `localflow`) to avoid Windows binary name conflicts.
- Display name **LocalFlow**; identifier `com.carson.localflow`.
- CSP is `null` (disabled) — security boundary relies on Tauri's permission system.

## State

All Phase 0–4 complete. See `开发进度.md`, `用户手册.md`, `跨平台测试清单.md`.

## Dependencies

- `@tauri-apps/api` v2, plugins: opener, global-shortcut, dialog, autostart (frontend)
- `tauri` v2 (`tray-icon`), matching plugins, `rusqlite` (`bundled-sqlcipher-vendored-openssl`), `uuid`, `chrono`, `serde`/`serde_json` (Rust)
