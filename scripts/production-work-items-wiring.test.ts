import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "jsonc-parser";

const WORK_ITEM_WORKERS = [
  ["gatekeeper-jira", "GATEKEEPER_JIRA", "odie-os-gk-jira"],
  ["gatekeeper-work-items", "GATEKEEPER_WORK_ITEMS", "odie-os-gk-work-items"],
  ["gatekeeper-zendesk", "GATEKEEPER_ZENDESK", "odie-os-gk-zendesk"],
] as const;

function readJsonc(path: string): Record<string, any> {
  return parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function serviceByBinding(config: Record<string, any>, binding: string): Record<string, any> | undefined {
  return config.services?.find((service: Record<string, any>) => service.binding === binding);
}

test("production backend adds NativeBrowserFlow with a fresh migration tag", () => {
  const backend = readJsonc("packages/workshop-backend/wrangler.odie-os-production.jsonc");

  assert.deepEqual(backend.migrations.at(-2), { tag: "v3" });
  assert.deepEqual(backend.migrations.at(-1), {
    tag: "v4",
    new_sqlite_classes: ["NativeBrowserFlow"],
  });
});

test("production Work Items workers are built, deployed, and routed coherently", () => {
  const buildScript = readFileSync("scripts/build-production-deploy.mjs", "utf8");
  const deployWorkflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const backend = readJsonc("packages/workshop-backend/wrangler.odie-os-production.jsonc");
  const webRouter = readJsonc("packages/router/wrangler.odie-os-production.jsonc");
  const nativeRouter = readJsonc("packages/router/wrangler.odie-os-native-production.jsonc");

  for (const [packageName, binding, workerName] of WORK_ITEM_WORKERS) {
    assert.match(buildScript, new RegExp(`"${packageName}"`), `${packageName} missing from build artifact`);
    assert.match(
      deployWorkflow,
      new RegExp(`wrangler deploy --no-bundle --config ${packageName}/wrangler\\.json`),
      `${packageName} missing from production deploy workflow`,
    );

    assert.deepEqual(serviceByBinding(backend, binding), {
      binding,
      service: workerName,
      entrypoint: "GatekeeperVendor",
    });
    assert.deepEqual(serviceByBinding(webRouter, binding), { binding, service: workerName });
    assert.deepEqual(serviceByBinding(nativeRouter, binding), { binding, service: workerName });
  }

  for (const config of [backend, webRouter, nativeRouter]) {
    assert.equal(serviceByBinding(config, "GATEKEEPER_TEAM_PI"), undefined);
  }
});

test("production deployment fails before secret sync when Jira or Zendesk OAuth secrets are absent", () => {
  const deployWorkflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");

  for (const name of ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "ZENDESK_CLIENT_ID", "ZENDESK_CLIENT_SECRET"]) {
    assert.ok(
      deployWorkflow.includes(`${name}: \${{ secrets.${name} }}`),
      `${name} is not mapped from GitHub Actions secrets`,
    );
    assert.match(deployWorkflow, new RegExp(`\\b${name}\\b[\\s\\S]*Missing required production deployment configuration: \\$name`));
  }

  assert.match(deployWorkflow, /require_secrets odie-os-gk-jira CLIENT_ID CLIENT_SECRET/);
  assert.match(deployWorkflow, /require_secrets odie-os-gk-zendesk CLIENT_ID CLIENT_SECRET/);
});

test("production Jira and Zendesk accept native OAuth returns from the native API origin", () => {
  const backend = readJsonc("packages/workshop-backend/wrangler.odie-os-production.jsonc");
  const nativeOrigin = backend.vars.PUBLIC_BASE_URL;

  assert.equal(readJsonc("packages/gatekeeper-jira/wrangler.odie-os-production.jsonc").vars.PUBLIC_BASE_URL, nativeOrigin);
  assert.equal(readJsonc("packages/gatekeeper-zendesk/wrangler.odie-os-production.jsonc").vars.PUBLIC_BASE_URL, nativeOrigin);
});

test("Zendesk embeds its management app from tracked source", () => {
  const zendeskSource = readFileSync("packages/gatekeeper-zendesk/src/zendesk.ts", "utf8");
  const appHtml = readFileSync("packages/gatekeeper-zendesk/src/app.txt", "utf8");

  assert.match(zendeskSource, /import APP_HTML from "\.\/app\.txt";/);
  assert.match(appHtml, /<h1>Zendesk Work Items source<\/h1>/);
});
