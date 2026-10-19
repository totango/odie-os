import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { runGadgetAi } from "../src/gadget-ai";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

afterEach(() => vi.unstubAllGlobals());

// The first native RPC lazily loads the test Worker, including its validated server module.
// Keep that cold transform outside individual test budgets on slower development machines.
beforeAll(async () => {
  await env.TEST_USER.getByName(`ai-warmup-${crypto.randomUUID()}`).whoamiIfExists();
}, 300_000);

describe("viewer-authenticated Gadget AI", () => {
  it("signs a shared Gadget request as the viewer, not the owner, without an organization", async () => {
    const ownerEmail = `ai-owner-${crypto.randomUUID()}@totango.com`;
    const viewerEmail = `ai-viewer-${crypto.randomUUID()}@totango.com`;
    const owner = env.TEST_USER.getByName(ownerEmail);
    const viewer = env.TEST_USER.getByName(viewerEmail);
    // A password-only owner has no quick model, so Gadget creation cannot perform unrelated AI.
    await owner.createAccount(ownerEmail, "Owner", new Uint8Array([1, 2, 3]));
    await viewer.loginOrCreateViaGatekeeper(viewerEmail, true);
    const workspace = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
    await owner.newGadget(workspace.id.toString(), "Shared AI");
    using ownerSession = await workspace.open(owner.id.toString(), ownerEmail, () => {});
    using created = await ownerSession.createGadget("Questions");
    const gadgetId = await created.getId();
    await ownerSession.setSharedWithEveryone(true);
    using viewerSession = await workspace.open(viewer.id.toString(), viewerEmail, () => {});
    using gadget = await viewerSession.getGadget(gadgetId);

    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const item = {id: "msg-fixture", type: "message", role: "assistant",
        content: [{type: "output_text", text: "Gravity is attraction between masses."}]};
      const events = [
        {type: "response.output_item.done", output_index: 0, item},
        {type: "response.completed", response: {id: "resp-fixture", status: "completed", output: [item]}},
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: {"content-type": "text/event-stream"},
      });
    }));
    await expect(gadget.runAi({prompt: "Explain gravity"}))
      .resolves.toBe("Gravity is attraction between masses.");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-team-pi-odie-user")).toBe(viewerEmail);
    expect(requests[0].headers.get("x-team-pi-odie-signature")).toMatch(/^v1=.+/);
    expect((await owner.checkDailyLlmCount(1000)).used).toBe(0);
    expect((await viewer.checkDailyLlmCount(1000)).used).toBe(1);
    await expect(viewerSession.newAiModelGatekeeper("team-pi-codex/gpt-6-astra"))
      .rejects.toThrow("cannot be bound");
  }, 45_000);

  it("rejects invalid input before consuming quota or making any provider request", async () => {
    const email = `ai-input-${crypto.randomUUID()}@totango.com`;
    const user = env.TEST_USER.getByName(email);
    await user.loginOrCreateViaGatekeeper(email, true);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(runGadgetAi(env as Cloudflare.Env, user, {prompt: ""})).rejects.toThrow("prompt");
    expect((await user.checkDailyLlmCount(1000)).used).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
