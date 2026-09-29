FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e . \
 && pip install --no-cache-dir "pandas>=2.2" "scikit-learn>=1.5" "db-dtypes>=1.2"

# The staging transforms and ML definitions are executed from these files at
# runtime, so the image ships the same SQL that CI dry-runs on every PR.
COPY sql ./sql
COPY services/__init__.py ./services/__init__.py
COPY services/pricing_svc ./services/pricing_svc
# Cloud Run injects PORT. One worker per instance; concurrency is set on the
# service, so the process stays simple and the memory ceiling predictable.
CMD exec uvicorn services.pricing_svc.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1
