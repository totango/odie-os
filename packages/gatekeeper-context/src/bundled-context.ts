import type {
  ContextCollectionMetadata,
  ContextCollectionSummary,
  ContextDocument,
} from "./context-types.js";

/** A generated read-only collection shipped with this gatekeeper. */
export type BundledContextCollection = ContextCollectionMetadata & {
  content: { source: "bundled"; fingerprint: string };
  documents: ContextDocument[];
};

/** Registry-owned permanent reservation for a bundled collection id. */
export type BundledRegistryRecord = {
  id: string;
  source: "bundled" | "public";
  fingerprint: string;
  active: boolean;
  updatedAt: Date;
};

/** Phase-ordered work for an idempotent bundled install pass. */
export type BundledRegistryPlan = {
  install: BundledContextCollection[];
  repair: BundledContextCollection[];
  retire: string[];
  reserved: string[];
};

/** Public-listing summary for a bundled collection. */
export function bundledCollectionSummary(
    collection: BundledContextCollection): ContextCollectionSummary {
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    icon: collection.icon,
    visibility: collection.visibility,
    documentCount: collection.documentCount,
    lastUpdated: collection.lastUpdated,
    source: "bundled",
  };
}

/** Compute the registry-authoritative, idempotent bundled installer plan. */
export function diffBundledRegistryPlan(
    bundled: BundledContextCollection[],
    records: ReadonlyMap<string, BundledRegistryRecord>): BundledRegistryPlan {
  let install: BundledContextCollection[] = [];
  let repair: BundledContextCollection[] = [];
  let retire: string[] = [];
  let reserved = [...records.keys()];
  let activeIds = new Set<string>();

  for (let collection of bundled) {
    activeIds.add(collection.id);
    let record = records.get(collection.id);
    if (!record) {
      install.push(collection);
      continue;
    }
    if (record.source !== "bundled") {
      throw new Error(
          `Bundled Context collection id collides with a non-bundled collection: ${collection.id}`);
    }
    if (!record.active || record.fingerprint !== collection.content.fingerprint) {
      repair.push(collection);
    }
  }

  for (let record of records.values()) {
    if (record.source === "bundled" && record.active && !activeIds.has(record.id)) {
      retire.push(record.id);
    }
  }

  install.sort((a, b) => a.id.localeCompare(b.id));
  repair.sort((a, b) => a.id.localeCompare(b.id));
  retire.sort((a, b) => a.localeCompare(b));
  reserved.sort((a, b) => a.localeCompare(b));
  return { install, repair, retire, reserved };
}

/** Validate a binding-derived sharing domain before using it in DO/KV keys. */
export function validateSharingDomain(domain: string): string {
  let value = domain.trim();
  if (!value) throw new Error("Context sharing domain is required.");
  if (value.length > 128) throw new Error("Context sharing domain is too long.");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Context sharing domain must not contain control characters.");
  }
  return value;
}
