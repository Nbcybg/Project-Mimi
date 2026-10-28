#!/bin/sh
# Starts the Mimi core in Docker as the unprivileged "node" user.
# Hosted volumes (Railway) and bind folders Docker creates itself are owned by root, which
# "node" cannot write to. Started as root, this hands such folders to "node" and then drops
# root for good; folders the user already owns are left as they are.
set -e
if [ "$(id -u)" = "0" ]; then
  for dir in "${MIMI_USER:-/app/user}" "${MIMI_BACKUP_DIR:-/app/backups}"; do
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" = "0" ]; then
      chown -R node:node "$dir"
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
