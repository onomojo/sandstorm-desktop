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

echo "==> Fixing node-pty spawn-helper permissions..."
# npm does not preserve execute permissions on prebuilt binaries.
# node-pty's spawn-helper must be executable for pty.spawn() to work on macOS/Linux.
find node_modules/node-pty -name spawn-helper -exec chmod +x {} \;
echo "    spawn-helper permissions fixed."

echo "==> Writing build version..."
git rev-parse --short HEAD > src/renderer/build-version.txt
echo "    Commit: $(cat src/renderer/build-version.txt)"

echo "==> Building app..."
npm run build

echo "==> Rebuilding native modules for Electron..."
# electron-rebuild recompiles native Node modules for Electron's Node version.
# We use --only to rebuild just the modules we need (avoids transitive native dep failures).
# If you add a new native module, add it to the comma-separated list below.
npx electron-rebuild --only better-sqlite3
echo "    Native module rebuild step complete."

echo "==> Packaging for $platform..."
npm run package -- --config.npmRebuild=false

echo ""
echo "==> Done! Release artifacts are in release/"
ls -lh release/*.{AppImage,dmg,exe} 2>/dev/null || ls -lh release/
