import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput, Tags } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { HermesAppConfig, lineChannelAccessTokenParamName } from "./config";

/**
 * Shared, account-wide resources: networking, the ECS cluster, the EFS
 * filesystem all tenants live on, the S3 backup/report bucket, the public
 * ALB (+ WAF), and the two reporting Lambdas. `TenantStack` instances
 * (one per LINE tenant) attach onto these.
 */
export class SharedStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly fileSystem: efs.FileSystem;
  public readonly bucket: s3.Bucket;
  public readonly httpsListener: elbv2.ApplicationListener;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly fargateSecurityGroup: ec2.SecurityGroup;
  public readonly efsSecurityGroup: ec2.SecurityGroup;
  public readonly config: HermesAppConfig;

  // All Hermes containers and EFS access points share this POSIX identity.
  // Tenant isolation comes from each access point's root path being scoped
  // to /tenants/{tenantId}, not from differing uid/gid.
  public static readonly HERMES_UID = "10000";
  public static readonly HERMES_GID = "10000";
  public static readonly LINE_PORT = 8646;

  constructor(scope: Construct, id: string, config: HermesAppConfig, props?: StackProps) {
    super(scope, id, props);
    this.config = config;
    Tags.of(this).add("Project", "hermes-line");

    // ---- Networking -----------------------------------------------------
    // Public subnets only, no NAT Gateway: Fargate tasks need internet
    // egress to pull the image from Docker Hub (not an AWS service, so no
    // VPC endpoint exists for it) and to call Bedrock/SSM; a NAT Gateway
    // costs ~$32/mo which isn't worth it for a small deployment when a
    // public IP + tight security group achieves the same inbound safety.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      // maxAzs (not an explicit availabilityZones list): AWS assigns AZ
      // letters (a/b/c/d...) to physical datacenters differently per
      // account, so a hardcoded "<region>a/<region>b" guess can name an AZ
      // that doesn't exist for this account (this is exactly what broke
      // ap-northeast-1: this account has 1a/1c/1d, not 1b). maxAzs makes
      // CDK look up the real list for the target account/region at synth
      // time and cache it in cdk.context.json — needs live credentials for
      // the real account, which is fine now that we're past local/fake-
      // account validation.
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      // Free Gateway endpoint — lets the (public-subnet, no-NAT) reporting/
      // backup Lambdas reach S3 without needing internet egress.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Hermes ALB - public HTTPS",
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS from internet");
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), "HTTPS from internet (IPv6)");

    this.fargateSecurityGroup = new ec2.SecurityGroup(this, "FargateSecurityGroup", {
      vpc: this.vpc,
      description: "Hermes gateway tasks - one per tenant, all share this SG",
      allowAllOutbound: true,
    });
    this.fargateSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(SharedStack.LINE_PORT),
      "LINE webhook from ALB"
    );

    // ---- EFS ---------------------------------------------------------
    this.fileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc: this.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      // Family conversation history is not something to lose by accident;
      // `cdk destroy` will leave this filesystem behind. Delete by hand
      // once you're sure.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.efsSecurityGroup = this.fileSystem.connections.securityGroups[0] as ec2.SecurityGroup;
    this.fileSystem.connections.allowFrom(this.fargateSecurityGroup, ec2.Port.tcp(2049), "NFS from Hermes tasks");

    // Root-scoped access point used only by our own reporting/backup
    // Lambdas (see below) — never handed to a tenant's Task Role. Same
    // uid/gid as every tenant access point, so it can read across all of
    // them by ordinary POSIX permissions.
    const adminAccessPoint = this.fileSystem.addAccessPoint("AdminAccessPoint", {
      path: "/tenants",
      createAcl: { ownerUid: SharedStack.HERMES_UID, ownerGid: SharedStack.HERMES_GID, permissions: "755" },
      posixUser: { uid: SharedStack.HERMES_UID, gid: SharedStack.HERMES_GID },
    });

    // ---- S3 ------------------------------------------------------------
    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "transition-old-backups",
          transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) }],
        },
      ],
    });

    // ---- ECS -------------------------------------------------------------
    this.cluster = new ecs.Cluster(this, "Cluster", { vpc: this.vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED });

    // ---- ALB + ACM ---------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup,
    });

    // Each tenant lives at {tenantId}.{domainName} — Hermes's LINE adapter
    // listens on a fixed path (`/line/webhook`) that isn't parameterizable
    // per tenant via env vars, so tenants are told apart by subdomain
    // (Host header), not by URL path. A wildcard cert + wildcard alias
    // record means onboarding a new tenant never touches DNS/ACM — only
    // the ALB listener rule and Fargate service (see TenantStack).
    let certificate: acm.ICertificate;
    let hostedZone: route53.IHostedZone | undefined;
    if (config.hostedZoneId) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName ?? config.domainName,
      });
      certificate = new acm.Certificate(this, "Certificate", {
        domainName: config.domainName,
        subjectAlternativeNames: [`*.${config.domainName}`],
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
      new route53.ARecord(this, "WildcardAliasRecord", {
        zone: hostedZone,
        recordName: `*.${config.domainName}`,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      });
    } else if (config.certificateArn) {
      // Externally-managed DNS: the cert (covering *.domainName) and the
      // wildcard CNAME/ALIAS to the ALB's DNS name are your responsibility.
      certificate = acm.Certificate.fromCertificateArn(this, "Certificate", config.certificateArn);
    } else {
      throw new Error("tenants.json: provide either hostedZoneId (Route53) or certificateArn (external DNS)");
    }

    this.httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Not found",
      }),
    });

    // ---- WAF -------------------------------------------------------------
    // Rate-based rule: blocks a single IP once it crosses the threshold in
    // a rolling 5-minute window. This is about protecting the AWS bill
    // from a flood of junk requests, not authenticating LINE — that's the
    // HMAC signature check Hermes already does internally.
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "HermesWebAcl",
      },
      rules: [
        {
          name: "RateLimit",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 300,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "HermesRateLimit",
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ---- Budget ------------------------------------------------------
    // Scoped to resources tagged Project=hermes-line so it doesn't alarm
    // on spend from anything else in this AWS account.
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
        costFilters: { TagKeyValue: ["user:Project$hermes-line"] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: config.alertEmailAddress }],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: config.alertEmailAddress }],
        },
      ],
    });

    // ---- Reporting: usage aggregator (VPC + EFS, no internet) -----------
    // Reads each tenant's local session_model_usage table straight off
    // EFS and writes CSVs + one summary.json to S3. Deliberately has no
    // path to the public internet (public subnet, no NAT) — it doesn't
    // need one, and this keeps its blast radius small.
    const aggregatorFn = new lambda.Function(this, "UsageAggregatorFn", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/usage-aggregator"),
      timeout: Duration.minutes(5),
      memorySize: 512,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // No NAT Gateway in this VPC (see networking comment above) — this
      // function only needs EFS (in-VPC) and S3 (free gateway endpoint),
      // never the open internet, so a public subnet without a public IP
      // path out is fine. CDK just wants that acknowledged explicitly.
      allowPublicSubnet: true,
      filesystem: lambda.FileSystem.fromEfsAccessPoint(adminAccessPoint, "/mnt/efs"),
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        TENANT_IDS: JSON.stringify(config.tenants.map((t) => t.id)),
      },
      logGroup: new logs.LogGroup(this, "UsageAggregatorLogGroup", { retention: logs.RetentionDays.ONE_MONTH }),
    });
    this.bucket.grantWrite(aggregatorFn, "reports/*");
    aggregatorFn.connections.allowTo(this.fileSystem, ec2.Port.tcp(2049));

    // ---- Reporting: notifier (no VPC — needs the internet for LINE) ----
    const notifierFn = new lambda.Function(this, "ReportNotifierFn", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/report-notifier"),
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        TENANTS_JSON: JSON.stringify(
          config.tenants.map((t) => ({ id: t.id, displayName: t.displayName, adminLineUserId: t.adminLineUserId ?? "" }))
        ),
      },
      logGroup: new logs.LogGroup(this, "ReportNotifierLogGroup", { retention: logs.RetentionDays.ONE_MONTH }),
    });
    this.bucket.grantRead(notifierFn, "reports/*");
    notifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: config.tenants.map(
          (t) => `arn:aws:ssm:${this.region}:${this.account}:parameter${lineChannelAccessTokenParamName(t.id)}`
        ),
      })
    );
    this.bucket.addObjectCreatedNotification(new s3n.LambdaDestination(notifierFn), {
      prefix: "reports/",
      suffix: "summary.json",
    });

    // Monthly, 1st of the month — triggers the aggregator; it writes
    // summary.json, whose S3 event then triggers the notifier.
    new events.Rule(this, "MonthlyReportRule", {
      schedule: events.Schedule.cron({ day: "1", hour: "1", minute: "0" }),
      targets: [new eventTargets.LambdaFunction(aggregatorFn)],
    });

    // ---- Backup: EFS -> S3, daily (VPC + EFS, no internet needed) -----
    const backupFn = new lambda.Function(this, "EfsBackupFn", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/efs-backup"),
      timeout: Duration.minutes(10),
      memorySize: 512,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true, // same rationale as UsageAggregatorFn above
      filesystem: lambda.FileSystem.fromEfsAccessPoint(adminAccessPoint, "/mnt/efs"),
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        TENANT_IDS: JSON.stringify(config.tenants.map((t) => t.id)),
      },
      logGroup: new logs.LogGroup(this, "EfsBackupLogGroup", { retention: logs.RetentionDays.ONE_MONTH }),
    });
    this.bucket.grantWrite(backupFn, "tenants/*");
    backupFn.connections.allowTo(this.fileSystem, ec2.Port.tcp(2049));

    new events.Rule(this, "DailyBackupRule", {
      schedule: events.Schedule.cron({ hour: "3", minute: "0" }),
      targets: [new eventTargets.LambdaFunction(backupFn)],
    });

    // ---- Outputs -----------------------------------------------------
    // Per-tenant webhook URLs are output from TenantStack, not here — each
    // tenant lives at its own subdomain (see the cert/DNS comment above).
    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
  }
}
