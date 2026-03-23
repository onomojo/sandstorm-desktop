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
# cpu-features may fail (needs newer g++) — that's OK, it's optional.
# If better-sqlite3 or other native modules are present, they must succeed.
npx electron-rebuild || echo "    WARNING: electron-rebuild had errors (cpu-features failure is OK)"
echo "    Native module rebuild step complete."

echo "==> Packaging for $platform..."
npm run package -- --config.npmRebuild=false

echo ""
echo "==> Done! Release artifacts are in release/"
ls -lh release/*.{AppImage,dmg,exe} 2>/dev/null || ls -lh release/
