#!/bin/bash
# `npm run service`: keep devbox running in the background and after reboots (via pm2).
set -e
cd "$(dirname "$0")/.."

if ! command -v pm2 >/dev/null 2>&1; then
  echo "Installing pm2 (keeps devbox running)…"
  npm install -g pm2
fi

if pm2 describe devbox >/dev/null 2>&1; then
  pm2 restart devbox --update-env
else
  pm2 start server/server.js --name devbox --time
fi
pm2 save

echo
echo "devbox is running in the background."
echo
echo "To also start it after a reboot, run the command that pm2 prints below"
echo "(it starts with 'sudo env PATH=…'). You only need to do this once."
echo
pm2 startup | grep -E '^sudo ' || echo "(Already set up, or run: pm2 startup)"
echo
echo "Your phone link:  pm2 logs devbox --lines 40 --nostream | grep http"
