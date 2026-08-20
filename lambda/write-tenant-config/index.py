"""CloudFormation custom resource that prepares a tenant's EFS state before
Fargate ever starts: quarantines a corrupt state.db, and writes/updates the
``model:`` section of Hermes's ``config.yaml``.

Why the config.yaml part exists: everything else in this deployment is
env-var driven, but Hermes's gateway reads its default model *exclusively*
from config.yaml (``gateway/run.py::_resolve_gateway_model`` — "Read model
from config.yaml — single source of truth", no env var fallback). Without
this file, Hermes falls back to the packaged example config's default
(``anthropic/claude-opus-4.6``), which isn't a valid Bedrock model ID and
every turn fails with "the model provider failed after retries."

Idempotent + non-destructive: the managed block is wrapped in sentinel
comments so re-running this (e.g. after tenants.json changes the model)
only touches that block, never anything else a human or Hermes itself adds
to config.yaml over time.
"""

import os
import re
import shutil
import sqlite3
import time

EFS_ROOT = "/mnt/efs"
CONFIG_PATH = os.path.join(EFS_ROOT, "config.yaml")
STATE_DB_PATH = os.path.join(EFS_ROOT, "state.db")

BEGIN_MARKER = "# --- hermes-line-cdk managed: model (do not edit between markers) ---"
END_MARKER = "# --- end hermes-line-cdk managed block ---"


def _quarantine_corrupt_state_db() -> None:
    """Detect a corrupt state.db and move it aside so Hermes creates a
    fresh one on next boot, instead of crash-looping forever.

    Concurrent writers (two Fargate tasks briefly overlapping during a
    deployment) can corrupt SQLite over NFS — this happened once already
    (deployments before this fix allowed a rolling overlap; see
    docs/DESIGN.md). Detected here, at deploy time, rather than left for
    Hermes to discover at startup, because a corrupt DB can prevent the
    gateway from ever passing its health check, which blocks the very
    deployment that would let someone `ecs execute-command` in to fix it
    by hand.

    Quarantines (renames) rather than deletes — the old data isn't
    destroyed, just no longer in Hermes's way.
    """
    if not os.path.exists(STATE_DB_PATH):
        return

    try:
        conn = sqlite3.connect(f"file:{STATE_DB_PATH}?mode=ro", uri=True)
        try:
            result = conn.execute("PRAGMA integrity_check").fetchone()
            healthy = result is not None and result[0] == "ok"
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        healthy = False

    if healthy:
        return

    suffix = f".corrupt-{int(time.time())}"
    for name in ("state.db", "state.db-wal", "state.db-shm"):
        path = os.path.join(EFS_ROOT, name)
        if os.path.exists(path):
            os.rename(path, path + suffix)
    print(f"quarantined corrupt state.db (suffix {suffix}) - Hermes will create a fresh one")


def _managed_block(provider: str, default_model: str, browser_backend: str) -> str:
    # _config_version matters: a config.yaml written from scratch (no
    # version marker) makes Hermes's cont-init config-migrate step treat it
    # as a ~2-year-old config it "can no longer be auto-migrated" — and
    # whatever it does next hangs the gateway indefinitely with zero log
    # output in this non-interactive/headless deployment (observed: 7+
    # minutes silent, then killed by the ECS health check). The warning
    # message itself names the fix: set _config_version to the value it
    # expects. Bump this if a future hermesImageTag's config-migrate step
    # reports a different expected version.
    #
    # browser.backend: "off" — Hermes's default browser backend ("Browser
    # Use CLI" / browser_exec) is built to attach to a real, GUI desktop
    # Chrome install (it launches "Google Chrome.app" and waits for a human
    # to click its "Allow remote debugging?" popup) — there is no such
    # thing in a headless Fargate task, so browser_exec fails every time
    # with "chrome-not-running: ... none could be launched". "off" reverts
    # to the built-in browser_* tools, which drive Playwright's bundled
    # headless Chromium via the agent-browser CLI instead — the path
    # AGENT_BROWSER_ARGS (see tenant-stack.ts) actually applies to.
    return (
        f"{BEGIN_MARKER}\n"
        f"_config_version: 12\n"
        f"model:\n"
        f'  provider: "{provider}"\n'
        f'  default: "{default_model}"\n'
        f"browser:\n"
        f'  backend: "{browser_backend}"\n'
        f"{END_MARKER}\n"
    )


