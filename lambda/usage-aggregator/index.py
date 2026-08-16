"""Monthly usage aggregator.

Runs inside the VPC with the shared EFS filesystem mounted read-only (via
the "admin" access point rooted at /tenants — see SharedStack). For each
tenant, reads its Hermes state.db directly (this is the same SQLite file
the tenant's own Fargate task writes to — see hermes_state_schema.py's
session_model_usage table) and aggregates last month's token usage / cost.

Writes one CSV per tenant plus a combined summary.json. The summary.json
write is what triggers report-notifier (S3 ObjectCreated notification).
"""

import csv
import io
import json
import os
import sqlite3
from datetime import datetime, timezone

import boto3

EFS_ROOT = "/mnt/efs"
BUCKET_NAME = os.environ["BUCKET_NAME"]
TENANT_IDS = json.loads(os.environ["TENANT_IDS"])

s3 = boto3.client("s3")


def _previous_month_range(now: datetime) -> tuple[datetime, datetime, str]:
    first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if first_of_this_month.month == 1:
        period_start = first_of_this_month.replace(year=first_of_this_month.year - 1, month=12)
    else:
        period_start = first_of_this_month.replace(month=first_of_this_month.month - 1)
    return period_start, first_of_this_month, period_start.strftime("%Y-%m")


def _aggregate_tenant(tenant_id: str, start_ts: float, end_ts: float) -> list[dict] | None:
    db_path = os.path.join(EFS_ROOT, tenant_id, "state.db")
    if not os.path.exists(db_path):
        print(f"skip {tenant_id}: no state.db yet (never started?)")
        return None

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            """
            SELECT model,
                   SUM(api_call_count)     AS api_call_count,
                   SUM(input_tokens)       AS input_tokens,
                   SUM(output_tokens)      AS output_tokens,
                   SUM(cache_read_tokens)  AS cache_read_tokens,
                   SUM(cache_write_tokens) AS cache_write_tokens,
                   SUM(estimated_cost_usd) AS estimated_cost_usd,
                   SUM(actual_cost_usd)    AS actual_cost_usd
            FROM session_model_usage
            WHERE last_seen >= ? AND last_seen < ?
            GROUP BY model
            ORDER BY model
            """,
            (start_ts, end_ts),
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "model": r[0],
            "api_call_count": r[1] or 0,
            "input_tokens": r[2] or 0,
            "output_tokens": r[3] or 0,
            "cache_read_tokens": r[4] or 0,
            "cache_write_tokens": r[5] or 0,
            "estimated_cost_usd": r[6] or 0.0,
            "actual_cost_usd": r[7] or 0.0,
        }
        for r in rows
    ]


def _write_tenant_csv(tenant_id: str, period_label: str, rows: list[dict]) -> None:
    buf = io.StringIO()
    writer = csv.DictWriter(
        buf,
        fieldnames=[
            "model",
            "api_call_count",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "estimated_cost_usd",
            "actual_cost_usd",
        ],
    )
    writer.writeheader()
    writer.writerows(rows)
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=f"reports/{tenant_id}/{period_label}.csv",
        Body=buf.getvalue().encode("utf-8"),
        ContentType="text/csv",
    )


def handler(event, context):
    now = datetime.now(timezone.utc)
    start, end, period_label = _previous_month_range(now)
    start_ts, end_ts = start.timestamp(), end.timestamp()

    summary = {"period": period_label, "tenants": []}

    for tenant_id in TENANT_IDS:
        rows = _aggregate_tenant(tenant_id, start_ts, end_ts)
        if rows is None:
            continue
        _write_tenant_csv(tenant_id, period_label, rows)
        summary["tenants"].append(
            {
                "id": tenant_id,
                "api_call_count": sum(r["api_call_count"] for r in rows),
                "input_tokens": sum(r["input_tokens"] for r in rows),
                "output_tokens": sum(r["output_tokens"] for r in rows),
                "estimated_cost_usd": round(sum(r["estimated_cost_usd"] for r in rows), 4),
                "actual_cost_usd": round(sum(r["actual_cost_usd"] for r in rows), 4),
            }
        )

    # This write is what triggers report-notifier — must be last.
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=f"reports/{period_label}/summary.json",
        Body=json.dumps(summary).encode("utf-8"),
        ContentType="application/json",
    )
    return summary
