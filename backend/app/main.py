from __future__ import annotations

import os
import time
import re
import uuid
import json
import hashlib
import base64
import asyncio
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple, Set

# Pydantic (v1/v2 compatibility)
try:
    from pydantic import BaseModel, validator  # type: ignore
except Exception:  # pragma: no cover
    from pydantic.v1 import BaseModel, validator  # type: ignore

from filelock import FileLock  # type: ignore

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

# Threadpool helper (prevents blocking the event loop on requests/azure upload)
from starlette.concurrency import run_in_threadpool  # type: ignore

from .settings import settings
from .models import ChatResponse  # kept for compatibility with existing codebase

