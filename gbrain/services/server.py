"""server.py -- single gbrain process serving all 4 MCP surfaces.

NEW for OfficeAgent (implementation-plan-v1.md §2.1 / §3 Step 2.1). The
upstream gbrain project ran memory_mcp, recall_mcp, swarm_mcp and task_mcp
as four separate uvicorn processes on four separate ports (8767/8768/8766/
8769). For a self-hosted single-owner install that is unnecessary process
overhead (4x the FastEmbed model load, 4x the asyncpg pool) and a bigger
attack surface (4 listening ports instead of 1). This module composes all
four FastMCP apps into ONE Starlette application, mounted on 4 paths under
ONE port (`MCP_PORT`, default 8770):

    /memory/mcp   -> services.memory_mcp.server.mcp
    /recall/mcp   -> services.recall_mcp.server.mcp
    /swarm/mcp    -> services.swarm_mcp.server.mcp
    /task/mcp     -> services.task_mcp.server.mcp

Deviation from the plan's literal table row 2.2 ("main() и собственный
FastMCP заменяются на register_X(mcp, deps)"): that would refactor every
sub-module to expose a `register_X(mcp, deps)` function and share ONE
AuthCaptureMiddleware class. This module takes the lower-risk path instead
-- it imports each sub-module UNCHANGED (each still builds its own `mcp`
FastMCP instance, its own tools, and its own AuthCaptureMiddleware exactly
as it did as a standalone server) and only adds a composition layer on
top: mount each module's already-built `mcp.http_app()` (wrapped in its
own middleware) under this process's Starlette router, and manually drive
each module's `lifespan()` context manager via `AsyncExitStack` (Starlette
does NOT forward ASGI 'lifespan' protocol messages to `Mount()`-ed
sub-apps, so this manual step is required, not optional, for the pool /
FastEmbed model / outbox-recovery startup work each module's lifespan does
to actually run). This achieves the same outcome -- one process, one port,
four MCP surfaces -- with a much smaller diff against the upstream
per-service modules. Revisit the full register_X refactor later if the
composition layer proves too fragile.

Also runs the ingest worker and swarm delivery worker as background
asyncio tasks in this same process (plan §2.1), and applies pending SQL
migrations under a Postgres advisory lock (see scripts/migrate.py, M11)
before the HTTP port opens -- so a fresh install's first request never
races the schema.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import AsyncExitStack, asynccontextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from services.memory_mcp import server as memory_server
from services.recall_mcp import server as recall_server
from services.swarm_mcp import server as swarm_server
from services.task_mcp import server as task_server
from services.ingest_worker.worker import run_worker as run_ingest_worker
from services.swarm_mcp.worker import run as run_swarm_worker
from services.shared.db import close_pool

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("officeagent.gbrain.server")

DEFAULT_PORT = 8770


async def _health(_request: Request) -> JSONResponse:
    """Liveness/readiness probe for docker-compose `healthcheck:`.

    Deliberately does NOT touch the DB -- a slow/overloaded Postgres
    should not flip the container to unhealthy and trigger a restart
    storm. If deeper checks are needed later, add a separate /ready.
    """
    return JSONResponse({"status": "ok", "service": "officeagent-gbrain"})


async def _run_background_worker(name: str, coro_factory) -> None:
    """Run a worker coroutine forever, logging (not crashing the process)
    if it dies unexpectedly -- a stuck ingest/swarm worker should degrade
    the product (slower memory indexing / delivery), never take down the
    MCP surfaces that are still serving requests.
    """
    try:
        await coro_factory()
    except asyncio.CancelledError:
        logger.info("%s: cancelled (shutdown)", name)
        raise
    except Exception:  # noqa: BLE001 -- last-resort background-task guard
        logger.exception("%s: crashed, NOT restarted automatically", name)


@asynccontextmanager
async def lifespan(_app: Starlette):
    logger.info("officeagent-gbrain: applying pending migrations")
    # Imported lazily so a migration failure surfaces as a clean log line
    # before any FastMCP lifespan (pool/model init) has started.
    from scripts.migrate import run as run_migrations
    migration_rc = await run_migrations(list_only=False, check_only=False)
    if migration_rc != 0:
        raise RuntimeError("pending migrations failed to apply -- refusing to start")

    async with AsyncExitStack() as stack:
        # Manually drive each sub-module's own lifespan (pool init, model
        # load, outbox recovery). See module docstring: Starlette does not
        # do this automatically for Mount()-ed sub-apps.
        await stack.enter_async_context(memory_server.lifespan(memory_server.mcp))
        await stack.enter_async_context(recall_server.lifespan(recall_server.mcp))
        await stack.enter_async_context(swarm_server.lifespan(swarm_server.mcp))
        await stack.enter_async_context(task_server.lifespan(task_server.mcp))

        # Same reasoning, one level deeper: `server_module.mcp.http_app()`
        # returns FastMCP's OWN ASGI app (a Starlette instance), which has
        # its OWN lifespan that spins up StreamableHTTPSessionManager's task
        # group -- distinct from the module's custom lifespan() above, and
        # equally unreached by Mount(). Skipping it crashes every request
        # with "StreamableHTTPSessionManager task group was not initialized"
        # (found live: 2026-08-20, fresh install, first end-to-end run).
        for inner_app in _MOUNTED_INNER_APPS:
            await stack.enter_async_context(inner_app.lifespan(inner_app))

        logger.info("officeagent-gbrain: starting background workers")
        worker_tasks = [
            asyncio.create_task(
                _run_background_worker("ingest_worker", run_ingest_worker),
                name="officeagent-ingest-worker",
            ),
            asyncio.create_task(
                _run_background_worker("swarm_worker", run_swarm_worker),
                name="officeagent-swarm-worker",
            ),
        ]

        logger.info(
            "officeagent-gbrain: ready (memory+recall+swarm+task mounted, "
            "2 background workers running)"
        )
        try:
            yield
        finally:
            logger.info("officeagent-gbrain: shutting down background workers")
            for t in worker_tasks:
                t.cancel()
            await asyncio.gather(*worker_tasks, return_exceptions=True)
            # Belt-and-suspenders: each sub-module's own lifespan already
            # closes the shared pool on its way out of the ExitStack above;
            # close_pool() is idempotent (no-op once _pool is None), so a
            # final explicit call here is safe and guards against the
            # ingest/swarm workers (which also call close_pool() in their
            # own finally blocks) leaving it in a surprising state.
            await close_pool()
            logger.info("officeagent-gbrain: shutdown complete")


_MOUNTED_INNER_APPS: list = []


def _mounted_app(server_module) -> object:
    """Build the ASGI app for one MCP sub-module: FastMCP's streamable-http
    app wrapped in that module's own AuthCaptureMiddleware, exactly as it
    would run standalone. The unwrapped inner app is stashed in
    _MOUNTED_INNER_APPS so lifespan() above can also drive its lifespan.
    """
    inner = server_module.mcp.http_app(transport="streamable-http")
    _MOUNTED_INNER_APPS.append(inner)
    return server_module.AuthCaptureMiddleware(inner)


app = Starlette(
    routes=[
        Route("/health", _health, methods=["GET"]),
        Mount("/memory", app=_mounted_app(memory_server)),
        Mount("/recall", app=_mounted_app(recall_server)),
        Mount("/swarm", app=_mounted_app(swarm_server)),
        Mount("/task", app=_mounted_app(task_server)),
    ],
    lifespan=lifespan,
)


def main() -> None:
    import uvicorn
    port = int(os.environ.get("MCP_PORT", str(DEFAULT_PORT)))
    host = os.environ.get("MCP_HOST", "0.0.0.0")
    logger.info(
        "Starting officeagent-gbrain on %s:%d "
        "(memory=/memory/mcp recall=/recall/mcp swarm=/swarm/mcp task=/task/mcp)",
        host,
        port,
    )
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
