import { Stack, StackProps, RemovalPolicy, CfnOutput, Tags, CustomResource, Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { HermesAppConfig, TenantConfig, lineChannelSecretParamName, lineChannelAccessTokenParamName } from "./config";
import { SharedStack } from "./shared-stack";

export interface TenantStackProps extends StackProps {
  tenant: TenantConfig;
  appConfig: HermesAppConfig;
  shared: SharedStack;
  /** ALB listener rules need a unique priority per tenant. */
  listenerRulePriority: number;
}

/**
 * Everything specific to one LINE tenant: its own EFS access point, IAM
 * task role (scoped to only this tenant's S3 prefix / EFS path / allowed
 * Bedrock models), Fargate service running the official Hermes image, and
 * an ALB host-based routing rule for {tenantId}.{domainName}.
 */
export class TenantStack extends Stack {
  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);
    const { tenant, appConfig, shared, listenerRulePriority } = props;
    Tags.of(this).add("Project", "hermes-line");
    Tags.of(this).add("Tenant", tenant.id);

    // ---- EFS access point, scoped to this tenant's own subtree ----------
    // Constructed with `this` (TenantStack) as scope, not via
    // `shared.fileSystem.addAccessPoint()` — that would parent the access
    // point under the file system construct, which lives in HermesShared,
    // so every tenant's access point would physically live in the shared
    // template and every onboarding would touch it. Passing the file
    // system in as a prop instead keeps this resource — and its diff —
    // entirely inside this tenant's own stack.
    const accessPoint = new efs.AccessPoint(this, "AccessPoint", {
      fileSystem: shared.fileSystem,
      path: `/tenants/${tenant.id}`,
      createAcl: { ownerUid: SharedStack.HERMES_UID, ownerGid: SharedStack.HERMES_GID, permissions: "750" },
      posixUser: { uid: SharedStack.HERMES_UID, gid: SharedStack.HERMES_GID },
    });

    // ---- IAM: task role (what the running Hermes process can touch) ----
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Hermes task role for tenant "${tenant.id}" - scoped to only this tenant's data`,
    });

    // EFS: IAM-authorized access, restricted to this tenant's access point.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"],
        resources: [shared.fileSystem.fileSystemArn],
        conditions: { StringEquals: { "elasticfilesystem:AccessPointArn": accessPoint.accessPointArn } },
      })
    );

    // Bedrock: only the model IDs this tenant is allowed to use.
    const modelIds = tenant.bedrockModelIds ?? appConfig.defaultBedrockModelIds;
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"],
        resources: modelIds.map((m) => `arn:aws:bedrock:${this.region}::foundation-model/${m}`),
      })
    );

    // S3: only this tenant's prefix.
    shared.bucket.grantReadWrite(taskRole, `tenants/${tenant.id}/*`);

    // ---- config.yaml: Hermes's ONLY way to learn its default model -------
    // gateway/run.py::_resolve_gateway_model() reads model.default purely
    // from config.yaml, no env var fallback — the one setting that doesn't
    // fit our "everything via env vars" pattern. This custom resource
    // seeds/updates that one block on the tenant's EFS before the Fargate
    // service (which depends on it, below) starts, and re-runs whenever
    // `bedrockModelIds` changes in tenants.json.
    const configWriterFn = new lambda.Function(this, "ConfigWriterFn", {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/write-tenant-config"),
      timeout: Duration.minutes(2),
      vpc: shared.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true, // no NAT Gateway - see SharedStack networking comment; this fn only needs EFS
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, "/mnt/efs"),
    });

    const configProvider = new cr.Provider(this, "ConfigWriterProvider", {
      onEventHandler: configWriterFn,
    });

    const configResource = new CustomResource(this, "ConfigYaml", {
      serviceToken: configProvider.serviceToken,
      properties: {
        ModelProvider: "bedrock",
        ModelDefault: modelIds[0],
      },
    });

    // ---- IAM: execution role (what ECS itself needs to start the task) --
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
    );

    const channelSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(this, "ChannelSecretParam", {
      parameterName: lineChannelSecretParamName(tenant.id),
    });
    const channelTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(this, "ChannelTokenParam", {
      parameterName: lineChannelAccessTokenParamName(tenant.id),
    });
    channelSecretParam.grantRead(executionRole);
    channelTokenParam.grantRead(executionRole);

    // ---- Task definition + container ------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
      volumes: [
        {
          name: "hermes-data",
          efsVolumeConfiguration: {
            fileSystemId: shared.fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: "ENABLED" },
          },
        },
      ],
    });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const container = taskDef.addContainer("hermes", {
      image: ecs.ContainerImage.fromRegistry(`nousresearch/hermes-agent:${appConfig.hermesImageTag}`),
      command: ["gateway", "run"],
      environment: {
        HERMES_UID: SharedStack.HERMES_UID,
        HERMES_GID: SharedStack.HERMES_GID,
        // Closed by default — see docs/DESIGN.md section on access control.
        // Flip via tenants.json + redeploy, or the bootstrap flow in
        // docs/LINE_INTEGRATION.md to discover userIds for the allowlist.
        LINE_ALLOW_ALL_USERS: String(tenant.lineAllowAllUsers ?? false),
        LINE_ALLOWED_USERS: (tenant.lineAllowedUsers ?? []).join(","),
        LINE_ALLOWED_GROUPS: (tenant.lineAllowedGroups ?? []).join(","),
        LINE_ALLOWED_ROOMS: (tenant.lineAllowedRooms ?? []).join(","),
        // Not read by Hermes — purely to force a new task definition
        // revision (and therefore a fresh task, which re-reads
        // config.yaml on boot) whenever the model selection changes.
        // CloudFormation only touches the ECS Service when *something*
        // about its properties changes; the config.yaml custom resource
        // below writes to EFS out-of-band, which alone wouldn't trigger
        // a restart of an already-running task.
        MODEL_CONFIG_VERSION: modelIds.join(","),
      },
      secrets: {
        LINE_CHANNEL_SECRET: ecs.Secret.fromSsmParameter(channelSecretParam),
        LINE_CHANNEL_ACCESS_TOKEN: ecs.Secret.fromSsmParameter(channelTokenParam),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "hermes", logGroup }),
    });
    container.addPortMappings({ containerPort: SharedStack.LINE_PORT });
    container.addMountPoints({ containerPath: "/opt/data", sourceVolume: "hermes-data", readOnly: false });

    // ---- Service -----------------------------------------------------
    const service = new ecs.FargateService(this, "Service", {
      cluster: shared.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true, // no NAT Gateway - see SharedStack networking comment
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [shared.fargateSecurityGroup],
      circuitBreaker: { rollback: true },
      // Hard swap, never a rolling overlap: maxHealthyPercent: 100 means
      // ECS must stop the old task before starting the new one. This
      // tenant's whole EFS access point (including the SQLite state.db
      // Hermes writes to) is single-writer — if the old and new task were
      // ever briefly up at once (the previous 0/200 setting allowed
      // exactly that), both would mount the same access point and could
      // write the same state.db concurrently over NFS, which is exactly
      // what produced "session storage could not be written" here. A few
      // seconds of downtime during redeploys is a fine trade for that.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Without this, the ALB can start health-checking (and the circuit
      // breaker can start counting failures) before Hermes has finished
      // initializing its plugins and bound the LINE webhook port, tripping
      // the circuit breaker on a task that would have become healthy given
      // more time.
      healthCheckGracePeriod: Duration.seconds(120),
    });
    // Ordering only (see MODEL_CONFIG_VERSION above for what actually
    // forces a redeploy when the model changes): make sure config.yaml is
    // written before CloudFormation touches the service at all, so a
    // brand-new tenant's first task boot never races the file's creation.
    service.node.addDependency(configResource);

    // ---- ALB: target group + host-based routing rule ---------------------
    // Hermes's LINE adapter listens on a fixed path (/line/webhook) that
    // isn't parameterizable per tenant, so tenants are distinguished by
    // subdomain (Host header) against the shared wildcard cert/DNS record
    // set up in SharedStack, not by URL path.
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: shared.vpc,
      port: SharedStack.LINE_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/line/webhook/health",
        healthyHttpCodes: "200-299",
      },
    });

    const hostname = `${tenant.id}.${appConfig.domainName}`;
    // Built directly against the listener (not via `listener.addAction`)
    // so the CfnListenerRule resource lives in *this* stack rather than
    // HermesShared — addAction would put it in the listener's stack,
    // which needs this stack's target group ARN, creating a dependency
    // cycle between HermesShared and every HermesTenant-* stack.
    new elbv2.ApplicationListenerRule(this, "Rule", {
      listener: shared.httpsListener,
      priority: listenerRulePriority,
      conditions: [elbv2.ListenerCondition.hostHeaders([hostname])],
      targetGroups: [targetGroup],
    });

    new CfnOutput(this, "WebhookUrl", { value: `https://${hostname}/line/webhook` });
  }
}
