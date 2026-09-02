import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowClockwise, CircleNotch, PaperPlaneRight, Stop, Wrench } from '@phosphor-icons/react'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../WorkshopControls'

const POLL_INTERVAL_MS = 4_000
const EXPIRY_REFRESH_WINDOW_MS = 10_000
const CAPABILITY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_MESSAGE_COUNT = 80
const MAX_TEXT_LENGTH = 16_000
const MAX_PAYLOAD_LENGTH = 4_000
const MAX_TOOL_COUNT = 12

type Capability = { url: string; expiresAt: Date }

type OpenCodeSession = {
  id: string
  title: string
  updatedAt: number
  rawStatus?: string
}

type OpenCodeMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  tools: OpenCodeTool[]
}

type OpenCodeTool = {
  id: string
  name: string
  state?: string
  input?: string
  output?: string
  error?: string
  metadata?: string
}

type WorkbenchSnapshot = {
  sessions: OpenCodeSession[]
  selected?: OpenCodeSession
  messages: OpenCodeMessage[]
  running: boolean
  statusText: string
  diffText?: string
  todoText?: string
  mcpText?: string
}

type Props = {
  sessionId: string
  sessionTitle: string
  initialInput?: string
  onInitialInputSent?: () => void
  onSessionUnavailable?: () => void
  surface?: 'agent' | 'changes'
}

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, ...props }) {
    return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>
  },
  pre({ children, ...props }) {
    return <pre {...props} className="overflow-x-auto rounded-lg bg-kumo-tint p-3 text-[12px] leading-5">{children}</pre>
  },
  code({ children, className, ...props }) {
    return <code {...props} className={`${className ?? ''} rounded bg-kumo-tint px-1 py-0.5 text-[12px]`}>{children}</code>
  },
  img({ alt }) {
    return <span className="text-kumo-subtle">[Image blocked{alt ? `: ${alt}` : ''}]</span>
  },
}

export default function OpenCodeWorkbench(props: Props) {
  const { authenticatedApi } = useAuthenticatedApi()
  return <OpenCodeWorkbenchInner {...props} authenticatedApi={authenticatedApi} />
}

