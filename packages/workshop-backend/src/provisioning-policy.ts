// The provisioning policy for auto-provisioning ("ambient") gatekeepers — those that mint a connected
// account with no OAuth flow (VendorDescription.autoProvisionsAccount, e.g. the Context Library).
//
// Each such vendor has a three-state mode (see AmbientGatekeeperMode), set per deployment by the
// admin and stored in AdminConfig.ambientGatekeeperModes:
//   - 'disabled': not available; no account is provisioned, and any existing one stays dormant.
//   - 'optional': users opt in from the Connectors page; not forced on anyone. THE DEFAULT — we don't
//                 impose ambient authority on every user unless an admin explicitly turns it on.
//   - 'enabled':  auto-provisioned for every user (forced); they can't remove it.
//
// These helpers are the single chokepoint for that decision; UserDurableObject reads AdminConfig and
// calls them when provisioning, listing, and surfacing ambient accounts.

import { AmbientGatekeeperMode } from "@gadgets/workshop-shared/api";
import { AdminConfig } from "./admin-config.js";

export const DEFAULT_AMBIENT_GATEKEEPER_MODE: AmbientGatekeeperMode = "optional";

/**
 * Deployment-controlled internal sources are intentionally universal when configured. Other
 * ambient vendors retain the opt-in default because they may confer unrelated authority.
 */
const DEFAULT_ENABLED_AMBIENT_GATEKEEPERS = new Set(["github_org", "jarvis"]);

/** The deployment default for an ambient vendor when no administrator override is stored. */
export function defaultAmbientGatekeeperMode(vendorId: string): AmbientGatekeeperMode {
  return DEFAULT_ENABLED_AMBIENT_GATEKEEPERS.has(vendorId.toLowerCase())
    ? "enabled"
    : DEFAULT_AMBIENT_GATEKEEPER_MODE;
}

/**
 * The configured mode for an ambient vendor, defaulting to the deployment default when the admin
 * hasn't set one. Tolerates a config persisted before this field existed (ambientGatekeeperModes
 * may be undefined).
 */
export function ambientGatekeeperMode(config: AdminConfig, vendorId: string): AmbientGatekeeperMode {
  let normalized = vendorId.toLowerCase();
  let configured = config.ambientGatekeeperModes?.[normalized];
  if (configured) return configured;
  if (config.disabledGatekeepers.includes(normalized)) return "disabled";
  return defaultAmbientGatekeeperMode(normalized);
}

/**
 * Whether this vendor's account is auto-provisioned for every user ("enabled" mode). Such accounts
 * are "forced": created for everyone, not user-removable, and hidden from the Connectors list.
 * ("optional" accounts are user-managed; "disabled" ones aren't offered.)
 */
export function shouldAutoProvisionAccount(config: AdminConfig, vendorId: string): boolean {
  return ambientGatekeeperMode(config, vendorId) === "enabled";
}
