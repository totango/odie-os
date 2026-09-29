import type { CodeRecoverySnapshot } from './features/code/otClient'

export const RECOVERY_NOTICE = 'Manual recovery only. This is a local snapshot, not proof of server acknowledgement or a cutover clearance. Export every relevant chat separately. Save/export gadget-local iframe state using the gadget itself; postpone cutover for unresolved sessions. Attachments must be reattached from originals. Review sensitive text before saving or sharing.'

/**
 * One chat's uncommitted code as its OT client sees it locally. `code` is the client's own bounded
 * copy (see `ChatOtClient.captureRecovery`), so it carries base commits and an acknowledgement
 * label rather than a server receipt; it is null when nothing is unacknowledged.
 */
export type EditorRecovery = {
  kind: 'editor'
  chatId: number | null
  branch: { kind: 'mainline' | 'chat'; chatId: number | null }
  sending: boolean
  code: CodeRecoverySnapshot | null
}

export type ComposerRecovery = {
  kind: 'composer'
  chatId: number | null
  text: string
  sending: boolean
  attachments: Array<{ name: string | null; mimeType: string; bytes: number; state: string; omitted: true }>
  omittedCapsules: number
}

export type RecoverySource = (EditorRecovery | ComposerRecovery) & {
  workspaceId?: string | null
  sourceCapturedAt?: string
  retainedAfterPause?: boolean
}
export type RecoveryBundle = {
  format: 'workshop-manual-recovery'
  version: 1
  capturedAt: string
  workspaceId: string | null
  notice: string
  uncertainty: string[]
  sources: RecoverySource[]
}

/** Export visible prose, never capsule descriptions/URLs, RPC handles or attachment references. */
export function recoveryComposerText(text: string, capsules: readonly { start: number; length: number }[]): string {
  let result = text
  for (const capsule of capsules.toSorted((a, b) => b.start - a.start)) {
    result = result.slice(0, capsule.start) + '[resource omitted; reconnect manually]' + result.slice(capsule.start + capsule.length)
  }
  return result
}

export function createRecoveryBundle(workspaceId: string | null, sources: RecoverySource[]): RecoveryBundle {
  return {
    format: 'workshop-manual-recovery', version: 1, capturedAt: new Date().toISOString(), workspaceId,
    notice: RECOVERY_NOTICE,
    uncertainty: [
      'Server persistence and connection/fence status are unknown. A base commit, revision or "accepted-awaiting-replay" label is what this client last observed, not an acknowledgement.',
      'Only currently mounted Workshop sources and the selected chat are captured. Other chats, workpieces, tabs and devices are not covered.',
      'An in-flight submission may already have reached the server. Compare server state manually before copying or sending anything.',
      'The editor copy is bounded and sparse: it covers paths this chat touched, and `omitted`/`omittedBases` count what was dropped. An absent file is not a deletion instruction.',
      'Attachment bytes/handles, resource capabilities, console logs and gadget-local iframe state are omitted. Format and slash-command bindings are not restored.',
      'Files still being prepared for attachment may not yet appear in the manifest; keep all original attachments.',
      ...(!sources.some(source => source.kind === 'editor') ? ['Editor not available in this snapshot.'] : []),
      ...(!sources.some(source => source.kind === 'composer') ? ['Composer not available in this snapshot.'] : []),
    ],
    sources,
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Self-contained offline viewer + lossless JSON payload. No script, links, network or import/replay path. */
export function recoveryBundleHtml(bundle: RecoveryBundle): string {
  const section = (title: string, text: string) => `<section><h2>${escapeHtml(title)}</h2><pre tabindex="0">${escapeHtml(text)}</pre></section>`
  const sources = bundle.sources.map(source => {
    const identity = section(`${source.kind} source`, JSON.stringify({
      workspaceId: source.workspaceId ?? bundle.workspaceId,
      chatId: source.chatId,
      capturedAt: source.sourceCapturedAt ?? bundle.capturedAt,
      retainedAfterPause: source.retainedAfterPause ?? false,
    }, null, 2))
    if (source.kind === 'composer') {
      return identity + section('Composer text', source.text)
        + section('Omitted attachments', JSON.stringify(source.attachments, null, 2))
    }
    const state = section('Editor state', JSON.stringify({
      branch: source.branch,
      sending: source.sending,
      acknowledgement: source.code?.acknowledgement ?? null,
      generation: source.code?.generation ?? null,
      revision: source.code?.revision ?? null,
      bases: source.code?.bases ?? [],
      omittedBases: source.code?.omittedBases ?? 0,
      omittedFiles: source.code?.omitted ?? 0,
    }, null, 2))
    const files = (source.code?.files ?? [])
      .map(file => section(`${file.gadgetId} / ${file.path}`, file.text)).join('')
    return identity + state + files
  }).join('')
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Workshop recovery v1</title>
<style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid;padding:1rem}section{margin-block:2rem}</style>
</head><body><h1>Workshop manual recovery — v1</h1>
<p>${escapeHtml(bundle.notice)}</p>
<p>Open this saved file in a browser offline. Select and copy text below. Compare with the intended workspace/chat before manually pasting; nothing here writes to Workshop.</p>
${section('Scope and uncertainty', JSON.stringify({ workspaceId: bundle.workspaceId, capturedAt: bundle.capturedAt, uncertainty: bundle.uncertainty }, null, 2))}
${sources}
${section('Versioned bundle JSON (complete metadata and exact text)', JSON.stringify(bundle, null, 2))}
</body></html>`
}
