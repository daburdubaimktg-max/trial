#!/bin/bash
# Double-click this file to start Nova on a Mac.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS installer from https://nodejs.org, run it, then double-click this file again."
  read -r -p "Press Return to close."
  exit 1
fi

echo "Checking Nova's components. The first run downloads them and takes a few minutes..."
if ! npm install --no-audit --no-fund; then
  echo
  echo "Setup did not finish. Check your internet connection and try again."
  read -r -p "Press Return to close."
  exit 1
fi

echo "Starting Nova. Keep this window open while you use it."
npm start
