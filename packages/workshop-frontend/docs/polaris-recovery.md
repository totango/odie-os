# Preparatory client recovery (v1)

Base: deployed `aa485877`; frontend-only preparation, not the candidate or a cutover/fence implementation.

## Investigation

- `GadgetCodeInterface` keeps a workspace Y.Doc and a root-specific file map. The editable chat branch and streaming preview are separate documents. Exporting only Yjs deltas, or only the visible file, would not preserve materialized work. Branch identity in this client is the chat ID; there is no independent branch ID to invent.
- `updateQueueRef` retains a batch while `updateCode` is in flight and removes it only after resolution. Export reads that queue synchronously, including in-flight entries; it does not flush it or wait for acknowledgement. State vectors describe local documents, **not** server persistence.
- `ChatInput` holds the live draft and attachment blobs/handles. `composerDraft` storage is best effort; its capsule serialization substitutes resource URLs, so recovery deliberately does **not** reuse that serializer. Capsule ranges become an omission marker instead.
- `fileTransfers` delegates to `getWorkshopRuntime()`. Recovery uses the same runtime's awaited `saveBlob` path to handle failures (the existing `saveTextToFile` wrapper discards the promise).
- Auth uses React Activity to suspend effects; required-connection failures can unmount content entirely. Recovery therefore lives outside those gates. No change was made to either gate's authority decisions or RPC lifecycle.

## API and lifecycle

`RecoveryProvider` owns a bounded in-memory registry: at most one editor and one composer source. `useRecoverySource(kind, capture)` registers a synchronous, local reader. `RecoveryWorkspace` supplies the non-capability workspace ID. On Activity suspension or unmount the reader is replaced by a **value-only** snapshot, timestamped and marked `retainedAfterPause`; RPC objects, Y.Docs, blobs, and closures over them are not retained in that frozen entry. Resuming installs a live reader again.

The root provider is outside the auth Activity. Its identity key clears everything on verified owner change; logout/auth-error paths unmount it. Route pathname changes replace the registry and clear the review panel without remounting the authenticated application. It is not a history/archive of all chats. A missing source is explicitly reported. Composer-only use outside the root provider has a local control as a fallback.

`createRecoveryBundle()` emits `format: workshop-manual-recovery`, `version: 1`:

- capture timestamp, optional top-level workspace ID and per-source workspace IDs;
- editor chat ID, explicit mainline/chat branch descriptor, files-root name;
- full file names/text for mainline, editable branch, and streaming preview when locally available, each with a local Yjs state-vector byte array;
- initial-sync-reached flag, last **observed** server version, sending flag, and unacknowledged queue entries (target chat and byte length only, including the in-flight batch);
- live composer text (capsules omitted), chat ID, sending flag, attachment **omission manifest** (name, MIME type, size, upload state); no attachment payload, handle, preview URL, or upload error;
- explicit uncertainty and manual-recovery instructions.

No RPC/schema/backend change. No replayable update bytes or import API. No read of cookies, credentials, share fragments, location URLs, browser storage, logs, resource descriptions, or arbitrary gadget DOM. Full user-authored source and draft text may itself contain secrets: the review warning is essential; this is **not a secret scanner or redactor**. Preserve full text rather than silently damaging it. Keep bundles private.

## UX / manual recovery

1. Keep the old tab open. Open **Recovery export (local/offline)**, available even while the session is waiting/paused.
2. Click **Capture recovery snapshot**. Review the copyable JSON, identities, timestamps, retained flags, initial-sync flag, layers, queue, and omissions. This capture is immutable; recapture after further edits.
3. Click **Download offline recovery bundle**. Open and inspect `workshop-recovery-v1.html` locally before leaving the original tab. Browsers cannot prove that a download was saved, so the UI never claims a durable backup.
4. The file is a self-contained HTML viewer containing full versioned JSON and selectable file/draft text. It needs no application server, script, network, browser storage, or login. Everything is HTML-escaped; CSP denies network/script/forms/base URLs. It neither executes exported code nor writes anything to Workshop.
5. If download fails, select/copy the JSON into a local text file. Discarding clears the panel's captured copy; closing the page loses unsaved in-memory recovery state.
6. After the separately coordinated cutover, compare against the correct workspace/chat/root's current server state. Manually copy only the intended text, and reattach originals/reselect resources and commands. Inspect deletions/renames yourself; absence from a layer is **not** a deletion instruction.

Export each relevant root/chat/tab before switching. Other roots, closed chats, other devices, and changes received after suspension are not recovered by this snapshot. Source timestamps can differ after a pause; this is not a transactional server backup. Local streaming previews can be partial. Initial sync may never have completed. Queue entries for other chats do not imply full snapshots of those chats.

## Backend-fence coordination / cutover blockers

This frontend patch does not implement a fence, pause writes, or certify safe migration. The existing editor sender/reconnection retry behavior remains unchanged. Recovery itself adds **no** write replay. The backend fence owner must independently fence old authority and handle requests already in flight; an empty queue or a fulfilled client RPC is not cutover clearance. Keep recovery UI outside any future paused/fenced rendering boundary.

The release/cutover coordinator must collect user confirmation that downloaded bundles were opened and checked, attachment originals are available, and gadget-local iframe state was saved/exported **using each gadget's own UI**. No host DOM probing or generic iframe extraction is permitted. **Postpone cutover for unresolved sessions**, missing sources, unreviewed in-flight uncertainty, or gadget-local state without a verified save/export. This work does not resolve those blockers and must not be deployed as a candidate automatically.

## Verification

Tests cover an actual unresolved `updateCode` with materialized branch edits and untouched files; hidden Files export; immutable captures and queue resolution; blocked live composer with unavailable storage and no RPC; attachment-handle/payload omission; Activity suspension retention and scope clearing; download failure fallback; hostile content escaping; and exact JSON round-trip in the offline viewer.

Run `pnpm --filter @gadgets/workshop-frontend test:run` and `pnpm --filter @gadgets/workshop-frontend exec tsc --noEmit`. A real-browser download/save/open smoke check and independent review remain release prerequisites; no commit, push, or deploy is part of this preparation.
