"""
Root entrypoint for Azure App Service / gunicorn.

This wrapper allows a startup command like:
  gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker

…while keeping the actual FastAPI code in backend/app.py.
"""
from backend.app import app  # noqa: F401
