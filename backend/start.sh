#!/bin/sh
# Render's web process must be uvicorn on $PORT. Ollama stays on loopback.
set -eu

export OLLAMA_MODELS="${OLLAMA_MODELS:-/data/ollama}"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
MODEL="${OLLAMA_MODEL:-gemma2:2b}"

mkdir -p "$OLLAMA_MODELS"
ollama serve >/tmp/ollama.log 2>&1 &

(
  ready=0
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" -eq 1 ]; then
    ollama pull "$MODEL"
  else
    echo "Ollama did not become ready; scoring will use heuristics" >&2
  fi
) &

exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
