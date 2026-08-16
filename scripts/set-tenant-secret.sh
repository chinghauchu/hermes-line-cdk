#!/usr/bin/env bash
# Writes a tenant's LINE channel secret + access token into SSM Parameter
# Store as SecureStrings, at the path convention lib/config.ts's
# lineChannelSecretParamName()/lineChannelAccessTokenParamName() expect.
#
# Deliberately NOT run by CDK — secret values never belong in tenants.json
# or in a CloudFormation template. Run this once per tenant before
# `cdk deploy HermesTenant-<id>` (the deploy will fail to resolve the
# ecs.Secret references otherwise).
#
# Usage: ./scripts/set-tenant-secret.sh <tenant-id>
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <tenant-id>" >&2
  exit 1
fi

TENANT_ID="$1"
REGION="${AWS_REGION:-$(node -pe "require('./tenants.json').region")}"

read -rsp "LINE channel secret for '${TENANT_ID}': " CHANNEL_SECRET
echo
read -rsp "LINE channel access token for '${TENANT_ID}': " CHANNEL_ACCESS_TOKEN
echo

aws ssm put-parameter \
  --region "$REGION" \
  --name "/hermes/${TENANT_ID}/line/channel-secret" \
  --type SecureString \
  --value "$CHANNEL_SECRET" \
  --overwrite

aws ssm put-parameter \
  --region "$REGION" \
  --name "/hermes/${TENANT_ID}/line/channel-access-token" \
  --type SecureString \
  --value "$CHANNEL_ACCESS_TOKEN" \
  --overwrite

echo "Stored secrets for tenant '${TENANT_ID}' in SSM (region ${REGION})."
