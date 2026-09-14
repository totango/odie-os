import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Odie deploys capability-aware providers before the authority consumer", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const deploy = workflow.slice(workflow.indexOf("- name: Deploy prebuilt workers"));
  const backend = deploy.indexOf("--config workshop-backend/wrangler.json");
  assert.ok(backend > 0);
  for (const provider of ["gatekeeper-context", "gatekeeper-jarvis"]) {
    const position = deploy.indexOf(`--config ${provider}/wrangler.json`);
    assert.ok(position >= 0 && position < backend, `${provider} must precede the backend`);
  }
});

test("all four configured administrator seeds and authentication policy remain deployment-owned", () => {
  const config = read("packages/workshop-backend/wrangler.odie-os-production.jsonc");
  const admins = JSON.parse(config.match(/"ADMINS"\s*:\s*(\[[\s\S]*?\])/)![1]);
  assert.deepEqual(admins, ["jacob.beck@totango.com", "keith@totango.com", "nick.roberts@totango.com", "stacy.kennedy@totango.com"]);
  const authority = read("packages/workshop-backend/src/admin-authority.ts");
  for (const authenticationVariable of ["AUTH_GATEKEEPERS", "DISABLE_PASSWORD_AUTH", "AUTH_EMAIL_DOMAIN_ALIASES"]) {
    assert.equal(authority.includes(authenticationVariable), false);
  }
  assert.equal(authority.includes('"FINANCE_GUARD_UNAVAILABLE"'), false);
  assert.ok(authority.includes('"context-public"'));
  assert.ok(authority.includes('"jarvis-policy"'));
  assert.ok(read("packages/gatekeeper-context/src/context-api.ts").includes('authorization.assertCurrent("context-public")'));
  assert.ok(read("packages/gatekeeper-jarvis/src/policy.ts").includes('authorization.assertCurrent("jarvis-policy")'));
  assert.ok(authority.includes('"LEGACY_CAPABILITIES_UNDRAINED"'));
});

test("Finance operator configuration stays backend-only and optional in deployment plumbing", () => {
  const production = read("packages/workshop-backend/wrangler.odie-os-production.jsonc");
  assert.equal(/"FINANCE_OPERATORS"\s*:/.test(production), false, "omission preserves all four configured seeds");
  assert.ok(read("scripts/run-dev-server.ts").includes('"FINANCE_OPERATORS"'));
  assert.ok(read("scripts/release/manifest-lib.ts").includes('Object.assign(vars, config.vars ?? {})'));
  assert.equal(read("scripts/release/manifest-lib.ts").includes('FINANCE_OPERATORS'), false, "not a credential wizard input");
  assert.equal(read("packages/workshop-backend/src/auth/config.ts").includes('FINANCE_OPERATORS'), false);
  assert.equal(read("packages/workshop-backend/src/deployment-config.ts").includes('FINANCE_OPERATORS'), false, "not browser config");
});
