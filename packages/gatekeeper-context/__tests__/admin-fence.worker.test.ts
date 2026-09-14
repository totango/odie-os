import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { GatekeeperVendor } from "../src/library-gatekeeper";

declare global { namespace Cloudflare { interface Env {
  TEST_CONTEXT_FENCE_VENDOR: Service<GatekeeperVendor>;
} } }

describe("Context GatekeeperVendor owner evidence (real workerd)", () => {
  it("uses its actual binding domain and forwards the fresh challenge to the registry owner", async () => {
    const challenge = {epoch: "context-provider-test", revision: 4, nonce: crypto.randomUUID()};
    const evidence = await env.TEST_CONTEXT_FENCE_VENDOR.adminFenceReadiness(challenge);
    expect(evidence).toEqual({...challenge, provider: "context", domain: "context-provider-fixture", fenceVersion: 1,
      registryRevision: 0, ownerCount: 0, inventory: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"});
  });
});
