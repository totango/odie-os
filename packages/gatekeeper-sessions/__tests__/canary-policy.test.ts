import { describe, expect, it } from "vitest";
import { claimCanaryRun, hasValidCanaryAuthorization, rejectCanaryRequest } from "../canary/policy.js";

const TOKEN = "a".repeat(64);

describe("native canary request policy", () => {
  it("accepts only the exact fixed-length bearer token", async () => {
    await expect(hasValidCanaryAuthorization(`Bearer ${TOKEN}`, TOKEN)).resolves.toBe(true);
    for (const header of [null, TOKEN, `bearer ${TOKEN}`, `Bearer ${TOKEN}0`, `Bearer ${"A".repeat(64)}`]) {
      await expect(hasValidCanaryAuthorization(header, TOKEN)).resolves.toBe(false);
    }
    await expect(hasValidCanaryAuthorization(`Bearer ${TOKEN}`, "short")).resolves.toBe(false);
  });

  it("admits exactly one serialized Durable Object invocation", () => {
    const values = new Map<string, unknown>();
    const storage = {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      put<T>(key: string, value: T) { values.set(key, value); },
    };
    expect(() => claimCanaryRun(storage)).not.toThrow();
    expect(() => claimCanaryRun(storage)).toThrow("already claimed");
  });

  it("rejects all methods and paths except authenticated POST /ready and /run", async () => {
    const response404 = await rejectCanaryRequest(new Request("https://canary.example/other", { method: "POST" }), TOKEN);
    expect(response404?.status).toBe(404);
    const response405 = await rejectCanaryRequest(new Request("https://canary.example/run"), TOKEN);
    expect(response405?.status).toBe(405);
    const response401 = await rejectCanaryRequest(new Request("https://canary.example/run", { method: "POST" }), TOKEN);
    expect(response401?.status).toBe(401);
    for (const response of [response404, response405, response401]) {
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect((await response!.text()).length).toBeLessThan(32);
    }
    for (const path of ["/ready", "/run"]) {
      const accepted = await rejectCanaryRequest(new Request(`https://canary.example${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
      }), TOKEN);
      expect(accepted).toBeNull();
    }
  });
});
