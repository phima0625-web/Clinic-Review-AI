#!/bin/bash
# Double-click this file in Finder to install dependencies and start the Clinic Review AI backend.
# (macOS opens it in Terminal.) Leave the window open while you use the app. Stop with Ctrl+C.

cd "$(dirname "$0")" || exit 1

echo ""
echo "=== Clinic Review AI — backend ==="
echo "Folder: $(pwd)"
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js (LTS) from https://nodejs.org/"
  echo "Then double-click this file again."
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Running npm install (safe to repeat)..."
npm install || { echo "npm install failed."; read -r -p "Press Enter to close..."; exit 1; }

echo ""
echo "Starting server. Leave this window OPEN."
echo "Open http://localhost:3000 in a browser to verify."
echo "Press Ctrl+C to stop the server."
echo ""

npm start

echo ""
read -r -p "Press Enter to close..."
