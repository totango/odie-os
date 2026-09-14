import type { AdminClaim } from "../src/admin-authority";
import type { AdminProviderBaseline } from "../src/admin-provider-evidence";

/** Value-only engine fixture, not production provider readiness evidence. */
export const providerFixtureBaseline: AdminProviderBaseline = [
  {provider: "context", domain: "test-domain", fenceVersion: 1, registryRevision: 0, ownerCount: 0, inventory: "0".repeat(64)},
  {provider: "jarvis", domain: "global", fenceVersion: 1, registryRevision: 0, ownerCount: 1, inventory: "global-policy"},
];

/** Fixed non-production provenance for immutable test service props, NOT real bootstrap/cutover. */
export const providerFixtureClaim: AdminClaim = {
  principalId: "fixture-provider-principal", profileId: "fixture-provider-profile",
  epoch: "fixture-provider-epoch", mode: "managed", generation: 1, purpose: "context-public",
};
