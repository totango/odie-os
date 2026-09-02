// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeWorkbenchInner } from './OpenCodeWorkbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtime = vi.hoisted(() => ({
  requestNotificationPermission: vi.fn<() => Promise<boolean>>(async () => true),
  sendNotification: vi.fn<(options: { title: string; body: string }) => Promise<void>>(async () => {}),
}))

vi.mock('../../runtime', () => ({
  getWorkshopRuntime: () => runtime,
}))

type FetchCall = { url: string; init?: RequestInit; body?: unknown }

const fetchCalls: FetchCall[] = []
let handlers: ((url: URL, init?: RequestInit) => Response | Promise<Response>)[] = []

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function noContent(status = 204) {
  return new Response(null, { status })
}

function queue(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  handlers.push(handler)
}

function defaultOpenCodeResponses() {
  queue((url, init) => {
    fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.pathname.endsWith('/session') && init?.method === 'POST') return json({ id: 'created', title: 'Created', updatedAt: '2026-09-01T00:00:00Z' })
    if (url.pathname.endsWith('/session')) return json([{ id: 'older', title: 'Older', updatedAt: '2026-08-31T00:00:00Z' }, { id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z', status: 'idle' }])
    if (url.pathname.endsWith('/message')) return json([
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'Please **fix** it <script>alert(1)</script> ![tracker](https://evil.example/pixel)' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }, { id: 'tool-1', type: 'tool', tool: 'edit', state: { status: 'completed', input: { file: 'src/app.ts', giant: 'x'.repeat(6000) }, output: 'Updated file' } }] },
    ])
    if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
    if (url.pathname.endsWith('/diff')) return json({ files: ['src/app.ts'] })
    if (url.pathname.endsWith('/todo')) return json([{ content: 'Run tests', status: 'pending' }])
    if (url.pathname.endsWith('/mcp')) return json({ servers: [{ name: 'odie', status: 'connected' }] })
    if (url.pathname.endsWith('/prompt_async')) return noContent()
    if (url.pathname.endsWith('/abort')) return noContent()
    return json({ error: 'not found' }, 404)
  })
}

