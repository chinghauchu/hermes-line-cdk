# hermes-line-cdk

AWS CDK deployment of [Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research, MIT-licensed) as a multi-tenant LINE bot platform — one isolated Fargate service per LINE Official Account, Bedrock as the LLM backend, EFS for Hermes's own state, S3 for backups/reports, and a monthly per-tenant usage report pushed back to LINE.

Full design rationale (including the source-code facts this is based on) is in [`docs/DESIGN.md`](docs/DESIGN.md). Step-by-step LINE setup is in [`docs/LINE_INTEGRATION.md`](docs/LINE_INTEGRATION.md).

## Architecture, in one line per layer

- **Ingress**: Route53 wildcard record → ALB (WAF rate-limit rule attached) → per-tenant target group, routed by subdomain (`{tenantId}.{domainName}`)
- **Compute**: one ECS Fargate service per tenant, running the official `nousresearch/hermes-agent` Docker Hub image unmodified
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
