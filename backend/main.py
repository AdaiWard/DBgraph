"""DB Graph — API: интроспекция SQLite + раздача фронтенда.

Запуск: uvicorn backend.main:app --port 8123  (или ./run.sh)
"""
from __future__ import annotations

import re
import os
import sqlite3
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import introspect
from . import demo as demo_db

app = FastAPI(title="DB Graph", docs_url=None, redoc_url=None)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads"

MAX_UPLOAD = 256 * 1024 * 1024  # 256 МБ
UPLOAD_CHUNK = 1024 * 1024
ALLOW_LOCAL_PATHS = os.getenv("DBGRAPH_ALLOW_LOCAL_PATHS", "").lower() in {"1", "true", "yes"}


def _allowed_path(path: str) -> str:
    """Разрешить демо/загрузки; произвольные пути — только явным opt-in."""
    resolved = Path(path).expanduser().resolve()
    if ALLOW_LOCAL_PATHS:
        return str(resolved)
    demo_path = demo_db.DB_PATH.resolve()
    upload_root = UPLOAD_DIR.resolve()
    if resolved == demo_path or resolved.is_relative_to(upload_root):
        return str(resolved)
    raise ValueError(
        "Чтение произвольных путей отключено. "
        "Загрузите файл через интерфейс или задайте DBGRAPH_ALLOW_LOCAL_PATHS=1."
    )


def _boom(e: Exception) -> HTTPException:
    msg = str(e)
    if isinstance(e, sqlite3.DatabaseError) and "not a database" in msg.lower():
        msg = "Это не SQLite-база (нет заголовка SQLite format 3)"
    return HTTPException(400, msg)


@app.get("/api/schema")
def schema(path: str | None = None, demo: bool | None = None, refresh_demo: bool = False):
    try:
        target = (
            str(demo_db.ensure_demo_db(force=refresh_demo))
            if (demo or not path)
            else _allowed_path(path)
        )
        return introspect.introspect(target)
    except (FileNotFoundError, sqlite3.DatabaseError, ValueError) as e:
        raise _boom(e)
    except Exception as e:  # повреждённая база умеет уронить что угодно
        raise _boom(e)


@app.get("/api/sample")
def sample(path: str, table: str, limit: int = 25):
    try:
        return introspect.sample_rows(_allowed_path(path), table, limit)
    except (FileNotFoundError, sqlite3.DatabaseError) as e:
        raise _boom(e)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """Загрузить .db/.sqlite файл браузером — сохраняем и интроспектируем."""
    safe = re.sub(r"[^\w.\-]+", "_", Path(file.filename or "upload.db").name)[:60] or "upload.db"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    out = UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}_{safe}"
    size = 0
    try:
        with out.open("xb") as target:
            while chunk := await file.read(UPLOAD_CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(
                        413,
                        f"Слишком большой файл (> {MAX_UPLOAD // 1024 // 1024} МБ)",
                    )
                target.write(chunk)
        with out.open("rb") as uploaded:
            if uploaded.read(16) != b"SQLite format 3\x00":
                raise HTTPException(
                    400,
                    "Это не SQLite-база (нет заголовка SQLite format 3)",
                )
        return introspect.introspect(str(out))
    except HTTPException:
        out.unlink(missing_ok=True)
        raise
    except (sqlite3.DatabaseError, ValueError) as e:
        out.unlink(missing_ok=True)
        raise _boom(e)
    except Exception:
        out.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@app.get("/healthz")
def health():
    return PlainTextResponse("ok")


# --- статика: фронтенд и его же на / -----------------------------------------
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")
