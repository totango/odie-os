import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import type { AdminSettings } from "../src/admin-settings.js";
import { FEATURED_BLUEPRINTS_KEY, parseFeaturedBlueprints } from "../src/blueprint-archive.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN: DurableObjectNamespace<AdminSettings>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

function metadata(version: number, updatedAt: number): BlueprintMetadata {
  return {
    title: `Blueprint ${version}`,
    description: "",
    author: {type: "user", id: "owner@example.com", name: "Owner"},
    created: new Date(1),
    version,
    lastUpdated: new Date(updatedAt),
    bindings: {},
  };
}

async function featuredIds(): Promise<Map<string, BlueprintMetadata>> {
  let raw = await env.BLUEPRINTS.get(FEATURED_BLUEPRINTS_KEY);
  return new Map((raw ? parseFeaturedBlueprints(raw) : []).map(entry => [entry.id, entry.metadata]));
}

describe("featured blueprint mirror", () => {
  it("honors the current owner bit and rejects stale metadata", async () => {
    let username = `featured-owner-${crypto.randomUUID()}@example.com`;
    let ownerId = env.TEST_USER.idFromName(username);
    let owner = env.TEST_USER.get(ownerId);
    let admin = env.TEST_ADMIN.getByName("");
    let workspaceId = crypto.randomUUID();
    let unfeaturedId = crypto.randomUUID().replaceAll("-", "");
    let versionedId = crypto.randomUUID().replaceAll("-", "");
    await owner.createAccount(username, "Owner", new Uint8Array([1, 2, 3]));

    let current = metadata(2, 2);
    await owner.updateBlueprint(unfeaturedId, current, workspaceId);
    await owner.setBlueprintFeatured(unfeaturedId, true);
    await env.BLUEPRINTS.put(unfeaturedId, JSON.stringify({
      metadata: current,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.syncFeaturedBlueprint({id: unfeaturedId, metadata: current}, ownerId.toString());
    await owner.setBlueprintFeatured(unfeaturedId, false);
    await admin.syncFeaturedBlueprint({id: unfeaturedId, metadata: current}, ownerId.toString());
    expect((await featuredIds()).has(unfeaturedId)).toBe(false);

    await owner.updateBlueprint(versionedId, current, workspaceId);
    await owner.setBlueprintFeatured(versionedId, true);
    await env.BLUEPRINTS.put(versionedId, JSON.stringify({
      metadata: current,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.syncFeaturedBlueprint({id: versionedId, metadata: current}, ownerId.toString());
    let stale = metadata(1, 1);
    await env.BLUEPRINTS.put(versionedId, JSON.stringify({
      metadata: stale,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.setBlueprintFeatured(versionedId, true);
    expect((await featuredIds()).get(versionedId)?.version).toBe(2);

    // Propagation finishes by publishing canonical KV and reconciling unconditionally, so even a
    // false/true toggle that temporarily lost the mirror's high-water mark converges to v2.
    await admin.setBlueprintFeatured(versionedId, false);
    await admin.setBlueprintFeatured(versionedId, true);
    await env.BLUEPRINTS.put(versionedId, JSON.stringify({
      metadata: current,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.syncFeaturedBlueprint({id: versionedId, metadata: current}, ownerId.toString());
    expect((await featuredIds()).get(versionedId)?.version).toBe(2);

    let sameTimestamp = {...current, title: "Canonical same-millisecond title"};
    await owner.updateBlueprint(versionedId, sameTimestamp, workspaceId);
    await env.BLUEPRINTS.put(versionedId, JSON.stringify({
      metadata: sameTimestamp,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.syncFeaturedBlueprint({
      id: versionedId,
      metadata: sameTimestamp,
    }, ownerId.toString());
    expect((await featuredIds()).get(versionedId)?.title).toBe(sameTimestamp.title);
  }, 30_000);
});
