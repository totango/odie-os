import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLED_CONTEXT_MANIFEST,
  BUNDLED_CONTEXT_COLLECTIONS,
} from "../src/generated/bundled-context";
import {
  diffBundledRegistryPlan,
  bundledCollectionSummary,
  type BundledRegistryRecord,
} from "../src/bundled-context";
import { publicCollectionsKvKey } from "../src/collection-kv";
import { domainName } from "../src/domain";
import type { ContextCollectionDurableObject } from "../src/context-collection";
import type { LibraryRegistryDurableObject } from "../src/registry-do";
import type { ContextCollectionSummary } from "../src/context-types";

const testEnv = env as unknown as {
  CONTEXT_COLLECTIONS: KVNamespace;
  TEST_CONTEXT_COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  TEST_LIBRARY_REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
};

afterEach(() => reset());

function registry(domain: string): DurableObjectStub<LibraryRegistryDurableObject> {
  return testEnv.TEST_LIBRARY_REGISTRIES.getByName(domain);
}

function collection(domain: string, collectionId: string):
    DurableObjectStub<ContextCollectionDurableObject> {
  let id = testEnv.TEST_CONTEXT_COLLECTIONS.idFromName(domainName(domain, collectionId));
  return testEnv.TEST_CONTEXT_COLLECTIONS.get(id);
}

async function publicSnapshot(domain: string): Promise<ContextCollectionSummary[]> {
  let raw = await testEnv.CONTEXT_COLLECTIONS.get(publicCollectionsKvKey(domain));
  expect(raw).toBeTruthy();
  return JSON.parse(raw!) as ContextCollectionSummary[];
}

