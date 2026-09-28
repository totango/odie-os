# Production Git/OT and OAuth cutover gate

**Release is blocked until real reviewed evidence is supplied.** This document is an operator
procedure, not a completed pause, backup, recovery rehearsal, or deployment approval. No production
confirmation record is committed. The gate implements ADR E in `polaris-upstream-integration.md`.

## Enforced deployment behavior

`build-production-deploy.mjs` always emits the backend with
`WORKSHOP_EDITING_PAUSED: "true"`, regardless of the checked-in default. It seals the complete
artifact (all modules, assets and configs) and the compatibility-source fingerprint into
`cutover-artifact.json`. The normal source config remains unset: **source defaults do not authorize
artifact deployment**. No builder flag or environment switch enables writes.

The production workflow validates `POLARIS_CUTOVER_RECORD` before its first provider deployment or
secret mutation. An absent, malformed, stale first-cutover, mismatched, or incomplete record stops
the job. Artifacts built without approval are safe to inspect/download but remain paused and cannot
pass the deployment gate. Only the validator removes the pause from a verified artifact.

The record must be provisioned by authorized administrators in the GitHub **production environment
variable**, with environment required reviewers and deployment-branch restrictions configured by
the operator. Do not accept a PR file, workflow input, artifact-supplied record, or secret-bearing
URL as approval. A record is an operator attestation: the validator checks its schema, provenance,
digests, time window, ancestry, and presence of required evidence; it does **not** fetch evidence
URLs or prove that an operator actually performed the operations. Reviewers must inspect the
referenced immutable evidence and independently recompute its SHA-256 before issuing the record.
The workflow never creates or promotes its own approval record.

| Dispatch phase | Required record | Result |
| --- | --- | --- |
| `prepare` (manual) | Fresh `prepared`, exact target SHA **and artifact digest** | Full provider/backend/router deployment stays write-paused. |
| `resume` (manual) | Fresh `completed`, exact target SHA and artifact digest, deployed-version and post-deploy evidence | Authorized artifact can enable writes. Only use after the identical artifact was deployed paused and verified. |
| `routine` (automatic/default) | `completed`, prior successful resume receipt, completed target is an ancestor of current target, identical compatibility fingerprint | Normal releases can deploy after verified cutover, without repeating the first-cutover outage. |

For `prepare`/`resume`, approval expires within 24 hours of review. A routine record can persist
after that window, but must include a real successful `resumeReceipt`; completion evidence without
that receipt cannot authorize the automatic path. Removing the environment record blocks further
deployments. It does not pause an already deployed service.

The compatibility fingerprint covers the shared API/gatekeeper interfaces, editing protocol,
Git migration, backend handoff, kit handshake, and production gate/builder/workflow sources listed
in `production-cutover.mjs`.
Changes there fail closed until renewed reviewed evidence is issued. This is a conservative
mechanical compatibility boundary, not proof that every other change is backward compatible.
Reviewers must treat a breaking change elsewhere as a new cutover, update the boundary/epoch, and
obtain new evidence. An unrelated frontend/ordinary implementation release with unchanged contract
and verified ancestry can use the routine path. Do not disable the gate to ship a contract fix.

## Real operations before the first provider changes

1. Freeze the candidate commit on main and its CI result. Download the build job's paused artifact;
   record `targetSha`, `artifactSha256`, `contractSha256`, and `epoch` from its descriptor. The
   build job can finish even when the deployment gate fails; absence of approval never requires
   issuing a dummy record. If rebuilding produces different bytes, review the new artifact digest.
2. Inventory actual deployed backend/provider/router/native-client versions and DO migration tags.
   Verify the original backend and every admitted old browser/native client version, rather than
   assuming the checkout describes production. Identify active agents, sessions, edits, callbacks,
   and independent Context Git credentials. Capture the pinned old-client commit/build IDs.
3. Establish a compatible **preparatory release or proven old-client recovery path** before the
   breaking candidate. Demonstrate user-controlled export of editor/composer drafts and pending
   edits with base/revision/acknowledgement metadata, then demonstrate recovery from the export.
   Record both the old-client and recovery/preparatory-release commits. No forced page refresh,
   synthetic unit fixture alone, or empty export substitutes for this evidence. If that release
   has not been implemented and deployed, stop here: this workflow is not a preparatory-release
   bypass and must not deploy the incompatible candidate in its place.
4. Apply the reviewed admission fence to the **currently deployed** compatible system: stop new
   editing/agent operations and incompatible OAuth initiation, including native surfaces. Prove
   existing sockets and agents cannot keep writing; a load-balancer/UI-only pause is insufficient.
   Preserve recovery/export access and old callback consumers. The new candidate's editing pause
   is only defense in depth: it is not proof of an old-version fence, and is not an OAuth pause.
5. Drain, complete, cancel, or explicitly account for all in-flight writes. Let previously admitted
   OAuth callbacks finish or expire under their original bounded lifetimes and original consumer.
   Record zero outstanding unaccounted operations and demonstrate one-use/expiry/replay behavior.
   Do not reinterpret old state, extend expiry, or replay uncertain writes.
