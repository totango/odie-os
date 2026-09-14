import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "../src/index";
import type { JarvisPolicy } from "../src/policy";

// Present only in the provider-native config, absent in the Node suite/production. Assert them
// at runtime rather than making unrelated MCP facets require test-only bindings.
type FixtureBindings = {
  TEST_JARVIS_FENCE_VENDOR?: Service<GatekeeperVendor>;
  TEST_JARVIS_FENCE_POLICY?: DurableObjectNamespace<JarvisPolicy>;
};
declare global {
  interface Env extends FixtureBindings {}
  namespace Cloudflare { interface Env extends FixtureBindings {} }
}

describe("JARVIS GatekeeperVendor owner evidence (real workerd)", () => {
  it("delegates its challenge to the actual policy owner without MCP or credentials", async () => {
    const vendor = env.TEST_JARVIS_FENCE_VENDOR;
    const policies = env.TEST_JARVIS_FENCE_POLICY;
    if (!vendor || !policies) throw new Error("Missing native fixture bindings");
    const challenge = {epoch: "jarvis-provider-test", revision: 3, nonce: crypto.randomUUID()};
    const evidence = await vendor.adminFenceReadiness(challenge);
    await expect(async () => vendor.adminFenceReadiness({...challenge, nonce: "invalid"})).rejects.toThrow("ADMIN_FENCE_CHALLENGE_INVALID");
    const forgedVersion = await vendor.adminFenceReadiness(Object.assign({}, challenge, {fenceVersion: 2}));
    expect(forgedVersion.fenceVersion).toBe(1);
    expect(evidence).toEqual({...challenge, provider: "jarvis", domain: "global", fenceVersion: 1,
      registryRevision: 0, ownerCount: 1, inventory: "global-policy"});
    expect(await policies.getByName("global").adminFenceReadiness(challenge)).toEqual(evidence);
    const description = await vendor.describe();
    expect(description.providesAuth).toBe(false);
    // Policy remains an ordinary value-only provider read: no write capability is returned.
    const policy = await policies.getByName("global").get();
    expect(Object.keys(policy).toSorted()).toEqual(["chat", "code", "revision", "syncCode"]);
    policy.syncCode = !policy.syncCode;
    expect((await policies.getByName("global").get()).syncCode).toBe(!policy.syncCode);
  });
});
