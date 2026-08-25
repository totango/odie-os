import { describe, expect, it } from "vitest";
import { findExactApplication } from "../../../scripts/coding-session-canary-applications.mjs";

const ACCOUNT = "a".repeat(32);
const NAME = "odie-coding-canary-123-standard-3-container";
const ID = "12345678-1234-1234-1234-123456789abc";

function page(result: Array<{ id: string; name: string }>, next?: unknown) {
  return new Response(JSON.stringify({ success: true, result, result_info: { next_page_token: next } }));
}

describe("paginated canary application lookup", () => {
  it("finds an exact target only on page two", async () => {
    const urls: URL[] = [];
    const fetch = async (url: URL) => {
      urls.push(url);
      return urls.length === 1 ? page([{ id: ID, name: "other" }], "next_2") : page([{ id: ID, name: NAME }]);
    };
    await expect(findExactApplication({ accountId: ACCOUNT, apiToken: "secret", name: NAME, fetch })).resolves.toBe(ID);
    expect(urls).toHaveLength(2);
    expect(urls[1]!.searchParams.get("page_token")).toBe("next_2");
  });

  it("returns null only after walking the final page", async () => {
    let calls = 0;
    const fetch = async () => ++calls === 1 ? page([], "second") : page([]);
    await expect(findExactApplication({ accountId: ACCOUNT, apiToken: "secret", name: NAME, fetch })).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it("fails closed on duplicate exact names across pages", async () => {
    let calls = 0;
    const fetch = async () => ++calls === 1 ? page([{ id: ID, name: NAME }], "second") :
      page([{ id: "abcdefab-1234-1234-1234-123456789abc", name: NAME }]);
    await expect(findExactApplication({ accountId: ACCOUNT, apiToken: "secret", name: NAME, fetch })).rejects.toThrow("Duplicate");
  });

  it("rejects non-tiered and noncanonical application names", async () => {
    for (const name of [
      "odie-coding-canary-123-container",
      "odie-coding-canary-0123-standard-1-container",
      "odie-coding-canary-123-standard-5-container",
      "odie-coding-canary-123-standard-1-container-extra",
    ]) {
      await expect(findExactApplication({ accountId: ACCOUNT, apiToken: "secret", name, fetch: async () => page([]) }))
        .rejects.toThrow("Invalid canary application name");
    }
  });

  it("rejects malformed pages and tokens", async () => {
    for (const response of [
      new Response(JSON.stringify([])),
      new Response(JSON.stringify({ success: true, result: {}, result_info: {} })),
      page([], { token: true }),
      page([], "bad token"),
    ]) {
      await expect(findExactApplication({ accountId: ACCOUNT, apiToken: "secret", name: NAME, fetch: async () => response.clone() }))
        .rejects.toThrow(/Malformed/);
    }
  });

  it("rejects repeated tokens and malformed exact UUIDs", async () => {
    await expect(findExactApplication({
      accountId: ACCOUNT, apiToken: "secret", name: NAME,
      fetch: async () => page([], "again"),
    })).rejects.toThrow("Repeated");
    await expect(findExactApplication({
      accountId: ACCOUNT, apiToken: "secret", name: NAME,
      fetch: async () => page([{ id: "bad", name: NAME }]),
    })).rejects.toThrow("invalid UUID");
  });
});
