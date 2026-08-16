import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { HermesAppConfig } from "../lib/config";
import { SharedStack } from "../lib/shared-stack";
import { TenantStack } from "../lib/tenant-stack";

const testConfig: HermesAppConfig = {
  account: "123456789012",
  region: "us-east-1",
  domainName: "hermes.example.com",
  hostedZoneId: "Z0123456789ABCDEFGHIJ",
  hostedZoneName: "example.com",
  alertEmailAddress: "ops@example.com",
  monthlyBudgetUsd: 50,
  defaultBedrockModelIds: ["anthropic.claude-sonnet-4-5-20250929-v1:0"],
  hermesImageTag: "latest",
  tenants: [
    {
      id: "family",
      displayName: "Family Bot",
      lineAllowAllUsers: false,
      lineAllowedUsers: ["U1234"],
      adminLineUserId: "U1234",
      monthlyBudgetUsd: 10,
    },
  ],
};

function buildStacks() {
  const app = new App();
  const env = { account: testConfig.account, region: testConfig.region };
  const shared = new SharedStack(app, "TestShared", testConfig, { env });
  const tenant = new TenantStack(app, "TestTenant-family", {
    env,
    tenant: testConfig.tenants[0],
    appConfig: testConfig,
    shared,
    listenerRulePriority: 100,
  });
  return { shared: Template.fromStack(shared), tenant: Template.fromStack(tenant) };
}

describe("SharedStack", () => {
  const { shared } = buildStacks();

  test("S3 bucket blocks all public access and enforces SSL", () => {
    shared.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    shared.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      }),
    });
  });

  test("ALB listener is HTTPS-only on 443", () => {
    shared.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
    });
  });

  test("WAF WebACL with a rate-based rule is attached to the ALB", () => {
    shared.resourceCountIs("AWS::WAFv2::WebACL", 1);
    shared.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: "IP" }) },
        }),
      ]),
    });
    shared.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });

  test("EFS filesystem is encrypted", () => {
    shared.hasResourceProperties("AWS::EFS::FileSystem", { Encrypted: true });
  });

  test("no NAT gateway (public-subnet, egress-cost-conscious networking)", () => {
    shared.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  test("EventBridge has both the daily backup and monthly report rules", () => {
    shared.resourceCountIs("AWS::Events::Rule", 2);
  });

  test("account-wide budget alarm is scoped to the hermes-line project tag", () => {
    shared.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        CostFilters: { TagKeyValue: ["user:Project$hermes-line"] },
      }),
    });
  });
});

describe("TenantStack", () => {
  const { tenant } = buildStacks();

  test("Fargate task runs the official Hermes image on the LINE port", () => {
    tenant.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: "nousresearch/hermes-agent:latest",
          PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 8646 })]),
        }),
      ]),
    });
  });

  test("closed by default: LINE_ALLOW_ALL_USERS is false unless overridden", () => {
    tenant.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: "LINE_ALLOW_ALL_USERS", Value: "false" }]),
        }),
      ]),
    });
  });

  test("LINE channel secret/token are injected as ECS secrets, not plain env vars", () => {
    tenant.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: "LINE_CHANNEL_SECRET" }),
            Match.objectLike({ Name: "LINE_CHANNEL_ACCESS_TOKEN" }),
          ]),
        }),
      ]),
    });
  });

  test("task role is scoped to only this tenant's EFS access point", () => {
    tenant.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]),
            Condition: { StringEquals: Match.objectLike({ "elasticfilesystem:AccessPointArn": Match.anyValue() }) },
          }),
        ]),
      }),
    });
  });

  test("ALB listener rule routes the tenant's subdomain by Host header", () => {
    tenant.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: Match.arrayWith([
        Match.objectLike({ Field: "host-header", HostHeaderConfig: { Values: ["family.hermes.example.com"] } }),
      ]),
    });
  });

  test("health check targets the LINE adapter's built-in health endpoint", () => {
    tenant.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/line/webhook/health",
    });
  });
});
