"""CloudFormation custom resource: writes/updates the ``model:`` section of a
tenant's Hermes ``config.yaml`` on EFS.

Why this exists: everything else in this deployment is env-var driven, but
Hermes's gateway reads its default model *exclusively* from config.yaml
(``gateway/run.py::_resolve_gateway_model`` — "Read model from config.yaml
— single source of truth", no env var fallback). Without this file, Hermes
falls back to the packaged example config's default
(``anthropic/claude-opus-4.6``), which isn't a valid Bedrock model ID and
every turn fails with "the model provider failed after retries."

Idempotent + non-destructive: the managed block is wrapped in sentinel
comments so re-running this (e.g. after tenants.json changes the model)
only touches that block, never anything else a human or Hermes itself adds
to config.yaml over time.
"""

import os
import re

EFS_ROOT = "/mnt/efs"
CONFIG_PATH = os.path.join(EFS_ROOT, "config.yaml")

BEGIN_MARKER = "# --- hermes-line-cdk managed: model (do not edit between markers) ---"
END_MARKER = "# --- end hermes-line-cdk managed block ---"


def _managed_block(provider: str, default_model: str) -> str:
    return (
        f"{BEGIN_MARKER}\n"
        f"model:\n"
        f'  provider: "{provider}"\n'
        f'  default: "{default_model}"\n'
        f"{END_MARKER}\n"
    )


def _write_config(provider: str, default_model: str) -> None:
    block = _managed_block(provider, default_model)
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


def handler(event, context):
    request_type = event["RequestType"]
    physical_id = event.get("PhysicalResourceId") or f"config-yaml-{event['LogicalResourceId']}"

    if request_type in ("Create", "Update"):
        props = event["ResourceProperties"]
        _write_config(props["ModelProvider"], props["ModelDefault"])

    # Delete: leave config.yaml in place. It holds tenant data (and this
    # resource only owns one block within it), same RETAIN-on-teardown
    # posture as the EFS FileSystem itself elsewhere in this stack.

    return {"PhysicalResourceId": physical_id}
