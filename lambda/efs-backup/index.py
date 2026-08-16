"""Daily EFS -> S3 backup.

Runs inside the VPC with the shared EFS filesystem mounted (admin access
point rooted at /tenants). Walks each tenant's directory (config.yaml,
state.db, skills/, ...) and uploads it to
s3://{bucket}/tenants/{tenantId}/backup/... — this is what satisfies
"files land in S3" without making S3 Hermes's live working storage (it
needs a real filesystem, which is what EFS is for).
"""

import os
import json

import boto3

EFS_ROOT = "/mnt/efs"
BUCKET_NAME = os.environ["BUCKET_NAME"]
TENANT_IDS = json.loads(os.environ["TENANT_IDS"])

s3 = boto3.client("s3")


def _backup_tenant(tenant_id: str) -> int:
    tenant_root = os.path.join(EFS_ROOT, tenant_id)
    if not os.path.isdir(tenant_root):
        print(f"skip {tenant_id}: no data yet")
        return 0

    uploaded = 0
    for dirpath, _dirnames, filenames in os.walk(tenant_root):
        for filename in filenames:
            local_path = os.path.join(dirpath, filename)
            relative_path = os.path.relpath(local_path, tenant_root)
            key = f"tenants/{tenant_id}/backup/{relative_path}"
            s3.upload_file(local_path, BUCKET_NAME, key)
            uploaded += 1
    return uploaded


def handler(event, context):
    results = {tenant_id: _backup_tenant(tenant_id) for tenant_id in TENANT_IDS}
    print(f"backup complete: {results}")
    return results
