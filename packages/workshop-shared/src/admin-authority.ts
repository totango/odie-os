import type { WorkerEntrypoint } from "cloudflare:workers";

/** Workshop administrator authority is static until an evidence-checked managed transition.
 * Deployment-configured Finance operator access is separate and unaffected by grant/revoke.
 */
export type AdminAuthorityMode = "legacy" | "prepared" | "managed";
/** Consumer-selected scope checked against the immutable capability claim. */
export type AdminAuthorizationPurpose = "administration" | "board-moderation" | "context-public" | "jarvis-policy" | "request-build";
/** Narrow backend-minted capability; admission after revocation rejects, not already-admitted work.
 * Independently issued Context Git write credentials remain valid until expiry/explicit revocation.
 */
export interface AdminAuthorization extends WorkerEntrypoint {
  /** Check the expected consumer purpose, current membership and immutable issuance generation. No positive caching. */
  assertCurrent(expectedPurpose: AdminAuthorizationPurpose): Promise<void>;
}
/** Existing exact account, not an email assertion or an alias merge. */
export type AdministratorCandidate = {
  /** Exact User Durable Object identity. */
  principalId: string;
  /** Exact existing profile identifier. */
  profileId: string;
  /** Presentation only; never identity evidence. */
  displayName: string;
};
/** Persisted grant; prepared rows confer no effective authority. */
export type AdministratorGrant = AdministratorCandidate & {
  /** Monotonically increasing across revoke/regrant. */
  generation: number;
  /** Whether this stored grant is active. */
  active: boolean;
};
/** Private administrator list, with explicit static versus prepared semantics. */
export type AdministratorList = {
  /** Current deployment authority mode. */
  mode: AdminAuthorityMode;
  /** Revision required for mutations. */
  revision: number;
  /** Effective static profile IDs in legacy/prepared mode; empty in managed mode. */
  staticProfileIds: string[];
  /** Stored prepared or managed grant rows. */
  items: AdministratorGrant[];
  /** Exclusive principal cursor for the next bounded page. */
  nextCursor?: string;
  /** Server-owned managed-administrator activation blockers, excluding Finance operator access;
   * not overrideable by callers.
   */
  blockers: string[];
};
/** Revision-checked, replay-safe mutation envelope. */
export type AdministratorMutation = {
  /** Revision observed by the operator. */
  expectedRevision: number;
  /** Stable key for retrying exactly the same operation. */
  mutationKey: string;
};
/** One-time exact configured-account snapshot, requiring explicit confirmation. */
export type AdministratorBootstrapPreview = {
  /** Revision at preview time. */
  revision: number;
  /** Digest of the exact resolved configured snapshot. */
  digest: string;
  /** Existing configured accounts, including all configured seeds. */
  accounts: AdministratorCandidate[];
  /** Missing configured accounts block preparation, never silently drop seeds. */
  unresolvedProfileIds: string[];
};
/** Private immutable audit event; no credentials or request contents. */
export type AdministratorAuditEvent = {
  /** Monotonic event/revision number. */
  revision: number;
  /** Backend-derived exact acting principal. */
  actorPrincipalId: string;
  /** Exact affected principal, empty for a mode transition. */
  targetPrincipalId: string;
  /** Authority operation recorded atomically with its receipt. */
  action: "prepare" | "activate" | "grant" | "revoke";
  /** Previous grant generation, zero if absent. */
  previousGeneration: number;
  /** Resulting grant generation, zero for a mode-only transition. */
  nextGeneration: number;
  /** Server timestamp in milliseconds. */
  timestamp: number;
};
/** Private bounded audit page, ordered by revision. */
export type AdministratorAuditPage = {
  /** Events after the requested revision cursor. */
  items: AdministratorAuditEvent[];
  /** Exclusive revision cursor, if another page exists. */
  nextCursor?: number;
};