describe("bundled Context manifest", () => {
  it("ships stable non-empty read-only support collections with skills", () => {
    expect(BUNDLED_CONTEXT_MANIFEST.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(BUNDLED_CONTEXT_COLLECTIONS.map(collection => collection.id)).toEqual([
      "support-catalyst",
      "support-global",
      "support-totango",
      "support-unison",
    ]);

    for (let collection of BUNDLED_CONTEXT_COLLECTIONS) {
      expect(collection.content.source).toBe("bundled");
      expect(collection.documents.some(doc => doc.path.endsWith("SKILL.md"))).toBe(true);
      expect(collection.documents.every(doc => !/picowork|(?:zendesk|ticket)\s*#?\d{4,}|customer ids?\b|\/Users\//i.test(doc.body))).toBe(true);
    }
  });

  it("plans install, repair, and retirement without releasing reserved ids", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let records = new Map<string, BundledRegistryRecord>();
    records.set("support-global", {
      id: "support-global",
      source: "bundled",
      fingerprint: "stale",
      active: true,
      updatedAt: now,
    });
    records.set("old-support", {
      id: "old-support",
      source: "bundled",
      fingerprint: "old",
      active: true,
      updatedAt: now,
    });
    records.set("reserved-only", {
      id: "reserved-only",
      source: "bundled",
      fingerprint: "old",
      active: false,
      updatedAt: now,
    });

    let plan = diffBundledRegistryPlan(BUNDLED_CONTEXT_COLLECTIONS, records);
    expect(plan.install.map(item => item.id)).toEqual([
      "support-catalyst",
      "support-totango",
      "support-unison",
    ]);
    expect(plan.repair.map(item => item.id)).toEqual(["support-global"]);
    expect(plan.retire).toEqual(["old-support"]);
    expect(plan.reserved).toContain("reserved-only");
  });

  it("rejects id collisions with non-bundled public collections", () => {
    let records = new Map<string, BundledRegistryRecord>();
    records.set("support-global", {
      id: "support-global",
      source: "public",
      fingerprint: "manual",
      active: true,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(() => diffBundledRegistryPlan(BUNDLED_CONTEXT_COLLECTIONS, records))
      .toThrow("Bundled Context collection id collides with a non-bundled collection: support-global");
  });

  it("summarizes bundled collections as bundled source records", () => {
    let summary = bundledCollectionSummary(BUNDLED_CONTEXT_COLLECTIONS[0]);
    expect(summary.source).toBe("bundled");
    expect(summary.id).toBe(BUNDLED_CONTEXT_COLLECTIONS[0].id);
  });

  it("repairs a partially reserved bundled collection into public runtime state", async () => {
    let domain = "partial-repair.example";
    let target = "support-global";
    await runInDurableObject(registry(domain), (_instance, state) => {
      state.storage.kv.put<BundledRegistryRecord>(`bundledRecords:${target}`, {
        id: target,
        source: "bundled",
        fingerprint: "reserved-before-content-install",
        active: false,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      state.storage.kv.put("sharingDomain", domain);
    });

    await registry(domain).installBundledCollections(domain);

    let repairedRecord = await runInDurableObject(registry(domain), (_instance, state) =>
      [...state.storage.kv.list<BundledRegistryRecord>({ prefix: "bundledRecords:" })]
          .map(([key, record]) => ({ ...record, id: key.slice("bundledRecords:".length) }))
          .find(record => record.id === target));
    expect(repairedRecord).toMatchObject({
      id: target,
      source: "bundled",
      active: true,
      fingerprint: BUNDLED_CONTEXT_COLLECTIONS.find(each => each.id === target)!.content.fingerprint,
    });
    await expect(collection(domain, target).getMetadata()).resolves.toMatchObject({
      id: target,
      visibility: "public",
      content: { source: "bundled" },
    });
    expect((await publicSnapshot(domain)).map(entry => entry.id)).toContain(target);
  });

  it("retires removed bundled ids from discovery but keeps their reservations", async () => {
    let domain = "retirement.example";
    let retired = "retired-support";
    await runInDurableObject(registry(domain), (_instance, state) => {
      state.storage.kv.put<BundledRegistryRecord>(`bundledRecords:${retired}`, {
        id: retired,
        source: "bundled",
        fingerprint: "old-fingerprint",
        active: true,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      state.storage.kv.put<ContextCollectionSummary>(`publicCollections:${retired}`, {
        id: retired,
        title: "Retired Support",
        description: "No longer bundled.",
        visibility: "public",
        documentCount: 1,
        lastUpdated: new Date("2026-01-01T00:00:00.000Z"),
        source: "bundled",
      });
      state.storage.kv.put("sharingDomain", domain);
    });

    await registry(domain).installBundledCollections(domain);

    let retiredRecord = await runInDurableObject(registry(domain), (_instance, state) =>
      [...state.storage.kv.list<BundledRegistryRecord>({ prefix: "bundledRecords:" })]
          .map(([key, record]) => ({ ...record, id: key.slice("bundledRecords:".length) }))
          .find(record => record.id === retired));
    expect(retiredRecord).toMatchObject({
      id: retired,
      source: "bundled",
      fingerprint: "old-fingerprint",
      active: false,
    });
    expect((await publicSnapshot(domain)).map(entry => entry.id)).not.toContain(retired);
  });

  it("fails installation when an existing public collection owns a bundled id", async () => {
    let domain = "collision.example";
    await runInDurableObject(registry(domain), (_instance, state) => {
      state.storage.kv.put<ContextCollectionSummary>("publicCollections:support-global", {
        id: "support-global",
        title: "Manual Support Global",
        description: "Manual public collection using a bundled id.",
        visibility: "public",
        documentCount: 0,
        lastUpdated: new Date("2026-01-01T00:00:00.000Z"),
        source: "public",
      });
      state.storage.kv.put("sharingDomain", domain);
    });

    let message = await runInDurableObject(registry(domain), async (instance) => {
      try {
        await instance.installBundledCollections(domain);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return "";
    });
    expect(message).toBe(
      "Bundled Context collection id collides with a non-bundled collection: support-global");
  });

  it("keeps bundled collections read-only after runtime installation", async () => {
    let domain = "immutability.example";
    let target = "support-global";
    await registry(domain).installBundledCollections(domain);
    let stub = collection(domain, target);

    let messages = await runInDurableObject(stub, async (instance) => {
      let results: string[] = [];
      for (let operation of [
        () => instance.updateMetadata({ title: "Edited" }),
        () => instance.putContextDocument("notes.md", {
          description: "Manual edit",
          body: "Nope",
        }),
        () => instance.deleteSelf(),
      ]) {
        try {
          await operation();
        } catch (err) {
          results.push(err instanceof Error ? err.message : String(err));
        }
      }
      return results;
    });
    expect(messages).toEqual([
      "Bundled Context collections are read-only.",
      "Bundled Context collections are read-only.",
      "Bundled Context collections are read-only.",
    ]);
  });

  it("indexes bundled SKILL.md documents for agent exposure", async () => {
    let domain = "skills.example";
    await registry(domain).installBundledCollections(domain);

    let supportGlobal = collection(domain, "support-global");
    let skills = await supportGlobal.listAgentSkills();
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "SKILL.md",
        skillName: "support-triage",
        description: expect.stringContaining("Triage a support request"),
      }),
    ]));
    await expect(supportGlobal.getContextDocument("SKILL.md"))
      .resolves.toMatchObject({
        path: "SKILL.md",
        skillName: "support-triage",
        body: expect.stringContaining("# Support triage"),
      });
  });
});
