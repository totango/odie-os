import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("rejects an unversioned Cloudflare reconnect before exchanging or replacing the live grant", async () => {
  const accounts = exports.UserAccount;
  const account = accounts.get(accounts.newUniqueId());
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await runInDurableObject(account, async (instance, ctx) => {
    if (!("UpgradeTestCallback" in exports) || typeof exports.UpgradeTestCallback !== "function") {
      throw new Error("Test callback entrypoint is not registered");
    }
    const callback = exports.UpgradeTestCallback({});
    const kv = ctx.storage.kv;
    const live = { token: "live-access", expires: Date.now() + 3600_000 };
    kv.put("callback", callback);
    kv.put("reconnecting", true);
    kv.put("refreshToken", "live-refresh");
    kv.put("accessToken", live);
    kv.put("grantedScopes", ["billing"]);
    kv.put("nonce", { value: "a".repeat(64), expiresAt: Date.now() + 600_000,
      stage: "oauth", verifier: "v".repeat(43) });
    await expect(instance.acceptAuthCode("code", "a".repeat(64))).rejects.toThrow(/before the handoff upgrade/);
    expect(kv.get("refreshToken")).toBe("live-refresh");
    expect(kv.get("accessToken")).toEqual(live);
    expect(kv.get("grantedScopes")).toEqual(["billing"]);
    expect(kv.get("stagedCredentials")).toBeUndefined();
    await expect(instance.acceptAuthCode("code", "a".repeat(64))).resolves.toBeNull();
  });
  expect(fetcher).not.toHaveBeenCalled();
});
