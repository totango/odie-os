import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { File, FileImage, FileVideo, Paperclip, Trash } from '@phosphor-icons/react'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  COMMUNITY_REQUEST_ATTACHMENT_TYPES, COMMUNITY_REQUEST_LIMITS as LIMITS,
  type CommunityRequestAttachment,
} from '@gadgets/workshop-shared/community-requests'
import { useAuthenticatedApi } from '../AuthContext'

export type CommunityAttachmentDraft = { idempotencyKey: string; file: File }

const ACCEPTED_TYPES = Object.keys(COMMUNITY_REQUEST_ATTACHMENT_TYPES)
const alwaysActive = () => true

function attachmentMimeType(file: File): string {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase()
  if (ACCEPTED_TYPES.includes(declared)) return declared
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
  return Object.entries(COMMUNITY_REQUEST_ATTACHMENT_TYPES)
    .find(([, extensions]) => (extensions as readonly string[]).includes(extension))?.[0] ?? ''
}

export async function uploadCommunityAttachmentDrafts(
  api: Pick<AuthenticatedApi, 'addCommunityRequestAttachment'>,
  requestId: string,
  drafts: CommunityAttachmentDraft[],
  detailId?: string,
  active: () => boolean = alwaysActive,
): Promise<boolean> {
  for (const draft of drafts) {
    if (!active()) return false
    const content = new Uint8Array(await draft.file.arrayBuffer())
    if (!active()) return false
    await api.addCommunityRequestAttachment(requestId, {
      idempotencyKey: draft.idempotencyKey,
      name: draft.file.name,
      mimeType: attachmentMimeType(draft.file),
      content,
      ...(detailId ? { detailId } : {}),
    })
    if (!active()) return false
  }
  return true
}

export function CommunityAttachmentPicker({ drafts, onChange, disabled = false }: {
  drafts: CommunityAttachmentDraft[]
  onChange: (drafts: CommunityAttachmentDraft[]) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string>()
  function add(files: FileList | null) {
    if (!files) return
    const nextFiles = [...files]
    if (input.current) input.current.value = ''
    if (nextFiles.some(file => file.size < 1 || file.size > LIMITS.attachmentBytes)) {
      setError('Each attachment must be between 1 byte and 25 MB.'); return
    }
    if (nextFiles.some(file => !attachmentMimeType(file))) {
      setError('Choose a supported image, document, or video file.'); return
    }
    const next = [...drafts, ...nextFiles.map(file => ({ idempotencyKey: crypto.randomUUID(), file }))]
    if (next.length > LIMITS.attachmentsPerRequest ||
        next.reduce((bytes, draft) => bytes + draft.file.size, 0) > LIMITS.attachmentBytesPerRequest) {
      setError('A request can contain up to 10 attachments and 100 MB total.'); return
    }
    setError(undefined); onChange(next)
  }
  return <section className="space-y-3" aria-label="Public attachments">
    <div className="flex flex-wrap items-center gap-3">
      <input ref={input} type="file" multiple className="sr-only" aria-label="Choose public attachments"
        accept={ACCEPTED_TYPES.join(',')}
        disabled={disabled} onChange={event => add(event.target.files)} />
      <Button type="button" variant="secondary" disabled={disabled}
        onClick={() => input.current?.click()}><Paperclip size={16} /> Add images, documents, or videos</Button>
      <span className="text-xs text-kumo-subtle">25 MB each · 10 files · 100 MB total</span>
    </div>
    {drafts.length > 0 && <ul className="space-y-2">{drafts.map(draft => <li key={draft.idempotencyKey}
      className="flex items-center gap-2 rounded-lg border border-kumo-line px-3 py-2 text-sm">
      <AttachmentIcon mimeType={draft.file.type} />
      <span className="min-w-0 flex-1 truncate">{draft.file.name}</span>
      <span className="text-xs text-kumo-subtle">{formatBytes(draft.file.size)}</span>
      <button type="button" aria-label={`Remove ${draft.file.name}`} disabled={disabled}
        className="rounded p-1 text-kumo-subtle hover:text-kumo-danger disabled:opacity-50"
        onClick={() => { setError(undefined); onChange(drafts.filter(item => item !== draft)) }}><Trash size={16} /></button>
    </li>)}</ul>}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <p className="text-xs text-kumo-subtle">Files are public to signed-in users and are included in future Auto-Build approval snapshots. Archives, Office files, SVG, and HTML are not accepted.</p>
  </section>
}

export function CommunityAttachmentList({ requestId, attachments, includeHidden = false }: {
  requestId: string
  attachments: CommunityRequestAttachment[]
  includeHidden?: boolean
}) {
  if (!attachments.length) return null
  return <ul className="space-y-2" aria-label="Attachments">{attachments.map(attachment =>
    <CommunityAttachmentItem key={attachment.id} requestId={requestId}
      attachment={attachment} includeHidden={includeHidden} />)}</ul>
}

function CommunityAttachmentItem({ requestId, attachment, includeHidden }: {
  requestId: string
  attachment: CommunityRequestAttachment
  includeHidden: boolean
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [url, setUrl] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setUrl(undefined); setLoading(false); setError(false)
    return () => { if (generation.current === current) generation.current++ }
  }, [authenticatedApi, attachment.id, includeHidden, requestId])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  async function load() {
    if (loading || url) return
    const current = generation.current
    setLoading(true); setError(false)
    try {
      const result = await authenticatedApi.getCommunityRequestAttachment(requestId, attachment.id, includeHidden)
      if (current !== generation.current) return
      setUrl(URL.createObjectURL(new Blob([new Uint8Array(result.content)], { type: result.attachment.mimeType })))
    } catch { if (current === generation.current) setError(true) }
    finally { if (current === generation.current) setLoading(false) }
  }
  const preview = attachment.mimeType.startsWith('image/') ? url &&
    <img src={url} alt={attachment.name} className="mt-2 max-h-80 max-w-full rounded-lg object-contain" /> :
    attachment.mimeType.startsWith('video/') ? url &&
      <video src={url} controls preload="metadata" className="mt-2 max-h-96 max-w-full rounded-lg" /> : null
  return <li className="rounded-lg border border-kumo-line p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <AttachmentIcon mimeType={attachment.mimeType} />
      <span className="min-w-0 flex-1 break-all font-medium">{attachment.name}</span>
      <span className="text-xs text-kumo-subtle">{formatBytes(attachment.byteLength)}</span>
      {!url && <Button type="button" variant="secondary" disabled={loading} onClick={() => void load()}>
        {loading ? 'Loading…' : attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('video/') ? 'Load preview' : 'Prepare download'}
      </Button>}
      {url && <a href={url} download={attachment.name} className="text-kumo-brand hover:underline">Download</a>}
    </div>
    {preview}
    {error && <p role="alert" className="mt-2 text-kumo-danger">Attachment unavailable. Try again.</p>}
  </li>
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <FileImage size={18} />
  if (mimeType.startsWith('video/')) return <FileVideo size={18} />
  return <File size={18} />
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}
