import type { AdminFenceChallenge, AdminFenceEvidence } from "@gadgets/workshop-shared/gatekeeper";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors";

/** Immutable bounded activation record; no native references or token/collection contents. */
export type AdminProviderBaseline = Array<Omit<AdminFenceEvidence, keyof AdminFenceChallenge>>;

/** Obtain two independent fresh scans from the configured providers; never accept browser attestations. */
export async function readAdminProviderEvidence(env: Cloudflare.Env,
    authority: Pick<AdminFenceChallenge, "epoch" | "revision">): Promise<AdminProviderBaseline> {
  const vendors = buildGatekeeperVendorMap(env);
  async function scan(): Promise<AdminProviderBaseline> {
    const challenge = {...authority, nonce: crypto.randomUUID()};
    const result: AdminProviderBaseline = [];
    // Absence is not proof that historical privileged accounts never existed. Both are required.
    for (const provider of ["context", "jarvis"] as const) {
      const vendor = vendors.get(provider);
      if (!vendor || typeof vendor.adminFenceReadiness !== "function") throw new Error("LEGACY_CAPABILITIES_UNDRAINED");
      const evidence = await vendor.adminFenceReadiness(challenge);
      if (!evidence || evidence.provider !== provider || evidence.epoch !== challenge.epoch ||
          evidence.revision !== challenge.revision || evidence.nonce !== challenge.nonce || evidence.fenceVersion !== 1 ||
          typeof evidence.domain !== "string" || !evidence.domain || evidence.domain.length > 128 ||
          evidence.domain.trim() !== evidence.domain || [...evidence.domain].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
          !Number.isSafeInteger(evidence.registryRevision) || evidence.registryRevision < 0 ||
          !Number.isSafeInteger(evidence.ownerCount) || evidence.ownerCount < 0 || evidence.ownerCount > 1000 ||
          typeof evidence.inventory !== "string" ||
          (provider === "context" ? !/^[a-f0-9]{64}$/.test(evidence.inventory) :
            evidence.domain !== "global" || evidence.ownerCount !== 1 || evidence.registryRevision !== 0 || evidence.inventory !== "global-policy")) {
        throw new Error("LEGACY_CAPABILITIES_UNDRAINED");
      }
      result.push({provider, domain: evidence.domain, fenceVersion: 1, registryRevision: evidence.registryRevision,
        ownerCount: evidence.ownerCount, inventory: evidence.inventory});
    }
    return result;
  }
  try {
    const first = await scan();
    const second = await scan();
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("ADMIN_FENCE_INVENTORY_CHANGED");
    return second;
  } catch {
    throw new Error("LEGACY_CAPABILITIES_UNDRAINED");
  }
}
