"""Интроспекция SQLite-схемы: таблицы, колонки, PK/FK, индексы, views.

Возвращает единый JSON, который фронтенд превращает в граф.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path


def _q(ident: str) -> str:
    """Экранировать идентификатор для вставки в PRAGMA/SQL."""
    return '"' + ident.replace('"', '""') + '"'


def open_ro(path: str) -> sqlite3.Connection:
    """Открыть базу только на чтение (mode=ro), ошибки — наружу."""
    if not Path(path).is_file():
        raise FileNotFoundError(f"Файл не найден: {path}")
    conn = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def introspect(path: str) -> dict:
    conn = open_ro(path)
    try:
        return _introspect_conn(conn, path)
    finally:
        conn.close()


def _introspect_conn(conn: sqlite3.Connection, path: str) -> dict:
    objs = conn.execute(
        "SELECT name, type, sql FROM sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' "
        "ORDER BY name"
    ).fetchall()

    table_names = {r["name"] for r in objs}
    tables, views = [], []

    for row in objs:
        name, kind, sql = row["name"], row["type"], row["sql"]
        qi = _q(name)

        # --- колонки -------------------------------------------------------
        columns, pk_parts = [], []
        autoincrement = bool(sql) and "AUTOINCREMENT" in sql.upper()
        for c in conn.execute(f"PRAGMA table_info({qi})"):
            ordinal = int(c["pk"])
            if ordinal:
                pk_parts.append((ordinal, c["name"]))
            columns.append({
                "name": c["name"],
                "type": (c["type"] or "").strip(),
                "notNull": bool(c["notnull"]),
                "default": c["dflt_value"],
                "pk": bool(ordinal),
                "pkOrdinal": ordinal,
                "autoincrement": bool(ordinal and autoincrement),
            })
        pk_cols = [n for _, n in sorted(pk_parts)]

        # --- индексы и уникальные наборы -------------------------------------
        indexes, unique_sets = [], []
        for ix in conn.execute(f"PRAGMA index_list({qi})"):
            cols = [r["name"] for r in conn.execute(f"PRAGMA index_info({_q(ix['name'])})")]
            unique = bool(ix["unique"])
            indexes.append({
                "name": ix["name"],
                "columns": cols,
                "unique": unique,
                "origin": ix["origin"],  # c=create, u=unique constraint, p=pk
            })
            if unique:
                unique_sets.append(cols)

        # --- внешние ключи ---------------------------------------------------
        fk_groups: dict[int, dict] = {}
        for f in conn.execute(f"PRAGMA foreign_key_list({qi})"):
            g = fk_groups.setdefault(int(f["id"]), {
                "toTable": f["table"], "from": [], "to": [],
                "onUpdate": f["on_update"], "onDelete": f["on_delete"],
            })
            g["from"].append(f["from"])
            g["to"].append(f["to"] if f["to"] else None)

        foreign_keys = []
        for gid in sorted(fk_groups):
            g = fk_groups[gid]
            fk_cols = g["from"]
            # 1:1, если FK-колонки покрыты уникальным индексом
            # (PK-индекс тоже сюда попадает, поэтому FK == PK считается 1:1 автоматически)
            # Уникальность составного (a, b) не делает уникальной одну колонку a.
            # INTEGER PRIMARY KEY не всегда представлен отдельным индексом SQLite.
            is_unique = set(fk_cols) == set(pk_cols) or any(
                set(fk_cols) == set(unique) for unique in unique_sets
            )
            foreign_keys.append({
                "id": gid,
                "from": fk_cols,
                "toTable": g["toTable"],
                "to": g["to"] if all(g["to"]) else [],  # to=null → ссылаемся на PK
                "onUpdate": None if g["onUpdate"] == "NO ACTION" else g["onUpdate"],
                "onDelete": None if g["onDelete"] == "NO ACTION" else g["onDelete"],
                "nullable": any(c["name"] in fk_cols and not c["notNull"] for c in columns),
                "oneToOne": bool(is_unique),
                "dangling": g["toTable"] not in table_names,
            })

        # --- строк (лениво и без фатальности) ---------------------------------
        row_count = None
        try:
            row_count = conn.execute(f"SELECT COUNT(*) FROM {qi}").fetchone()[0]
        except sqlite3.DatabaseError:
            pass

        entry = {
            "name": name,
            "kind": kind,  # table | view
            "sql": sql,
            "rowCount": row_count,
            "columns": columns,
            "primaryKey": pk_cols,
            "indexes": indexes,
            "foreignKeys": foreign_keys,
        }
        (tables if kind == "table" else views).append(entry)

    relations = sum(len(t["foreignKeys"]) for t in tables)
    referenced = {fk["toTable"] for t in tables for fk in t["foreignKeys"]}

    return {
        "path": str(Path(path).resolve()),
        "dialect": "sqlite",
        "tables": tables + views,
        "stats": {
            "tables": len(tables),
            "views": len(views),
            "relations": relations,
            "unresolved": len(referenced - table_names),
        },
    }


def sample_rows(path: str, table: str, limit: int = 25) -> dict:
    """Топ-N строк таблицы/вьюхи для сайд-панели."""
    conn = open_ro(path)
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
            (table,),
        ).fetchone()
        if not exists:
            raise KeyError(f"Таблицы {table!r} в этой базе нет")
        cur = conn.execute(
            f"SELECT * FROM {_q(table)} LIMIT {max(1, min(int(limit), 200))}"
        )
        cols = [d[0] for d in cur.description]
        rows = [[_cell(v) for v in r] for r in cur.fetchall()]
        return {"columns": cols, "rows": rows, "total": len(rows)}
    finally:
        conn.close()


def _cell(v):
    if v is None:
        return None
    if isinstance(v, bytes):
        return f"<blob {len(v)} b>"
    return str(v)
