#!/usr/bin/env python3
"""migrate.py -- apply SQL migrations under a Postgres advisory lock.

NEW for OfficeAgent (plan implementation-plan-v1.md M11): the upstream
gbrain project shipped `migrate.sh`, a bash script that ran migrations via
`sudo -u postgres psql`. That assumes a local Postgres superuser and a host
install -- neither holds in the OfficeAgent docker-compose topology, where
`gbrain` is a non-root container talking to a separate `db` service over
TCP/asyncpg. This is a from-scratch rewrite, not a port.

Idempotent: tracks applied migrations in `schema_migrations(filename,
applied_at)` (created here if missing -- also created redundantly by
migrations/001_initial_schema.sql on a fresh DB, CREATE TABLE IF NOT
EXISTS makes that safe). Each migration file runs inside one transaction.

Advisory lock (M11): before touching any migration, the process takes
`pg_advisory_lock(OFFICEAGENT_MIGRATION_LOCK_ID)` -- a single fixed lock
key shared by every gbrain replica. If the gbrain container is ever scaled
beyond one replica, or restarted while a previous instance's migration
run is still in flight, the second process blocks here instead of racing
the first through the same ALTER TABLE / CREATE INDEX statements. The lock
is released automatically when the connection closes (session-level
advisory lock), so a crashed process cannot leave it stuck.

Usage:
    python -m scripts.migrate            # apply pending, then exit 0
    python -m scripts.migrate --list     # print pending filenames, exit 0
    python -m scripts.migrate --check    # exit 1 if any pending (no apply)
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

import asyncpg

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.shared.config import Config  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("migrate")

# Fixed, arbitrary 63-bit key for pg_advisory_lock. Any single agreed-upon
# constant works -- it only needs to be the SAME constant across every
# process that might run migrations concurrently. Chosen by hashing the
# string "officeagent-gbrain-migrate" down to fit a Postgres bigint.
ADVISORY_LOCK_ID = 7_735_402_918_331_009  # noqa: E501 -- see docstring

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

CREATE_TRACKING_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
)
"""


def _pending_files(applied: set[str]) -> list[Path]:
    if not MIGRATIONS_DIR.is_dir():
        raise RuntimeError(f"migrations dir not found: {MIGRATIONS_DIR}")
    all_sql = sorted(
        p for p in MIGRATIONS_DIR.glob("*.sql") if p.name not in applied
    )
    # .sql.tmpl files (e.g. 008_fts_lang.sql.tmpl) are NOT plain migrations
    # -- they are rendered by the installer with an env-driven substitution
    # (FTS_LANGUAGE) before they become a real .sql file. Never apply a
    # .tmpl directly.
    return [p for p in all_sql if not p.name.endswith(".tmpl")]


async def _applied_filenames(conn: asyncpg.Connection) -> set[str]:
    await conn.execute(CREATE_TRACKING_TABLE)
    rows = await conn.fetch("SELECT filename FROM schema_migrations")
    return {r["filename"] for r in rows}


async def run(list_only: bool, check_only: bool) -> int:
    config = Config(mcp_port=int(os.environ.get("MCP_PORT", "8770")))
    dsn = config.get_pg_dsn()
    conn = await asyncpg.connect(**dsn)
    try:
        applied = await _applied_filenames(conn)
        pending = _pending_files(applied)

        if list_only:
            for p in pending:
                print(p.name)
            return 0

        if not pending:
            logger.info("no pending migrations")
            return 0

        if check_only:
            logger.warning("pending migrations: %s", [p.name for p in pending])
            return 1

        logger.info("acquiring advisory lock %d", ADVISORY_LOCK_ID)
        await conn.execute("SELECT pg_advisory_lock($1)", ADVISORY_LOCK_ID)
        try:
            # Re-read pending under the lock -- another replica may have
            # applied some of these between our first read and the lock.
            applied = await _applied_filenames(conn)
            pending = _pending_files(applied)
            for path in pending:
                logger.info("applying %s", path.name)
                sql = path.read_text(encoding="utf-8")
                async with conn.transaction():
                    await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename) VALUES ($1)",
                        path.name,
                    )
                logger.info("applied %s", path.name)
            logger.info("migrations complete (%d applied)", len(pending))
            return 0
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", ADVISORY_LOCK_ID)
    finally:
        await conn.close()


def main() -> None:
    list_only = "--list" in sys.argv[1:]
    check_only = "--check" in sys.argv[1:]
    exit_code = asyncio.run(run(list_only, check_only))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
