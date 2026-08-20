# hermes-line-cdk

AWS CDK deployment of [Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research, MIT-licensed) as a multi-tenant LINE bot platform — one isolated Fargate service per LINE Official Account, Bedrock as the LLM backend, EFS for Hermes's own state, S3 for backups/reports, and a monthly per-tenant usage report pushed back to LINE.

Full design rationale (including the source-code facts this is based on) is in [`docs/DESIGN.md`](docs/DESIGN.md). Step-by-step LINE setup is in [`docs/LINE_INTEGRATION.md`](docs/LINE_INTEGRATION.md).

## Why this exists

Hermes Agent normally runs on your own machine. This project deploys it to your own AWS account instead, so that:

- Users never need to download or run anything locally — they just talk to a LINE Official Account
- It's reachable through LINE, the messaging app most people in Taiwan already use daily
- It runs on Amazon Bedrock instead of a third-party AI API — no separate AI platform subscription to manage, and models can be swapped per tenant in seconds
- Onboarding a new persona/tenant is a few lines in `tenants.json`, not a code change or a new deployment pipeline

## AWS services used

| Service | Role in this project |
|---|---|
| **Amazon ECS (Fargate)** | Runs one isolated container per tenant, straight off the official Hermes Agent image — no servers to patch or manage. Sized at 1 vCPU / 2GB, not the Fargate minimum — Hermes's browser tools run a real headless Chromium locally (not a remote/managed browser service), and rendering a JS-heavy page competes for the same CPU as the gateway's own web server; at the Fargate minimum (0.25 vCPU) a real page load starved the health-check endpoint enough that ECS killed the task mid-task |
| **Amazon Bedrock** | The LLM backend. Invoked directly via the task's IAM role (no API keys to store/rotate), and the model list is configurable per tenant in `tenants.json` |
| **Amazon EFS** | Persistent storage for each tenant's Hermes state — `config.yaml`, conversation history (SQLite), skills. One access point per tenant keeps tenants isolated from each other |
| **Amazon S3** | Daily per-tenant EFS backups, plus the monthly usage-report CSVs |
| **Application Load Balancer (ALB)** | Public HTTPS entrypoint; routes each request to the right tenant by subdomain (Host header) |
| **AWS WAF** | Rate-based rule on the ALB that blocks a single IP flooding the endpoint, before it can run up the bill |
| **Amazon Route 53** | One wildcard DNS record (`*.domain`) pointing at the ALB — onboarding a tenant never touches DNS |
| **AWS Certificate Manager (ACM)** | Wildcard TLS certificate for the domain, validated automatically via Route 53 |
| **AWS IAM** | A scoped role per tenant — limited to only that tenant's EFS access point, S3 prefix, and allow-listed Bedrock models. This is what actually enforces tenant isolation |
| **AWS Systems Manager Parameter Store** | Stores each tenant's LINE channel secret and access token as `SecureString` parameters |
| **AWS Lambda** | Four small functions: seed/update each tenant's `config.yaml` before its service starts, aggregate monthly token usage off EFS, push the usage report to LINE, and back up EFS to S3 daily |
| **Amazon EventBridge** | Cron triggers for the daily backup and monthly report Lambdas |
| **Amazon CloudWatch Logs** | Container and Lambda logs (retained, so a failed deploy's forensics survive a rollback) |
| **AWS Budgets** | A monthly cost alarm scoped to this project's tagged resources, so a runaway bug can't blow up your AWS bill unnoticed |
| **Amazon VPC** | Networking foundation — public subnets only, no NAT Gateway, to keep the always-on cost near zero |
| **AWS CloudFormation** (via AWS CDK) | The whole stack — shared infra plus every tenant — is defined as code and deployed/torn down as a unit |

## Architecture, in one line per layer

- **Ingress**: Route53 wildcard record → ALB (WAF rate-limit rule attached) → per-tenant target group, routed by subdomain (`{tenantId}.{domainName}`)
- **Compute**: one ECS Fargate service per tenant (1 vCPU / 2GB — sized for local headless-Chromium browser automation, not just chat; see the services table below), running the official `nousresearch/hermes-agent` Docker Hub image unmodified
- **LLM**: Amazon Bedrock, invoked directly via the container's IAM task role — no API keys
- **Storage**: EFS (one access point per tenant) for Hermes's live state; S3 for daily EFS backups and monthly report CSVs
- **Reporting**: monthly Lambda reads each tenant's `session_model_usage` SQLite table straight off EFS, writes a summary to S3, which triggers a second (non-VPC) Lambda that pushes the report to each tenant's admin LINE user

## Getting started

```bash
npm install
cp tenants.example.json tenants.json   # fill in your account, domain, and first tenant
npx cdk synth                          # validate locally, no AWS calls needed
```

Before your first real deploy, see the prerequisites checklist in `docs/DESIGN.md` section 5a (domain/ACM, Bedrock model access, AWS account) and the per-tenant onboarding steps in `docs/LINE_INTEGRATION.md`.

```bash
npx cdk bootstrap        # once per account/region
npx cdk deploy HermesShared
./scripts/set-tenant-secret.sh <tenant-id>   # per tenant, before deploying it
npx cdk deploy HermesTenant-<tenant-id>
```

## Useful commands

- `npm run build` — compile TypeScript
- `npx jest` — run the CDK assertion tests (`test/hermes.test.ts`)
- `npx cdk synth` — synthesize CloudFormation without deploying
- `npx cdk diff` — compare deployed stacks against local changes