export function OpenCodeWorkbenchInner({
  authenticatedApi,
  sessionId,
  sessionTitle,
  initialInput,
  onInitialInputSent,
  onSessionUnavailable,
  surface = 'agent',
}: Props & { authenticatedApi: Pick<AuthenticatedApi, 'mintCodingSessionOpenCodeCapability'> }) {
  const capabilityRef = useRef<Capability | undefined>(undefined)
  const capabilityPromiseRef = useRef<Promise<Capability> | undefined>(undefined)
  const abortsRef = useRef<Set<AbortController>>(new Set())
  const mountedRef = useRef(true)
  const requestEpochRef = useRef(0)
  const refreshSequenceRef = useRef(0)
  const selectedOpenCodeSessionIdRef = useRef<string | undefined>(undefined)
  const initialSendKeyRef = useRef<string | undefined>(undefined)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({ sessions: [], messages: [], running: false, statusText: 'Connecting…' })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [aborting, setAborting] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const controller of abortsRef.current) controller.abort()
      abortsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    requestEpochRef.current += 1
    refreshSequenceRef.current += 1
    for (const controller of abortsRef.current) controller.abort()
    abortsRef.current.clear()
    capabilityRef.current = undefined
    capabilityPromiseRef.current = undefined
    selectedOpenCodeSessionIdRef.current = undefined
    initialSendKeyRef.current = undefined
    setSnapshot({ sessions: [], messages: [], running: false, statusText: 'Connecting…' })
    setLoading(true)
    setError(undefined)
  }, [sessionId])

  const mintCapability = useCallback(async (expectedEpoch = requestEpochRef.current) => {
    if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const existing = capabilityPromiseRef.current
    if (existing) return existing
    const controller = new AbortController()
    abortsRef.current.add(controller)
    const minting = withTimeout(
      authenticatedApi.mintCodingSessionOpenCodeCapability(sessionId),
      CAPABILITY_TIMEOUT_MS,
      'OpenCode took too long to start. Retry, or restart the coding session if the problem continues.',
      controller.signal,
    ).then((minted) => {
      if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
      const url = new URL(minted.url, window.location.href)
      if (url.origin !== window.location.origin) throw new Error('OpenCode workbench capability was not same-origin.')
      const capability = { url: url.toString(), expiresAt: new Date(minted.expiresAt) }
      capabilityRef.current = capability
      return capability
    }).finally(() => {
      abortsRef.current.delete(controller)
      if (capabilityPromiseRef.current === minting) capabilityPromiseRef.current = undefined
    })
    capabilityPromiseRef.current = minting
    return minting
  }, [authenticatedApi, sessionId])

  const ensureCapability = useCallback(async (expectedEpoch: number) => {
    if (expectedEpoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const current = capabilityRef.current
    if (current && current.expiresAt.getTime() - Date.now() > EXPIRY_REFRESH_WINDOW_MS) return current
    return mintCapability(expectedEpoch)
  }, [mintCapability])

  const fetchJson = useCallback(async (path: string, init: RequestInit = {}, retry = true): Promise<unknown> => {
    const epoch = requestEpochRef.current
    const capability = await ensureCapability(epoch)
    if (epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      controller.abort(timeoutError('OpenCode did not respond in time. Retry the request.'))
    }, REQUEST_TIMEOUT_MS)
    abortsRef.current.add(controller)
    try {
      const response = await fetch(new URL(path.replace(/^\//, ''), capability.url), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        redirect: 'error',
      })
      if (response.status === 403 && retry) {
        if (epoch !== requestEpochRef.current) throw new DOMException('Session changed.', 'AbortError')
        capabilityRef.current = undefined
        return fetchJson(path, init, false)
      }
      if (epoch === requestEpochRef.current && (response.status === 403 || response.status === 410)) onSessionUnavailable?.()
      if (!response.ok) throw new Error(`OpenCode request failed (${response.status}).`)
      if (response.status === 204) return undefined
      const text = await response.text()
      if (!text) return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    } finally {
      window.clearTimeout(timeout)
      abortsRef.current.delete(controller)
    }
  }, [ensureCapability, onSessionUnavailable])

  const refreshWorkbench = useCallback(async (options: { quiet?: boolean } = {}) => {
    const epoch = requestEpochRef.current
    const sequence = ++refreshSequenceRef.current
    if (!options.quiet) setRefreshing(true)
    if (!options.quiet) setError(undefined)
    try {
      const sessionListJson = await fetchJson('/session')
      let sessions = parseSessions(sessionListJson)
      let selected = selectSession(sessions, selectedOpenCodeSessionIdRef.current)
      if (!selected) {
        const created = await fetchJson('/session', {
          method: 'POST',
          body: JSON.stringify({ title: sessionTitle || 'Odie coding session' }),
        })
        const createdSession = parseSession(created)
        if (createdSession) {
          selected = createdSession
          sessions = [createdSession, ...sessions.filter((item) => item.id !== createdSession.id)]
        }
      }
      const selectedId = selected?.id
      const [messagesJson, statusJson, diffJson, todoJson, mcpJson] = selectedId
        ? await Promise.all([
            fetchJson(`/session/${selectedId}/message`),
            fetchJson('/session/status'),
            fetchJson(`/session/${selectedId}/diff`),
            fetchJson(`/session/${selectedId}/todo`),
            fetchJson('/mcp'),
          ])
        : [undefined, undefined, undefined, undefined, undefined]
      const nextSnapshot = {
        sessions,
        selected,
        messages: parseMessages(messagesJson),
        running: parseRunning(statusJson, selected),
        statusText: summarizeStatus(statusJson, selected),
        diffText: summarizeUnknown(diffJson, MAX_PAYLOAD_LENGTH),
        todoText: summarizeUnknown(todoJson, MAX_PAYLOAD_LENGTH),
        mcpText: summarizeUnknown(mcpJson, MAX_PAYLOAD_LENGTH),
      }
      if (!mountedRef.current || epoch !== requestEpochRef.current || sequence !== refreshSequenceRef.current) return
      selectedOpenCodeSessionIdRef.current = selectedId
      setSnapshot(nextSnapshot)
      setLoading(false)
      setError(undefined)
    } catch (caught) {
      if (!mountedRef.current || epoch !== requestEpochRef.current || sequence !== refreshSequenceRef.current || isAbortError(caught)) return
      setLoading(false)
      setError(caught instanceof Error ? caught.message : 'Could not load OpenCode workbench.')
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current && sequence === refreshSequenceRef.current) setRefreshing(false)
    }
  }, [fetchJson, sessionTitle])

  useEffect(() => {
    let timer: number | undefined
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      void refreshWorkbench({ quiet: true }).finally(() => {
        if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS)
      })
    }
    void refreshWorkbench().finally(() => {
      if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    })
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshWorkbench])

  useEffect(() => {
    const node = transcriptRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distanceFromBottom < 160) node.scrollTop = node.scrollHeight
  }, [snapshot.messages])

  const sendPrompt = useCallback(async (text: string, options: { fromInitialInput?: boolean } = {}) => {
    const epoch = requestEpochRef.current
    const selectedId = selectedOpenCodeSessionIdRef.current
    const trimmed = text.trim()
    if (!selectedId || !trimmed || sending || snapshot.running) return
    setSending(true)
    setError(undefined)
    try {
      await fetchJson(`/session/${selectedId}/prompt_async`, {
        method: 'POST',
        body: JSON.stringify({ parts: [{ type: 'text', text: trimmed }] }),
      })
      if (epoch !== requestEpochRef.current || selectedOpenCodeSessionIdRef.current !== selectedId) return
      if (!options.fromInitialInput) setPrompt('')
      if (options.fromInitialInput) onInitialInputSent?.()
      await refreshWorkbench({ quiet: true })
    } catch (caught) {
      if (epoch === requestEpochRef.current && !isAbortError(caught)) {
        if (options.fromInitialInput) initialSendKeyRef.current = undefined
        setError(caught instanceof Error ? caught.message : 'Could not send prompt.')
      }
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) setSending(false)
    }
  }, [fetchJson, onInitialInputSent, refreshWorkbench, sending, snapshot.running])

  useEffect(() => {
    const input = initialInput
    if (surface !== 'agent' || !input || error || !snapshot.selected || snapshot.running || refreshing || sending) return
    const key = `${sessionId}:${snapshot.selected.id}:${input}`
    if (initialSendKeyRef.current === key) return
    initialSendKeyRef.current = key
    void sendPrompt(input, { fromInitialInput: true })
  }, [error, initialInput, refreshing, sending, sessionId, sendPrompt, snapshot.running, snapshot.selected, surface])

  const abortOpenCodeSession = useCallback(async () => {
    const epoch = requestEpochRef.current
    const selectedId = selectedOpenCodeSessionIdRef.current
    if (!selectedId || aborting) return
    setAborting(true)
    setError(undefined)
    try {
      await fetchJson(`/session/${selectedId}/abort`, { method: 'POST', body: '{}' })
      await refreshWorkbench({ quiet: true })
    } catch (caught) {
      if (epoch === requestEpochRef.current && !isAbortError(caught)) setError(caught instanceof Error ? caught.message : 'Could not abort OpenCode session.')
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) setAborting(false)
    }
  }, [aborting, fetchJson, refreshWorkbench])

  const selectedLabel = snapshot.selected?.title ?? 'OpenCode session'
  const sessionOptions = snapshot.sessions.slice(0, 20)

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-kumo-tint/30" aria-label="OpenCode workbench">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:overflow-hidden">
        <main className="min-h-[28rem] min-w-0 flex-1 rounded-xl border border-kumo-line bg-kumo-base lg:min-h-0" aria-label={surface === 'changes' ? 'OpenCode changes' : `${selectedLabel} transcript`}>
          <div className="flex min-h-0 h-full flex-col">
            <div className="flex min-h-10 min-w-0 items-center gap-2 border-b border-kumo-line px-3">
              <div className="min-w-0 flex-1">
                {sessionOptions.length > 1 ? (
                  <select
                    aria-label="OpenCode transcript"
                    className="max-w-full rounded border-0 bg-transparent p-0 text-[13px] font-semibold text-kumo-default outline-none"
                    value={snapshot.selected?.id ?? ''}
                    onChange={(event) => {
                      const selected = sessionOptions.find((session) => session.id === event.currentTarget.value)
                      if (!selected) return
                      selectedOpenCodeSessionIdRef.current = selected.id
                      setSnapshot((current) => ({
                        ...current,
                        selected,
                        messages: [],
                        running: false,
                        statusText: 'Loading transcript…',
                        diffText: undefined,
                        todoText: undefined,
                      }))
                      void refreshWorkbench()
                    }}
                  >
                    {sessionOptions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
                  </select>
                ) : <div className="truncate text-[13px] font-semibold text-kumo-default">{selectedLabel}</div>}
                <div className="truncate text-[11px] text-kumo-subtle">{snapshot.statusText}</div>
              </div>
              {refreshing && <CircleNotch size={13} className="animate-spin text-kumo-subtle" aria-label="Refreshing" />}
              <WorkshopButton aria-label="Refresh OpenCode" disabled={refreshing} onClick={() => void refreshWorkbench()}><ArrowClockwise size={13} /> Refresh</WorkshopButton>
              {snapshot.running && <WorkshopButton aria-label="Abort OpenCode session" disabled={aborting} onClick={() => void abortOpenCodeSession()}><Stop size={13} /> Abort</WorkshopButton>}
            </div>
            {error && (
              <div role="alert" className="flex items-center gap-3 border-b border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">
                <span className="min-w-0 flex-1">{error}</span>
                <WorkshopButton disabled={refreshing} onClick={() => void refreshWorkbench()}>Retry</WorkshopButton>
              </div>
            )}
            {surface === 'changes' ? (
              <ChangesPane diffText={snapshot.diffText} todoText={snapshot.todoText} loading={loading} />
            ) : (
              <>
                <div ref={transcriptRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
                  {loading ? <EmptyState title="Loading OpenCode…" body="Minting a local workbench capability and reading the current transcript." /> : null}
                  {!loading && !error && snapshot.messages.length === 0 ? <EmptyState title="Ready for instructions" body="Send a prompt to start this structured OpenCode session." /> : null}
                  <div className="min-w-0 space-y-3">
                    {snapshot.messages.map((message) => <MessageCard key={message.id} message={message} />)}
                  </div>
                </div>
                <form className="shrink-0 border-t border-kumo-line p-3" onSubmit={(event: FormEvent) => { event.preventDefault(); void sendPrompt(prompt) }}>
                  <label className="sr-only" htmlFor="opencode-prompt">Prompt OpenCode</label>
                  <textarea
                    id="opencode-prompt"
                    className="max-h-40 min-h-20 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-brand"
                    value={prompt}
                    disabled={Boolean(error) || loading || refreshing || sending || snapshot.running || !snapshot.selected}
                    placeholder="Ask OpenCode to inspect, edit, test, or explain…"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                  />
                  <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 text-[11px] text-kumo-subtle">Prompts stay in the session sandbox. Use tool approvals for external actions.</span>
                    <WorkshopButton tone="primary" type="submit" disabled={Boolean(error) || loading || refreshing || sending || snapshot.running || !prompt.trim() || !snapshot.selected}><PaperPlaneRight size={13} /> Send</WorkshopButton>
                  </div>
                </form>
              </>
            )}
          </div>
        </main>

        <aside className="grid gap-3 lg:block lg:min-h-0 lg:overflow-y-auto" aria-label="OpenCode context">
          <ContextCard title="MCP" text={snapshot.mcpText} loading={loading} />
          <ContextCard title="Todo" text={snapshot.todoText} loading={loading} />
          <ContextCard title="Diff" text={snapshot.diffText} loading={loading} />
        </aside>
      </div>
    </section>
  )
}

