FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl zstd \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://ollama.com/install.sh | sh || true \
    && command -v ollama \
    && ollama --version

WORKDIR /app
COPY requirements-render.txt .
RUN pip install --no-cache-dir -r requirements-render.txt
COPY main.py start.sh ./
RUN chmod +x start.sh

ENV OLLAMA_MODELS=/data/ollama \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_BASE=http://127.0.0.1:11434 \
    OLLAMA_MODEL=gemma2:2b \
    OLLAMA_GENERATE_TIMEOUT=180 \
    OLLAMA_NUM_CTX=4096

CMD ["./start.sh"]
