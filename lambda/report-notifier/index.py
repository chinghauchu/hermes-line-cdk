"""Pushes the monthly usage summary to each tenant's admin LINE user.

Triggered by an S3 ObjectCreated event on reports/{period}/summary.json
(written by usage-aggregator). Deliberately NOT VPC-attached — it needs
the public internet to reach LINE's API and has no reason to touch EFS.
"""

import json
import os
import urllib.request

import boto3

BUCKET_NAME = os.environ["BUCKET_NAME"]
TENANTS = {t["id"]: t for t in json.loads(os.environ["TENANTS_JSON"])}

s3 = boto3.client("s3")
ssm = boto3.client("ssm")

LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"


def _channel_access_token(tenant_id: str) -> str:
    param = ssm.get_parameter(
        Name=f"/hermes/{tenant_id}/line/channel-access-token",
        WithDecryption=True,
    )
    return param["Parameter"]["Value"]


def _format_message(display_name: str, period: str, usage: dict) -> str:
    return (
        f"📊 {display_name} — {period} usage report\n"
        f"API calls: {usage['api_call_count']}\n"
        f"Input tokens: {usage['input_tokens']:,}\n"
        f"Output tokens: {usage['output_tokens']:,}\n"
        f"Estimated cost: ${usage['estimated_cost_usd']:.2f}"
    )


def _push_line_message(access_token: str, to_user_id: str, text: str) -> None:
    body = json.dumps({"to": to_user_id, "messages": [{"type": "text", "text": text}]}).encode("utf-8")
    req = urllib.request.Request(
        LINE_PUSH_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        },
    )
    with urllib.request.urlopen(req) as resp:
        resp.read()


def handler(event, context):
    for record in event["Records"]:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
        obj = s3.get_object(Bucket=bucket, Key=key)
        summary = json.loads(obj["Body"].read())
        period = summary["period"]

        for usage in summary["tenants"]:
            tenant = TENANTS.get(usage["id"])
            if not tenant or not tenant.get("adminLineUserId"):
                continue
            text = _format_message(tenant["displayName"], period, usage)
            token = _channel_access_token(tenant["id"])
            _push_line_message(token, tenant["adminLineUserId"], text)
            print(f"pushed usage report to tenant={tenant['id']}")
