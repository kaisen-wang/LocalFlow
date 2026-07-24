#!/usr/bin/env bash
# 本地打正式包前的自检：前端构建 + Rust check
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> npm ci / install"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "==> frontend build"
npm run build

echo "==> rust check"
(
  cd src-tauri
  cargo check
)

echo "==> OK — 可执行: npm run tauri build"
echo "    产物目录: src-tauri/target/release/bundle/"
