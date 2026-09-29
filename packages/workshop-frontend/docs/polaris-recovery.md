# Manual client recovery (v1)

Frontend-only local export. **Not** a fence, a write pause, a server backup, or cutover clearance.

Originally written against deployed `aa485877` (Yjs code sync) and carried onto the Git/OT
integration, where the editor source of truth is `ChatOtClient` rather than a `Y.Doc`. The bundle
format stays `workshop-manual-recovery` v1; its editor payload is now the OT client's own bounded
copy. See `polaris-production-cutover.md` for the operator procedure this feeds.

## Investigation

- `features/code/WorkpieceCodeInterface` tracks one `ChatOtClient` per chat (`features/code/otClient.ts`). Its content is *sparse*: for each covered workpiece it holds the epoch's touched paths, and stays silent about the rest (an unpinned gadget tracks mainline head live). Exporting only the visible file, or a diff, would not preserve materialized work. Branch identity is the chat ID; there is no independent branch ID to invent.
- `ChatOtClient.captureRecovery()` reads the client's local buffers synchronously and returns `null` when nothing is unacknowledged. It reuses the same bounded copy the client already produces before destructive state replacement (`#saveRecovery`), so export and rejection-time recovery cannot diverge. It neither flushes the submission queue nor waits for acknowledgement.
- `bases`, `generation`, `revision` and `acknowledgement` describe what this client last **observed**. `accepted-awaiting-replay` means the server accepted a submission whose row has not been replayed back; it is not proof of durability.
- `features/chat/composer/ChatComposer` holds the live draft and attachment blobs/handles. `composerDraft` storage is best effort; its capsule serialization substitutes resource URLs, so recovery deliberately does **not** reuse that serializer. Capsule ranges become an omission marker instead.
- `fileTransfers` delegates to `getWorkshopRuntime()`. Recovery uses the same runtime's awaited `saveBlob` path to handle failures (the existing `saveTextToFile` wrapper discards the promise).
- Auth uses React Activity to suspend effects; required-connection failures can unmount content entirely. Recovery therefore lives outside those gates. No change was made to either gate's authority decisions or RPC lifecycle.

## API and lifecycle

`RecoveryProvider` owns a bounded in-memory registry: at most one editor and one composer source. `useRecoverySource(kind, capture)` registers a synchronous, local reader. `RecoveryWorkspace` supplies the non-capability workspace ID. On Activity suspension or unmount the reader is replaced by a **value-only** snapshot, timestamped and marked `retainedAfterPause`; RPC objects, OT clients, blobs, and closures over them are not retained in that frozen entry. Resuming installs a live reader again.

The root provider is outside the auth Activity. Its identity key clears everything on verified owner change; logout/auth-error paths unmount it. Route pathname changes replace the registry and clear the review panel without remounting the authenticated application. It is not a history/archive of all chats. A missing source is explicitly reported. Composer-only use outside the root provider has a local control as a fallback.

`createRecoveryBundle()` emits `format: workshop-manual-recovery`, `version: 1`:

- capture timestamp, optional top-level workspace ID and per-source workspace IDs;
- editor chat ID, explicit mainline/chat branch descriptor, sending flag;
- the OT client's `CodeRecoverySnapshot` (or `null`): per-workpiece file paths and full text, base commits, generation, revision, client id/seq, an `acknowledgement` label, and `omitted`/`omittedBases` counts for what the 1 MiB / 100-entry bounds dropped;
- live composer text (capsules omitted), chat ID, sending flag, attachment **omission manifest** (name, MIME type, size, upload state); no attachment payload, handle, preview URL, or upload error;
- explicit uncertainty and manual-recovery instructions.

No RPC/schema/backend change. No replayable change payload or import API. No read of cookies, credentials, share fragments, location URLs, browser storage, logs, resource descriptions, or arbitrary gadget DOM. Full user-authored source and draft text may itself contain secrets: the review warning is essential; this is **not a secret scanner or redactor**. Preserve full text rather than silently damaging it. Keep bundles private.

## UX / manual recovery

1. Keep the old tab open. Open **Recovery export (local/offline)**, available even while the session is waiting/paused.
2. Click **Capture recovery snapshot**. Review the copyable JSON, identities, timestamps, retained flags, acknowledgement label, bases and omission counts. This capture is immutable; recapture after further edits.
3. Click **Download offline recovery bundle**. Open and inspect `workshop-recovery-v1.html` locally before leaving the original tab. Browsers cannot prove that a download was saved, so the UI never claims a durable backup.
4. The file is a self-contained HTML viewer containing full versioned JSON and selectable file/draft text. It needs no application server, script, network, browser storage, or login. Everything is HTML-escaped; CSP denies network/script/forms/base URLs. It neither executes exported code nor writes anything to Workshop.
5. If download fails, select/copy the JSON into a local text file. Discarding clears the panel's captured copy; closing the page loses unsaved in-memory recovery state.
6. After the separately coordinated cutover, compare against the correct workspace/chat's current server state. Manually copy only the intended text, and reattach originals/reselect resources and commands. Inspect deletions/renames yourself; a path absent from the snapshot is **not** a deletion instruction — the copy is sparse and bounded.

Export each relevant chat/tab before switching. Other chats, other workpieces the chat never touched, other devices, and changes received after suspension are not recovered by this snapshot. Source timestamps can differ after a pause; this is not a transactional server backup.

The editor panel separately offers **Export local code** when the OT client hands back a recovery copy before a destructive state replacement (a remote generation change or hard rejection). That path and this one read the same bounded copy; neither replays edits.

## Backend-fence coordination / cutover blockers

This frontend work does not implement a fence, pause writes, or certify safe migration. The existing editor sender/reconnection retry behavior remains unchanged. Recovery itself adds **no** write replay. The backend fence owner must independently fence old authority and handle requests already in flight; an empty queue or a fulfilled client RPC is not cutover clearance. Keep recovery UI outside any future paused/fenced rendering boundary.

The release/cutover coordinator must collect user confirmation that downloaded bundles were opened and checked, attachment originals are available, and gadget-local iframe state was saved/exported **using each gadget's own UI**. No host DOM probing or generic iframe extraction is permitted. **Postpone cutover for unresolved sessions**, missing sources, unreviewed in-flight uncertainty, or gadget-local state without a verified save/export.

A deployed client cannot be retrofitted with export code: users already on an older build must preserve work through the surfaces that build offers before they reload.

## Verification

Tests drive a real `ChatOtClient` against an in-test server: an unresolved submission captured as `unconfirmed` with full local text, an accepted-but-unreplayed submission captured as `accepted-awaiting-replay`, `null` when nothing is unacknowledged, immutable captures, a blocked live composer with unavailable storage and no RPC, attachment handle/payload omission, Activity suspension retention and scope clearing, download-failure fallback, hostile content escaping, and an exact JSON round-trip through the offline viewer.

Run `pnpm --filter @gadgets/workshop-frontend test:run` and both frontend `tsc` projects. A real-browser download/save/open smoke check remains a release prerequisite.
