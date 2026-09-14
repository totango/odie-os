# Context Library ownership and administrator cutover

Accounts own private collections within `sharingDomain`; the domain registry owns public discovery. Contents live in `ContextCollectionDurableObject`. Public reads and bundled immutable context remain available without administrator authority.

## Resource-owner enforcement

Public collection initialization, metadata/document mutations, manual Git synchronization, token issuance/list/revoke and deletion require backend-issued current `context-public` authorization at the collection owner. Public registry insertion/removal requires the same authorization. Current UI wrappers forward an immutable purpose capability; old boolean children omit it and fail closed at owners. Legacy boolean opens retain private management and public reads only.

Private owner operations never consult administrator authority. The account wrapper checks ownership before forwarding. Account revocation cannot delete public collections. Bundled content cannot be edited even by administrators. Checks ordered before administrator revocation may finish; this is not cancellation or rollback of already-admitted work.

## Git credentials are independent

Public means public **read**, not public write. Git tokens are secret independent write credentials, valid until expiry or explicit token revocation. Administrator removal denies new privileged issuance/list/revoke operations but does **not** revoke previously issued tokens. Current administrators manage/revoke public tokens explicitly; private owner tokens remain unchanged. No activation/startup/deployment operation retires tokens or deletes content.

## Provider-first readiness

The binding-only vendor `adminFenceReadiness` uses the binding's actual normalized domain. The registry scans all currently indexed public owners (maximum 1,000; larger inventories fail closed), verifies each owner's identity/domain/fence version and returns a stable registry revision and inventory digest. Missing/private/mismatched owners or concurrent registry writes deny. No Git credential operation is involved.

Backend requires two complete matching scans with distinct fresh epoch/revision-bound nonces, then atomically records the provider baseline with managed activation. Missing/old providers and changed domains/versions deny; no browser/env boolean or positive cache can clear the gate. See [full evidence, semantics and rollback contract](../../docs/plans/hugin-community-requests/legacy-owner-fencing.md).

## Deployment and rollback

Keep existing Worker/service/DO names, namespaces, sharing domains and migration history. Deploy Context/JARVIS resource-owner enforcement before consumer cutover within the single authorized release. No new production binding/class migration is required. The registry adds a revision singleton; authority adds its baseline only with successful activation.

Tests exercise old wire shapes against current owners and actual provider delegation, not generic Cloudflare version-pinning/transitive native drain. Never route an attested namespace back to unfenced code after managed activation. Preserve authority generations and baseline; stop admissions and roll forward. Restart/rollback neither revokes independent Git tokens nor undoes admitted external writes. No live cutover or token mutation was performed here.
