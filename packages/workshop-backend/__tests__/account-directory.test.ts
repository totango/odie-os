import { describe, expect, it, vi } from "vitest";
import { accountProfileMatches, indexAccountProfile, searchAccountProfileHints } from "../src/account-directory";
import { isReservedBlueprintKey } from "../src/blueprint-archive";

function directory() {
  const keys = new Set<string>();
  return {
    keys,
    put: vi.fn(async (key: string) => { keys.add(key); }),
    list: vi.fn(async ({prefix, limit}: {prefix: string; limit: number}) => ({
      keys: [...keys].filter(key => key.startsWith(prefix)).toSorted().slice(0, limit).map(name => ({name})),
      list_complete: true,
    })),
  };
}

describe("derived account directory", () => {
  it("indexes profile and display-name prefixes without changing exact identity", async () => {
    const kv = directory();
    await indexAccountProfile(kv as unknown as KVNamespace, {type: "user", id: "Exact+Case@heyodie.ai", name: "Example Person"});
    expect(await searchAccountProfileHints(kv as unknown as KVNamespace, "exact+")).toEqual(["Exact+Case@heyodie.ai"]);
    expect(await searchAccountProfileHints(kv as unknown as KVNamespace, "example")).toEqual(["Exact+Case@heyodie.ai"]);
    expect(accountProfileMatches({id: "Exact+Case@heyodie.ai", name: "Example Person"}, "EXACT+")).toBe(true);
  });

  it("rejects broad/control-character discovery and reserves index keys from blueprint IDs", async () => {
    const kv = directory();
    expect(await searchAccountProfileHints(kv as unknown as KVNamespace, "x")).toEqual([]);
    expect(await searchAccountProfileHints(kv as unknown as KVNamespace, "😀".repeat(64))).toEqual([]);
    kv.keys.add(".accountDirectory.v1:profile:okay:%E0%A4%A");
    kv.keys.add(`.accountDirectory.v1:profile:okay:${encodeURIComponent("bad\naccount")}`);
    expect(await searchAccountProfileHints(kv as unknown as KVNamespace, "okay")).toEqual([]);
    await expect(searchAccountProfileHints(kv as unknown as KVNamespace, "ok\nno")).rejects.toThrow("INVALID_ADMIN_INPUT");
    expect(isReservedBlueprintKey(".accountDirectory.v1:profile:test:test@example.com")).toBe(true);
  });
});
