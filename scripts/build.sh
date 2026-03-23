#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Detecting platform..."
case "$(uname -s)" in
  Darwin) platform="macOS" ;;
  Linux)  platform="Linux" ;;
  *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac
echo "    Platform: $platform"

echo "==> Installing dependencies..."
npm ci

echo "==> Building app..."
npm run build

echo "==> Rebuilding native modules for Electron..."
# cpu-features may fail on Linux (needs newer g++ for -std=gnu++20) — that's OK, it's optional.
set +e
npx electron-rebuild
rebuild_status=$?
set -e
if [ $rebuild_status -ne 0 ]; then
  echo "    WARNING: electron-rebuild exited with $rebuild_status (cpu-features failure is OK)"
fi
echo "    Native module rebuild step complete."

echo "==> Packaging for $platform..."
npm run package -- --config.npmRebuild=false

echo ""
echo "==> Done! Release artifacts are in release/"
ls -lh release/*.{AppImage,dmg,exe} 2>/dev/null || ls -lh release/
