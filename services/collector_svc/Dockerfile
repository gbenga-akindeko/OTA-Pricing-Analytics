FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY services/__init__.py ./services/__init__.py
COPY services/collector_svc ./services/collector_svc
# Cloud Run injects PORT. One worker per instance; concurrency is set on the
# service, so the process stays simple and the memory ceiling predictable.
CMD exec uvicorn services.collector_svc.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1