def _write_config(provider: str, default_model: str, browser_backend: str) -> None:
    block = _managed_block(provider, default_model, browser_backend)
    existing = ""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            existing = f.read()

    pattern = re.compile(re.escape(BEGIN_MARKER) + r".*?" + re.escape(END_MARKER) + r"\n?", re.DOTALL)
    if pattern.search(existing):
        new_content = pattern.sub(block, existing)
    elif existing:
        new_content = existing.rstrip("\n") + "\n\n" + block
    else:
        new_content = block

    os.makedirs(EFS_ROOT, exist_ok=True)
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(new_content)
    os.replace(tmp_path, CONFIG_PATH)


START_SCRIPT_PATH = os.path.join(EFS_ROOT, "start.sh")

# Absolute paths only — this runs as the *first argv* the container's own
# docker/main-wrapper.sh execs (see tenant-stack.ts container `command`),
# which is a narrower environment than an interactive shell: relying on
# PATH already containing the Python venv's bin/ (normally set up by
# main-wrapper.sh's own `. /opt/hermes/.venv/bin/activate` before it execs
# argv[0]) turned out not to carry through reliably when argv[0] was `sh`
# instead of a bare executable name — that attempt failed boot with exit
# 127. Spelling out the venv's absolute paths here removes that dependency
# entirely, regardless of which invocation path the wrapper takes.
_START_SCRIPT = """#!/bin/sh
# hermes-line-cdk managed — regenerated by write-tenant-config on every deploy.
/opt/hermes/.venv/bin/python -c "from tools.browser_tool import warm_agent_browser_npx_cache; warm_agent_browser_npx_cache(timeout=90)" >&2 || true
# `gateway` is a subcommand of the `hermes` CLI, not its own executable —
# there is no .venv/bin/gateway. The working `command: ["gateway", "run",
# "-vv"]` this replaces never ran a "gateway" binary at all: main-wrapper.sh's
# `command -v "$1"` check fails for it too, so it fell through to that
# script's own "Hermes subcommand pass-through" branch (`drop hermes "$@"`),
# i.e. it was always really running `hermes gateway run -vv`. Confirmed via
# `which hermes` -> /opt/hermes/.venv/bin/hermes on the live container.
exec /opt/hermes/.venv/bin/hermes gateway run -vv
"""


def _write_start_script() -> None:
    """Warm the agent-browser npx cache before the gateway ever starts.

    agent-browser isn't baked into the image; Hermes resolves it lazily via
    `npx agent-browser` on the FIRST real browser_* tool call — a cold
    registry-fetch + install that can outrun the 120s first-open timeout on
    this task's modest CPU (observed: "chrome-not-running: ... none could
    be launched" on every browser tool call). Doing that fetch once here,
    at boot, inside the health-check grace period, means a user's/cron
    job's first browser call hits an already-warm cache instead.
    """
    tmp_path = START_SCRIPT_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(_START_SCRIPT)
    os.chmod(tmp_path, 0o755)
    os.replace(tmp_path, START_SCRIPT_PATH)


def _wipe_everything() -> None:
    """Nuke this tenant's whole EFS directory and start over empty.

    Manual escape hatch (props.WipeAll == "true", set only via an explicit
    CDK context flag — see tenant-stack.ts) for when the accumulated state
    from many prior failed deploys is itself suspect and worth ruling out
    entirely, rather than trying to reason about what's still in there.
    Recreating a tenant's stack does NOT do this on its own: the access
    point is a new resource, but it points at the same underlying path on
    the EFS filesystem in HermesShared, which was never deleted.
    """
    for entry in os.listdir(EFS_ROOT):
        path = os.path.join(EFS_ROOT, entry)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.remove(path)
    print("wiped tenant EFS directory clean")


def handler(event, context):
    request_type = event["RequestType"]
    physical_id = event.get("PhysicalResourceId") or f"config-yaml-{event['LogicalResourceId']}"

    if request_type in ("Create", "Update"):
        props = event["ResourceProperties"]
        if props.get("WipeAll") == "true":
            _wipe_everything()
        _quarantine_corrupt_state_db()
        _write_config(props["ModelProvider"], props["ModelDefault"], props["BrowserBackend"])
        _write_start_script()

    # Delete: leave config.yaml in place. It holds tenant data (and this
    # resource only owns one block within it), same RETAIN-on-teardown
    # posture as the EFS FileSystem itself elsewhere in this stack.

    return {"PhysicalResourceId": physical_id}
