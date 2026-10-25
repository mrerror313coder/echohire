FROM python:3.12-slim-bookworm

WORKDIR /app
COPY requirements-render.txt .
RUN pip install --no-cache-dir -r requirements-render.txt
COPY main.py start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
