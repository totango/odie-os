import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RequestBuilds, type RequestBuildDependencies } from "../src/request-builds";
import { buildHash } from "@gadgets/workshop-shared/coding-sessions";

it("withholds frozen attachment bytes deleted during the SECOND authorization await", async () => {
  await runInDurableObject(env.TEST_COMMUNITY_REQUESTS.getByName(crypto.randomUUID()), async (_instance, ctx) => {
    const fileId = crypto.randomUUID();
    const content = new TextEncoder().encode("public file");
    const descriptor = {id: fileId, path: "01-file.txt", mimeType: "text/plain",
      byteLength: content.length, sha256: await buildHash("public file")};
    let available = true;
    // This test isolates transfer's post-authorization fence. The real authorization policy has
    // separate facade/control coverage; here both checks allow while the second withdraws metadata.
    const dependencies = {
      specification: () => ({revision: 1, specification: "request", open: true,
        contextFiles: available ? [descriptor] : []}),
      contextFile: async () => content,
    } as RequestBuildDependencies;
    const builds = new RequestBuilds(ctx.storage, dependencies);
    const dispatchKey = crypto.randomUUID();
    ctx.storage.sql.exec("INSERT INTO build_runs VALUES (?,?,NULL,?)", crypto.randomUUID(), "request",
      JSON.stringify({requestId: "request", intentHash: "intent", intent: {dispatchKey, contextFiles: [descriptor]}}));
    let checks = 0;
    vi.spyOn(builds, "authorize").mockImplementation(async () => {
      await Promise.resolve();
      if (++checks === 2) available = false;
      return {allowed: true};
    });
    await expect(builds.contextFile({userId: "owner", email: "owner@example.com"}, {
      dispatchKey, intentHash: "intent", sessionId: "session", generation: 1, phase: "start",
    }, fileId)).rejects.toThrow("BUILD_CONTEXT_UNAVAILABLE");
    expect(checks).toBe(2);
  });
});