function MessageCard({ message }: { message: OpenCodeMessage }) {
  const isUser = message.role === 'user'
  return (
    <article className={`min-w-0 rounded-xl border p-3 ${isUser ? 'border-kumo-brand/30 bg-kumo-brand/5' : 'border-kumo-line bg-kumo-base'}`}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">{message.role}</div>
      {message.text && (
        <div className="prose prose-sm max-w-none min-w-0 overflow-hidden text-sm leading-6 text-kumo-default prose-pre:bg-transparent">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={MARKDOWN_COMPONENTS}>{message.text}</ReactMarkdown>
        </div>
      )}
      {message.tools.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.tools.slice(0, MAX_TOOL_COUNT).map((tool) => (
            <div key={tool.id} className="rounded-lg border border-kumo-line bg-kumo-tint/40 px-3 py-2 text-xs text-kumo-default">
              <div className="flex items-center gap-2 font-medium"><Wrench size={13} /> {tool.name} {tool.state && <span className="ml-auto text-kumo-subtle">{tool.state}</span>}</div>
              <ToolDetail label="Error" text={tool.error} tone="danger" />
              <ToolDetail label="Input" text={tool.input} />
              <ToolDetail label="Output" text={tool.output} />
              <ToolDetail label="Metadata" text={tool.metadata} />
            </div>
          ))}
          {message.tools.length > MAX_TOOL_COUNT && <p className="text-[11px] text-kumo-subtle">{message.tools.length - MAX_TOOL_COUNT} more tool entries hidden.</p>}
        </div>
      )}
    </article>
  )
}

