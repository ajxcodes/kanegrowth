#!/bin/sh
set -e

# Start the backend in the background.
kanegrowth-api &
BACKEND_PID=$!

# Wait for backend readiness.
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:5000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Start nginx in the foreground.
exec nginx -g 'daemon off;'
