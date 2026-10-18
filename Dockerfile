FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY backend/app.py backend/calculations.py backend/ml_engine.py ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

ENV PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SOILAI_MODEL_PATH=/tmp/soilai/soil_rf.joblib

RUN adduser --disabled-password --gecos "" --uid 10001 appuser \
    && mkdir -p /tmp/soilai \
    && chown -R appuser:appuser /tmp/soilai

USER appuser
EXPOSE 8080

CMD ["sh", "-c", "exec gunicorn --preload --bind 0.0.0.0:${PORT:-8080} --workers 2 --threads 4 --timeout 60 app:app"]