function ToolDetail({ label, text, tone }: { label: string; text?: string; tone?: 'danger' }) {
  if (!text) return null
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer text-[11px] font-medium ${tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>{label}</summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-kumo-subtle">{text}</pre>
    </details>
  )
}

function ChangesPane({ diffText, todoText, loading }: { diffText?: string; todoText?: string; loading: boolean }) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 rounded-xl border border-kumo-line bg-kumo-tint/40 p-3 text-xs leading-5 text-kumo-subtle">
        Review OpenCode's current diff here. For a full editor and source control workflow, open browser VS Code from the workbench toolbar.
      </div>
      <ContextCard title="Diff" text={diffText} loading={loading} />
      <ContextCard title="Todo" text={todoText} loading={loading} />
    </div>
  )
}

function ContextCard({ title, text, loading }: { title: string; text?: string; loading: boolean }) {
  return (
    <section className="mb-3 rounded-xl border border-kumo-line bg-kumo-base" aria-label={title}>
      <div className="border-b border-kumo-line px-3 py-2 text-xs font-semibold text-kumo-default">{title}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap p-3 text-xs leading-5 text-kumo-subtle">{loading ? 'Loading…' : text || 'No data reported.'}</pre>
    </section>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="flex h-full min-h-48 items-center justify-center text-center"><div><h2 className="text-sm font-semibold text-kumo-default">{title}</h2><p className="mt-1 max-w-sm text-xs leading-5 text-kumo-subtle">{body}</p></div></div>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException('Request aborted.', 'AbortError')))
    const timer = window.setTimeout(() => finish(() => reject(timeoutError(message))), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function timeoutError(message: string) {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

function parseSessions(input: unknown): OpenCodeSession[] {
  const list = Array.isArray(input) ? input : Array.isArray(readRecord(input)?.data) ? readRecord(input)!.data as unknown[] : Array.isArray(readRecord(input)?.sessions) ? readRecord(input)!.sessions as unknown[] : []
  return list.map(parseSession).filter((item): item is OpenCodeSession => Boolean(item)).toSorted((a, b) => b.updatedAt - a.updatedAt)
}

function parseSession(input: unknown): OpenCodeSession | undefined {
  const record = readRecord(input)
  if (!record) return undefined
  const id = readString(record.id) ?? readString(record.sessionID) ?? readString(record.sessionId)
  if (!id || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return undefined
  const title = readString(record.title) ?? readString(record.name) ?? `Session ${id}`
  const time = readRecord(record.time)
  return { id, title, updatedAt: readTime(record.updatedAt ?? time?.updated ?? record.modifiedAt ?? record.createdAt), rawStatus: readString(record.status) }
}

function selectSession(sessions: OpenCodeSession[], selectedId?: string) {
  return sessions.find((session) => session.id === selectedId) ?? sessions[0]
}

function parseMessages(input: unknown): OpenCodeMessage[] {
  const list = Array.isArray(input) ? input : Array.isArray(readRecord(input)?.data) ? readRecord(input)!.data as unknown[] : Array.isArray(readRecord(input)?.messages) ? readRecord(input)!.messages as unknown[] : []
  return list.slice(-MAX_MESSAGE_COUNT).map((item, index) => parseMessage(item, index))
}

function parseMessage(input: unknown, index: number): OpenCodeMessage {
  const record = readRecord(input) ?? {}
  const info = readRecord(record.info) ?? record
  const role = normalizeRole(readString(info.role) ?? readString(info.type))
  const parts = Array.isArray(record.parts) ? record.parts : Array.isArray(record.content) ? record.content : []
  const error = summarizeUnknown(info.error, MAX_PAYLOAD_LENGTH)
  const textParts = [
    readString(info.text),
    readString(info.message),
    readString(info.content),
    ...parts.map(readPartText),
    error ? `Error: ${error}` : undefined,
  ].filter(Boolean) as string[]
  return {
    id: readString(info.id) ?? readString(info.messageID) ?? `message-${index}`,
    role,
    text: truncateText(textParts.join('\n\n') || summarizeUnknown(input, MAX_PAYLOAD_LENGTH) || '', MAX_TEXT_LENGTH),
    tools: [...parts.map(readPartTool), readPartTool(record)].filter((item): item is OpenCodeTool => Boolean(item)),
  }
}

function readPartText(input: unknown): string | undefined {
  const record = readRecord(input)
  if (!record) return readString(input)
  return readString(record.text) ?? readString(record.content) ?? readString(record.message)
}

function readPartTool(input: unknown): OpenCodeTool | undefined {
  const record = readRecord(input)
  if (!record) return undefined
  const type = readString(record.type)
  const name = readString(record.name) ?? readString(record.tool) ?? readString(record.toolID)
  if (!name && type !== 'tool') return undefined
  const state = readRecord(record.state)
  return {
    id: readString(record.id) ?? `${name ?? 'tool'}-${summarizeUnknown(record.state, 80)}`,
    name: name ?? 'tool',
    state: readString(state?.status) ?? readString(record.state) ?? readString(record.status),
    input: summarizeUnknown(state?.input ?? record.input, MAX_PAYLOAD_LENGTH),
    output: summarizeUnknown(state?.output ?? record.output, MAX_PAYLOAD_LENGTH),
    error: summarizeUnknown(state?.error ?? record.error, MAX_PAYLOAD_LENGTH),
    metadata: summarizeUnknown(state?.metadata ?? record.metadata, MAX_PAYLOAD_LENGTH),
  }
}

function parseRunning(statusJson: unknown, selected?: OpenCodeSession): boolean {
  const status = selectedStatus(statusJson, selected)
  return /running|busy|pending|working|loading|retry/.test(status.toLowerCase())
}

function summarizeStatus(statusJson: unknown, selected?: OpenCodeSession): string {
  return selectedStatus(statusJson, selected) || 'OpenCode ready'
}

function selectedStatus(statusJson: unknown, selected?: OpenCodeSession): string {
  const statuses = readRecord(statusJson)
  const selectedRecord = selected ? readRecord(statuses?.[selected.id]) : undefined
  return readString(selectedRecord?.type) ?? readString(selectedRecord?.status) ??
    readString(selectedRecord?.state) ?? selected?.rawStatus ?? ''
}

function summarizeUnknown(input: unknown, limit = MAX_PAYLOAD_LENGTH): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') return truncateText(input, limit)
  try {
    return truncateText(JSON.stringify(input, jsonReplacer, 2), limit)
  } catch {
    return '[unrenderable payload]'
  }
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'string') return truncateText(value, 800)
  return value
}

function truncateText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function readTime(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') {
    const parsed = Date.parse(input)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function normalizeRole(input?: string): OpenCodeMessage['role'] {
  if (input === 'user' || input === 'assistant' || input === 'system' || input === 'tool') return input
  return 'assistant'
}

function isAbortError(caught: unknown) {
  return caught instanceof DOMException && caught.name === 'AbortError'
}
