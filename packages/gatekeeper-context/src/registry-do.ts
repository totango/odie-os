// Per-domain registry of public collections. It serializes writes to the KV snapshot read by user
// sessions when building their enabled collection set.

import { DurableObject } from "cloudflare:workers";
import { validateAdminFenceChallenge, type AdminAuthorization, type AdminFenceChallenge, type AdminFenceEvidence } from "@gadgets/workshop-shared/gatekeeper";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  bundledCollectionSummary, diffBundledRegistryPlan, validateSharingDomain,
  type BundledRegistryRecord,
} from "./bundled-context.js";
import { publicCollectionsKvKey } from "./collection-kv.js";
import { ContextCollectionSummary } from "./context-types.js";
import { BUNDLED_CONTEXT_COLLECTIONS, BUNDLED_CONTEXT_MANIFEST } from "./generated/bundled-context.js";
import { domainName } from "./domain.js";

function makeRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      publicCollections: collection<ContextCollectionSummary>()({
        primaryKey: "id",
      }),
      bundledRecords: collection<BundledRegistryRecord>()({
        primaryKey: "id",
      }),
    },
    singletons: {
      sharingDomain: "",
      bundledManifestFingerprint: "",
      registryRevision: 0,
    },
  });
}

export class LibraryRegistryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeRegistryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeRegistryStorage(ctx.storage);
  }

  async #writeSnapshot(domain: string): Promise<void> {
    this.storage.registryRevision.put(this.storage.registryRevision.get() + 1);
    let collections = [...this.storage.publicCollections.list()];
    await this.env.CONTEXT_COLLECTIONS.put(
      publicCollectionsKvKey(domain), JSON.stringify(collections));
  }

  #domain(domain: string): string {
    let value = validateSharingDomain(domain);
    let stored = this.storage.sharingDomain.get();
    if (stored && stored !== value) throw new Error("Context registry domain mismatch.");
    if (!stored) this.storage.sharingDomain.put(value);
    return value;
  }

  #collection(id: string) {
    let ns = this.ctx.exports.ContextCollectionDurableObject;
    return ns.get(ns.idFromName(domainName(this.storage.sharingDomain.get(), id)));
  }

  /** Complete bounded scan of the indexed public inventory, checking each actual durable owner. */
  async adminFenceReadiness(domain: string, challenge: AdminFenceChallenge): Promise<AdminFenceEvidence> {
    validateAdminFenceChallenge(challenge);
    domain = this.#domain(domain);
    const revision = this.storage.registryRevision.get();
    const ids: string[] = [];
    for (const summary of this.storage.publicCollections.list()) {
      if (ids.length >= 1000 || summary.visibility !== "public" || ids.includes(summary.id)) {
        throw new Error("ADMIN_FENCE_INVENTORY_INCOMPLETE");
      }
      ids.push(summary.id);
    }
    for (const id of ids) {
      const owner = await this.#collection(id).adminFenceReadiness(domain, id);
      if (owner.domain !== domain || owner.collectionId !== id || owner.fenceVersion !== 1) {
        throw new Error("ADMIN_FENCE_OWNER_MISMATCH");
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(ids.toSorted())));
    if (revision !== this.storage.registryRevision.get()) throw new Error("ADMIN_FENCE_INVENTORY_CHANGED");
    return {...challenge, provider: "context", domain, fenceVersion: 1, registryRevision: revision,
      ownerCount: ids.length, inventory: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")};
  }

  isPublic(collectionId: string): boolean {
    return !!this.storage.publicCollections.get(collectionId);
  }

  async addPublic(domain: string, summary: ContextCollectionSummary, authorization?: Service<AdminAuthorization>): Promise<void> {
    if (!authorization) throw new Error("Admin access required.");
    await authorization.assertCurrent("context-public");
    domain = this.#domain(domain);
    let record = this.storage.bundledRecords.get(summary.id);
    if (record?.source === "bundled") {
      throw new Error(`Context collection id is reserved for bundled content: ${summary.id}`);
    }
    this.storage.bundledRecords.put({
      id: summary.id,
      source: "public",
      fingerprint: "manual",
      active: true,
      updatedAt: new Date(),
    });
    this.storage.publicCollections.put(summary);
    await this.#writeSnapshot(domain);
  }

  async removePublic(domain: string, collectionId: string, authorization?: Service<AdminAuthorization>): Promise<void> {
    if (!authorization) throw new Error("Admin access required.");
    await authorization.assertCurrent("context-public");
    domain = this.#domain(domain);
    if (this.storage.publicCollections.get(collectionId)) {
      this.storage.publicCollections.delete(collectionId);
      await this.#writeSnapshot(domain);
    }
  }

  /** Refresh a public collection summary; no-op if it is no longer public. */
  async syncPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    domain = this.#domain(domain);
    let existing = this.storage.publicCollections.get(summary.id);
    if (!existing) return;
    if (existing.lastUpdated.valueOf() !== summary.lastUpdated.valueOf()) {
      this.storage.publicCollections.put(summary);
      await this.#writeSnapshot(domain);
    }
  }

  /** Install/repair/retire bundled public collections for this sharing domain. */
  async installBundledCollections(domain: string): Promise<void> {
    domain = this.#domain(domain);
    if (this.storage.bundledManifestFingerprint.get() === BUNDLED_CONTEXT_MANIFEST.fingerprint) {
      return;
    }
    let records = new Map<string, BundledRegistryRecord>();
    for (let record of this.storage.bundledRecords.list()) {
      records.set(record.id, record);
    }
    for (let summary of this.storage.publicCollections.list()) {
      if (!records.has(summary.id) && summary.source !== "bundled") {
        records.set(summary.id, {
          id: summary.id,
          source: "public",
          fingerprint: "manual",
          active: true,
          updatedAt: summary.lastUpdated,
        });
      }
    }
    let plan = diffBundledRegistryPlan(BUNDLED_CONTEXT_COLLECTIONS, records);
    let now = new Date();

    // Phase 1: reserve new ids before making any collection reachable.
    this.storage.transaction(() => {
      for (let collection of plan.install) {
        this.storage.bundledRecords.put({
          id: collection.id,
          source: "bundled",
          fingerprint: collection.content.fingerprint,
          active: false,
          updatedAt: now,
        });
      }
    });

    // Phase 2: replace collection contents. This is safe to repeat for partial repair.
    for (let collection of [...plan.install, ...plan.repair]) {
      await this.#collection(collection.id).installBundled(collection, domain);
    }

    // Phase 3: update discovery, retire removed bundles, and leave all ids permanently reserved.
    this.storage.transaction(() => {
      for (let collection of [...plan.install, ...plan.repair]) {
        this.storage.publicCollections.put(bundledCollectionSummary(collection));
        this.storage.bundledRecords.put({
          id: collection.id,
          source: "bundled",
          fingerprint: collection.content.fingerprint,
          active: true,
          updatedAt: now,
        });
      }
      for (let id of plan.retire) {
        this.storage.publicCollections.delete(id);
        let existing = this.storage.bundledRecords.get(id);
        this.storage.bundledRecords.put({
          id,
          source: "bundled",
          fingerprint: existing?.fingerprint ?? "retired",
          active: false,
          updatedAt: now,
        });
      }
    });
    await this.#writeSnapshot(domain);
    this.storage.bundledManifestFingerprint.put(BUNDLED_CONTEXT_MANIFEST.fingerprint);
  }
}