describe('OpenCodeWorkbench', () => {
  let container: HTMLDivElement
  let root: Root
  let mint: ReturnType<typeof vi.fn<(sessionId: string) => Promise<{ url: string; expiresAt: Date }>>>
  let onInitialInputSent: ReturnType<typeof vi.fn<() => void>>
  let onSessionUnavailable: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchCalls.length = 0
    handlers = []
    mint = vi.fn<(sessionId: string) => Promise<{ url: string; expiresAt: Date }>>(async () => ({ url: `${window.location.origin}/gatekeeper/sessions/opencode/token/`, expiresAt: new Date(Date.now() + 60_000) }))
    onInitialInputSent = vi.fn<() => void>()
    onSessionUnavailable = vi.fn<() => void>()
    runtime.requestNotificationPermission.mockClear()
    runtime.sendNotification.mockClear()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const handler = handlers[0] ?? (() => json({ error: 'missing handler' }, 500))
      return Promise.resolve(handler(new URL(String(input), window.location.href), init))
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function render(initialInput?: string) {
    defaultOpenCodeResponses()
    await act(async () => {
      root.render(
        <OpenCodeWorkbenchInner
          authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }}
          sessionId="odie-session"
          sessionTitle="Repair Jarvis"
          initialInput={initialInput}
          onInitialInputSent={onInitialInputSent}
          onSessionUnavailable={onSessionUnavailable}
        />,
      )
    })
    await act(async () => {})
    return container
  }

  async function typePrompt(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('mints a same-origin capability, selects the most recently updated session, and loads context', async () => {
    const rendered = await render()

    expect(mint).toHaveBeenCalledWith('odie-session')
    expect(rendered.textContent).toContain('Newer')
    expect(rendered.textContent).toContain('Please fix it')
    expect(rendered.textContent).toContain('user')
    expect(rendered.textContent).toContain('edit')
    expect(rendered.textContent).toContain('[truncated]')
    expect(rendered.innerHTML).not.toContain('<script>')
    expect(rendered.querySelector('img')).toBeNull()
    expect(rendered.textContent).toContain('Image blocked: tracker')
    expect(rendered.textContent).toContain('Output')
    expect(rendered.textContent).toContain('Run tests')
    expect(rendered.textContent).toContain('odie')
    expect(rendered.querySelector('[aria-label="OpenCode sessions"]')).toBeNull()
    expect(rendered.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')?.value).toBe('newer')
  })

  it('can render the reusable Changes surface from OpenCode diff data', async () => {
    defaultOpenCodeResponses()
    await act(async () => {
      root.render(
        <OpenCodeWorkbenchInner
          authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }}
          sessionId="odie-session"
          sessionTitle="Repair Jarvis"
          surface="changes"
        />,
      )
    })
    await act(async () => {})

    expect(container.querySelector('[aria-label="OpenCode changes"]')).toBeTruthy()
    expect(container.textContent).toContain('Review OpenCode')
    expect(container.textContent).toContain('src/app.ts')
    expect(container.textContent).toContain('Run tests')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('creates an OpenCode session titled from the Odie session when none exist', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session') && init?.method === 'POST') return json({ id: 'created', title: 'Repair Jarvis', updatedAt: '2026-09-01T00:00:00Z' })
      if (url.pathname.endsWith('/session')) return json([])
      if (url.pathname.endsWith('/message')) return json([])
      if (url.pathname.endsWith('/session/status')) return json({ created: { type: 'idle' } })
      return json({})
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session', body: { title: 'Repair Jarvis' } }))
    expect(container.textContent).toContain('Repair Jarvis')
    expect(container.querySelector('[aria-label="OpenCode transcript"]')).toBeNull()
  })

  it('sends prompts with prompt_async and aborts a running session', async () => {
    handlers = []
    let running = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { running = true; return noContent() }
      if (url.pathname.endsWith('/abort')) { running = false; return noContent() }
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Implement tests')
    const send = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Send'))!
    await act(async () => send.click())
    const abort = container.querySelector<HTMLButtonElement>('[aria-label="Abort OpenCode session"]')!
    await act(async () => abort.click())

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/prompt_async', body: { parts: [{ type: 'text', text: 'Implement tests' }] } }))
    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/abort' }))
  })

  it('notifies once when a mounted composer turn completes quickly after submit', async () => {
    handlers = []
    let submitted = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { submitted = true; return noContent() }
      if (url.pathname.endsWith('/message')) return json(submitted
        ? [{ info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: 'Secret model output that must not be notified' }] }]
        : [])
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Prompt body that must not be notified')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(runtime.requestNotificationPermission).toHaveBeenCalledOnce()
    expect(runtime.sendNotification).toHaveBeenCalledOnce()
    expect(runtime.sendNotification).toHaveBeenCalledWith({ title: 'Agent turn complete', body: 'Repair Jarvis' })
    expect(runtime.sendNotification.mock.calls[0][0].body).not.toContain('Secret model output')
    expect(runtime.sendNotification.mock.calls[0][0].body).not.toContain('Prompt body')
  })

  it('does not notify from initial hydration or unrelated child transcript switches', async () => {
    await render()
    expect(runtime.sendNotification).not.toHaveBeenCalled()

    const transcriptPicker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(transcriptPicker, 'older')
      transcriptPicker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(runtime.sendNotification).not.toHaveBeenCalled()
  })

  it('notifies once when a submitted running turn later becomes idle', async () => {
    handlers = []
    let submitted = false
    let running = false
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) { submitted = true; running = true; return noContent() }
      if (url.pathname.endsWith('/message')) return json(submitted ? [{ info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'Prompt' }] }] : [])
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" />)
    })
    await act(async () => {})
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Run tests')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {})
    expect(runtime.sendNotification).not.toHaveBeenCalled()

    running = false
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(runtime.sendNotification).toHaveBeenCalledOnce()
  })

  it('submits with Enter but not Shift+Enter or while composing', async () => {
    await render()
    const textarea = container.querySelector('textarea')!

    await typePrompt(textarea, 'Shift newline')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(fetchCalls).toContainEqual(expect.objectContaining({ url: '/gatekeeper/sessions/opencode/token/session/newer/prompt_async', body: { parts: [{ type: 'text', text: 'Shift newline' }] } }))
  })

  it('guards against duplicate prompt submissions before the sending render commits', async () => {
    let resolvePrompt: ((response: Response) => void) | undefined
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) return new Promise<Response>((resolve) => { resolvePrompt = resolve })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Send once')

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    await act(async () => { resolvePrompt?.(noContent()) })
  })

  it('discovers slash commands, supports keyboard selection, and submits command payloads', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      if (url.pathname.endsWith('/prompt_async') || url.pathname.endsWith('/session/newer/command')) return noContent()
      if (url.pathname.endsWith('/command')) return json({ commands: [{ name: 'review', description: 'Review code' }, { name: 'test', description: 'Run tests' }] })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, '/t fix flaky tests')
    await act(async () => {})

    expect(fetchCalls.some((call) => call.url.endsWith('/command'))).toBe(true)
    expect(container.textContent).toContain('Run tests')

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea.value).toBe('/test fix flaky tests')
    await act(async () => {})

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(fetchCalls).toContainEqual(expect.objectContaining({
      url: '/gatekeeper/sessions/opencode/token/session/newer/command',
      body: { command: 'test', arguments: 'fix flaky tests', parts: [{ type: 'text', text: '/test fix flaky tests' }] },
    }))
  })

  it('adds image attachments and sends them as OpenCode file parts', async () => {
    class ImmediateFileReader {
      result: string | ArrayBuffer | null = null
      #listeners = new Map<string, Array<() => void>>()
      addEventListener(type: string, listener: () => void) {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
      }
      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,iVBORw0KGgo=`
        for (const listener of this.#listeners.get('load') ?? []) listener()
      }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader)
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'bug.png', { type: 'image/png' })

    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(container.textContent).toContain('bug.png')
    const textarea = container.querySelector('textarea')!
    await typePrompt(textarea, 'Use this screenshot')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    const call = fetchCalls.find((item) => item.url.endsWith('/prompt_async'))
    expect(call?.body).toMatchObject({
      parts: [
        { type: 'text', text: 'Use this screenshot' },
        { type: 'file', mime: 'image/png', filename: 'bug.png' },
      ],
    })
    const body = call?.body as { parts: Array<{ url?: string }> } | undefined
    expect((body?.parts[1].url ?? '').startsWith('data:image/png')).toBe(true)
    expect(container.textContent).not.toContain('bug.png')
  })

  it('rejects image data that does not match its declared file type', async () => {
    class InvalidFileReader {
      result: string | ArrayBuffer | null = null
      #listeners = new Map<string, Array<() => void>>()
      addEventListener(type: string, listener: () => void) {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
      }
      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,dGV4dA==`
        for (const listener of this.#listeners.get('load') ?? []) listener()
      }
    }
    vi.stubGlobal('FileReader', InvalidFileReader)
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!

    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['text'], 'fake.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not contain valid PNG image data')
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  })

  it('shows an aria-live working indicator while running or sending', async () => {
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'busy' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const indicator = container.querySelector('[aria-live="polite"]')
    expect(indicator?.textContent).toContain('Agent is working…')
  })

  it('remints and retries once on an expired capability response', async () => {
    mint.mockResolvedValueOnce({ url: `${window.location.origin}/gatekeeper/sessions/opencode/old/`, expiresAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ url: `${window.location.origin}/gatekeeper/sessions/opencode/new/`, expiresAt: new Date(Date.now() + 60_000) })
    let first = true
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init })
      if (first) { first = false; return noContent(403) }
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    expect(mint).toHaveBeenCalledTimes(2)
    expect(fetchCalls[0].url).toContain('/old/session')
    expect(fetchCalls[1].url).toContain('/new/session')
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('does not retry a stale session generation', async () => {
    handlers = []
    queue(() => noContent(410))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {})

    expect(mint).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('OpenCode request failed (410).')
  })

  it('bounds capability startup and can retry after it times out', async () => {
    mint.mockImplementationOnce(() => new Promise(() => {}))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(container.textContent).toContain('OpenCode took too long to start.')
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!

    defaultOpenCodeResponses()
    mint.mockResolvedValue({ url: `${window.location.origin}/gatekeeper/sessions/opencode/token/`, expiresAt: new Date(Date.now() + 60_000) })
    await act(async () => retry.click())
    await act(async () => {})

    expect(mint).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Please fix it')
    expect(container.textContent).not.toContain('OpenCode took too long to start.')
  })

  it('aborts an OpenCode HTTP request that does not respond', async () => {
    handlers = []
    queue((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    expect(container.textContent).toContain('OpenCode did not respond in time.')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Retry')).toBe(true)
  })

  it('sends initial input exactly once across rerenders', async () => {
    await render('Initial repair prompt')
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair Jarvis" initialInput="Initial repair prompt" onInitialInputSent={onInitialInputSent} />)
    })
    await act(async () => {})

    const promptCalls = fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].body).toEqual({ parts: [{ type: 'text', text: 'Initial repair prompt' }] })
    expect(onInitialInputSent).toHaveBeenCalledOnce()
  })

  it('waits until the selected OpenCode session is idle before sending initial input', async () => {
    let running = true
    handlers = []
    queue((url, init) => {
      fetchCalls.push({ url: url.pathname, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname.endsWith('/session')) return json([{ id: 'newer', title: 'Newer', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ newer: { type: running ? 'busy' : 'idle' } })
      if (url.pathname.endsWith('/prompt_async')) return noContent()
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" initialInput="Queued repair" onInitialInputSent={onInitialInputSent} />)
    })
    await act(async () => {})
    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(0)

    running = false
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(fetchCalls.filter((call) => call.url.endsWith('/prompt_async'))).toHaveLength(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
  })

  it('aborts stale requests when the Odie session changes', async () => {
    mint.mockImplementation(async (id: string) => ({
      url: `${window.location.origin}/gatekeeper/sessions/opencode/${id}/`,
      expiresAt: new Date(Date.now() + 60_000),
    }))
    let oldAborted = false
    handlers = []
    queue((url, init) => {
      if (url.pathname.includes('/old-session/')) {
        return new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () => {
            oldAborted = true
            resolve(noContent(499))
          })
        })
      }
      if (url.pathname.endsWith('/session')) return json([{ id: 'new-session', title: 'New transcript', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ 'new-session': { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="old-session" sessionTitle="Old" />)
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="new-session" sessionTitle="New" />)
    })
    await act(async () => {})

    expect(oldAborted).toBe(true)
    expect(container.textContent).toContain('New transcript')
    expect(container.textContent).not.toContain('Old transcript')
  })

  it('does not remint or report a late stale response after the Odie session changes', async () => {
    let releaseOld: (() => void) | undefined
    mint.mockImplementation(async (id: string) => ({
      url: `${window.location.origin}/gatekeeper/sessions/opencode/${id}/`,
      expiresAt: new Date(Date.now() + 60_000),
    }))
    handlers = []
    queue((url) => {
      if (url.pathname.includes('/old-session/')) {
        return new Promise<Response>((resolve) => { releaseOld = () => resolve(noContent(403)) })
      }
      if (url.pathname.endsWith('/session')) return json([{ id: 'new-session', title: 'New transcript', updatedAt: '2026-09-01T00:00:00Z' }])
      if (url.pathname.endsWith('/session/status')) return json({ 'new-session': { type: 'idle' } })
      return json([])
    })

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="old-session" sessionTitle="Old" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="new-session" sessionTitle="New" onSessionUnavailable={onSessionUnavailable} />)
    })
    await act(async () => {})
    await act(async () => releaseOld?.())

    expect(mint.mock.calls.map(([id]) => id)).toEqual(['old-session', 'new-session'])
    expect(onSessionUnavailable).not.toHaveBeenCalled()
    expect(container.textContent).toContain('New transcript')
  })

  it('does not let a slower refresh overwrite a newly selected OpenCode transcript', async () => {
    let slowA = false
    let releaseA: (() => void) | undefined
    handlers = []
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([
        { id: 'session-a', title: 'Transcript A', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'session-b', title: 'Transcript B', updatedAt: '2026-08-31T00:00:00Z' },
      ])
      if (url.pathname.endsWith('/session-a/message') && slowA) {
        return new Promise<Response>((resolve) => { releaseA = () => resolve(json([{ info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'Stale A' }] }])) })
      }
      if (url.pathname.endsWith('/session-a/message')) return json([{ info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current A' }] }])
      if (url.pathname.endsWith('/session-b/message')) return json([{ info: { id: 'b1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current B' }] }])
      if (url.pathname.endsWith('/session/status')) return json({ 'session-a': { type: 'idle' }, 'session-b': { type: 'idle' } })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})
    expect(container.textContent).toContain('Current A')

    slowA = true
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="Refresh OpenCode"]')!
    await act(async () => { refresh.click() })
    const transcriptPicker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(transcriptPicker, 'session-b')
      transcriptPicker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})
    expect(container.textContent).toContain('Current B')

    await act(async () => { releaseA?.() })
    expect(container.textContent).toContain('Current B')
    expect(container.textContent).not.toContain('Stale A')
  })

  it('aligns the visible transcript and disables prompting while a child selection loads', async () => {
    let releaseB: (() => void) | undefined
    handlers = []
    queue((url) => {
      if (url.pathname.endsWith('/session')) return json([
        { id: 'session-a', title: 'Transcript A', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'session-b', title: 'Transcript B', updatedAt: '2026-08-31T00:00:00Z' },
      ])
      if (url.pathname.endsWith('/session-a/message')) return json([{ info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current A' }] }])
      if (url.pathname.endsWith('/session-b/message')) return new Promise<Response>((resolve) => {
        releaseB = () => resolve(json([{ info: { id: 'b1', role: 'assistant' }, parts: [{ type: 'text', text: 'Current B' }] }]))
      })
      if (url.pathname.endsWith('/session/status')) return json({ 'session-a': { type: 'idle' }, 'session-b': { type: 'idle' } })
      return json([])
    })
    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => {})

    const picker = container.querySelector<HTMLSelectElement>('[aria-label="OpenCode transcript"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(picker, 'session-b')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(picker.value).toBe('session-b')
    expect(container.textContent).not.toContain('Current A')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)

    await act(async () => releaseB?.())
    expect(container.textContent).toContain('Current B')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false)
  })

  it('cleans up polling timers and in-flight requests on unmount', async () => {
    let aborted = false
    handlers = []
    queue((_url, init) => new Promise<Response>((resolve) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; resolve(noContent(499)) })
    }))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    await act(async () => root.unmount())

    expect(aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up a capability startup deadline on unmount', async () => {
    mint.mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      root.render(<OpenCodeWorkbenchInner authenticatedApi={{ mintCodingSessionOpenCodeCapability: mint }} sessionId="odie-session" sessionTitle="Repair" />)
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })
})
