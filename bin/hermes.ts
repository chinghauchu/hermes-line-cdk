#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { SharedStack } from "../lib/shared-stack";
import { TenantStack } from "../lib/tenant-stack";

const app = new cdk.App();
const config = loadConfig();
const env = { account: config.account, region: config.region };

const shared = new SharedStack(app, "HermesShared", config, { env });

// Listener rule priorities must be unique per listener; leave headroom
// below 100 in case shared rules are ever added ahead of tenant rules.
let priority = 100;
for (const tenant of config.tenants) {
  new TenantStack(app, `HermesTenant-${tenant.id}`, {
    env,
    tenant,
    appConfig: config,
    shared,
    listenerRulePriority: priority++,
  });
}