6. Take a coordinated restorable snapshot/export during the write-free window. Record its immutable
   identifier, scope, timestamp, encryption/access custody, and a successful restore rehearsal.
   Keep actual credentials and bearer links out of this record and workflow output.
7. Rehearse migration using representative snapshot copies: accepted/pending content, orphan roots,
   live drafts, compaction, blueprint pins, interrupted reruns, and exact semantic inventories.
   Execute both directions of client/backend and provider/backend compatibility, browser/native
   callbacks, expiry/replay and recovery. Verify private catalog authorization/provenance.
8. K/F/C/T reviewers inspect all evidence, including the deployment ordering. Record the actual
   coordinator loop ordinal (1–20); never reset it or invent a value to bypass the cap. An independent
   reviewer is required (at least two distinct reviewer identifiers). Obtain the `prepared` record
   for this exact artifact and install it in the protected environment. Dispatch `prepare`.

These preconditions must already hold before the workflow can deploy **any** provider. Provider-first
ordering alone does not make mixed OAuth protocols safe. If a compatible old-client recovery release,
old-backend fence, or drain mechanism is unavailable, that is an **external release blocker**; this
tooling change does not implement or claim those runtime capabilities.

## Verify while paused, then explicitly resume

1. Keep the external admission/OAuth fence in place throughout `prepare`. Confirm all provider,
   backend and router deployment receipts refer to the pinned artifact. Preserve the gate receipt
   with the deployment receipts. A partial or failed deployment must remain paused and must not
   receive a completion record.
2. Run the approved paused-state migration/compatibility verification. Confirm actual deployed
   versions, migration results, recoverable drafts, owner/role boundaries, catalog provenance and
   callbacks. Account for any triggered migration writes. Merely getting HTTP 200/302 is not enough.
3. Obtain a fresh `completed` record for the same target/digest, adding `deployedVersions` and
   `postDeployVerification` evidence. Dispatch `resume` at that same target. If main has moved,
   the existing current-main checks stop this: coordinate a new pinned candidate/evidence rather
   than altering SHAs in the record. The resume workflow redeploys the verified target; do not
   mistake it for validation of an untested new version.
4. Confirm the full resume workflow succeeded and fresh authenticated editing works on the approved
   protocol. Only then lift the external admission/OAuth fence. Capture actual deployment and
   resume receipts, then add `resumeReceipt` evidence to the completed record for routine releases.
   Until that record is installed, automatic deployment remains blocked.
5. After new Git/OT writes, an old binary is not a rollback plan. Prefer forward repair. A snapshot
   restoration requires a new coordinated write-free window and accounting for subsequent writes.
   Failure during resume: re-establish the external fence immediately, investigate exact receipts,
   and renew evidence; never reuse a `prepared` record to justify enabling writes.

## Confirmation-record schema (version 1)

There is deliberately no copy/paste success record. The validator and synthetic unit fixtures are
in `scripts/production-cutover.mjs` / `.test.ts`; tests are not deployment evidence.

| Field | Required value/type |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `deployment` | `odie-os-production` |
| `epoch` | `polaris-git-ot-oauth-v1` |
| `status` | `prepared` or `completed` |
| `targetSha` | Full lowercase 40-hex commit SHA of the approved cutover |
| `artifactSha256` | SHA-256 from the exact paused artifact descriptor |
| `contractSha256` | Compatibility fingerprint from that descriptor |
| `reviewedAt` | Parseable UTC timestamp, not in the future |
| `expiresAt` | For prepare/resume: after current time and no later than reviewedAt + 24h |
| `orchestrationLoop` | Actual coordinator ledger ordinal, integer 1–20 |
| `reviews` | Required `K`, `F`, `C`, `T` reviewer IDs, each 1–80 alphanumeric/dot/underscore/hyphen characters; at least two distinct |
| `oldClientSha` | Full 40-hex SHA of pinned deployed old client |
| `recoveryClientSha` | Full 40-hex SHA of validated recovery/preparatory client |
| `recoveryPath` | `pinned-old-client-export` or `preparatory-release` |
| `evidence` | Named records below; each `{ "url": HTTPS location, "sha256": 64-hex digest }`; no URL credentials, query or fragment |

Prepared evidence keys: `pauseFence`, `drain`, `backupRestore`, `clientRecovery`, `oauthMatrix`,
`catalogProvenance`, `deploymentHistory`, `migrationRehearsal`. Completed adds `deployedVersions`
and `postDeployVerification`. Routine requires all completed keys **plus** `resumeReceipt`.
Store immutable evidence in the approved access-controlled system; the URL is a locator, not a
credential. The deployment job outputs only target/digests/phase/pause decision and record digest.

## Outstanding external evidence and review

No verified production fence, drain, backup/restore, pinned old-client recovery/preparatory release,
mixed OAuth matrix, migration rehearsal, deployment receipts, or completed cutover record has been
supplied in this task. GitHub production environment protection must also be verified by the
operator. **The first production deployment remains gated.** Local schema/security tests demonstrate
fail-closed tooling behavior; they do not certify operational readiness or independent approval.
