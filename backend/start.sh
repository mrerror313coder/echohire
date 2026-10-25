#!/bin/sh
# Render's free instance must serve uvicorn on $PORT. Gemma stays on the laptop.
set -eu
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
