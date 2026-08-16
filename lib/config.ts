import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Per-tenant config. Secrets (LINE channel secret / access token) are NOT
 * stored here — they live in SSM Parameter Store under a path derived from
 * `id` (see `scripts/set-tenant-secret.sh`), and CDK only references them.
 */
export interface TenantConfig {
  /** DNS/path-safe identifier, e.g. "family". Used in ALB path routing,
   *  EFS access point path, SSM parameter path, IAM role name. */
  id: string;
  displayName: string;
  /** Danger: opens the bot to any LINE user. Default false. */
  lineAllowAllUsers?: boolean;
  lineAllowedUsers?: string[];
  lineAllowedGroups?: string[];
  lineAllowedRooms?: string[];
  /** LINE userId that gets the monthly usage report pushed to it. */
  adminLineUserId?: string;
  /** Informational only (shown in the monthly report) — not enforced inline. */
  monthlyBudgetUsd?: number;
  /** Bedrock model IDs this tenant's Task Role may invoke. Falls back to
   *  `defaultBedrockModelIds` when omitted. */
  bedrockModelIds?: string[];
}

export interface HermesAppConfig {
  account: string;
  region: string;
  /** Domain the ALB gets exposed under, e.g. "hermes.example.com". */
  domainName: string;
  /** Route53 hosted zone for `domainName`. Omit if managing DNS externally
   *  (in which case set `certificateArn` instead and create the CNAME by hand). */
  hostedZoneId?: string;
  hostedZoneName?: string;
  /** Pre-issued ACM certificate ARN — alternative to Route53-validated cert. */
  certificateArn?: string;
  /** Notification target for the AWS Budgets alarm. */
  alertEmailAddress: string;
  monthlyBudgetUsd: number;
  defaultBedrockModelIds: string[];
  /** Docker Hub tag for nousresearch/hermes-agent, e.g. "latest" or a pinned release. */
  hermesImageTag: string;
  tenants: TenantConfig[];
}

const CONFIG_PATH = path.join(__dirname, "..", "tenants.json");
const EXAMPLE_CONFIG_PATH = path.join(__dirname, "..", "tenants.example.json");

export function loadConfig(): HermesAppConfig {
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No tenants.json found. Copy tenants.example.json to tenants.json and fill in your values.`
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as HermesAppConfig;
  validateConfig(config);
  return config;
}

function validateConfig(config: HermesAppConfig): void {
  if (!config.account) throw new Error("tenants.json: `account` is required");
  if (!config.region) throw new Error("tenants.json: `region` is required");
  if (!config.domainName) throw new Error("tenants.json: `domainName` is required");
  if (!config.alertEmailAddress) {
    throw new Error("tenants.json: `alertEmailAddress` is required (AWS Budgets notifications)");
  }
  if (!config.hermesImageTag) throw new Error("tenants.json: `hermesImageTag` is required");
  if (!config.tenants || config.tenants.length === 0) {
    throw new Error("tenants.json: `tenants` must contain at least one tenant");
  }

  const idPattern = /^[a-z0-9-]{1,32}$/;
  const seen = new Set<string>();
  for (const tenant of config.tenants) {
    if (!idPattern.test(tenant.id)) {
      throw new Error(
        `tenants.json: tenant id "${tenant.id}" must be lowercase alphanumeric/hyphen, max 32 chars ` +
          `(used in ALB paths, EFS paths, IAM role names, SSM paths)`
      );
    }
    if (seen.has(tenant.id)) {
      throw new Error(`tenants.json: duplicate tenant id "${tenant.id}"`);
    }
    seen.add(tenant.id);
  }
}

/** SSM parameter path holding this tenant's LINE channel secret (SecureString). */
export function lineChannelSecretParamName(tenantId: string): string {
  return `/hermes/${tenantId}/line/channel-secret`;
}

/** SSM parameter path holding this tenant's LINE channel access token (SecureString). */
export function lineChannelAccessTokenParamName(tenantId: string): string {
  return `/hermes/${tenantId}/line/channel-access-token`;
}
