// @vitest-environment jsdom

import React, { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  authenticatedApi: undefined as unknown as { mintCodingSessionAttachCapability: ReturnType<typeof vi.fn> },
  terminalWriteCallbacks: [] as Array<() => void>,
  sockets: [] as MockWebSocket[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80
    rows = 24
    options: { theme?: unknown }
    buffer = {
      active: {
        viewportY: 0,
        length: 0,
        getLine: () => undefined,
      },
    }

    constructor(options: { theme?: unknown }) {
      this.options = options
    }

    loadAddon() {}
    open() {}
    focus() {}
    clear() {}
    dispose() {}
    onData() { return { dispose() {} } }
    write(_bytes: Uint8Array, callback: () => void) {
      testState.terminalWriteCallbacks.push(callback)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../../ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'dark' }),
}))

vi.mock('../WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

import SessionTerminal from './SessionTerminal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = (event: { data?: unknown }) => void

class MockWebSocket {
  static readonly OPEN = 1
  readonly url: string
  readyState = MockWebSocket.OPEN
  binaryType = ''
  readonly close = vi.fn<() => void>(() => {
    this.readyState = 3
    this.dispatch('close')
  })
  readonly send = vi.fn<(data: string | ArrayBufferLike | Blob | ArrayBufferView) => void>()
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = url.toString()
    testState.sockets.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  serverMessage(data: unknown) {
    this.dispatch('message', { data })
  }

  serverClose() {
    this.readyState = 3
    this.dispatch('close')
  }

  private dispatch(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function createApi() {
  let ticket = 0
  return {
    mintCodingSessionAttachCapability: vi.fn<() => Promise<{ url: string }>>(async () => {
      ticket++
      return { url: `https://terminal.example.test/attach?ticket=${ticket}` }
    }),
  }
}

async function renderTerminal() {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(SessionTerminal, { sessionId: 'session-1' }))
  })
  await act(async () => {})
  return {
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  testState.authenticatedApi = createApi()
  testState.terminalWriteCallbacks = []
  testState.sockets = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.stubGlobal('requestAnimationFrame', vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
    return window.setTimeout(() => callback(performance.now()), 16)
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn<(handle: number) => void>((handle) => window.clearTimeout(handle)))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.textContent = ''
})

describe('SessionTerminal', () => {
  it('reconnects with a delivered chunk cursor only after the terminal write callback commits it', async () => {
    const rendered = await renderTerminal()
    const api = testState.authenticatedApi
    const firstSocket = testState.sockets[0]
    expect(firstSocket).toBeDefined()
    expect(firstSocket!.url).not.toContain('cursor=')

    firstSocket!.serverMessage(JSON.stringify({ type: 'ready' }))
    firstSocket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
    firstSocket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
    firstSocket!.serverClose()

    await advance(1000)
    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)
    expect(testState.terminalWriteCallbacks).toHaveLength(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')
    expect(reconnectUrl.searchParams.get('cursor')).toBe('chunk-cursor')

    await rendered.unmount()
  })

  it.each([
    ['malformed cursor', JSON.stringify({ type: 'ready', cursor: '' })],
    ['protocol mismatch', new Uint8Array([1]).buffer],
  ])('closes on %s without scheduling automatic reconnect or ticket minting', async (_name, message) => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    socket!.serverMessage(message)
    expect(socket!.close).toHaveBeenCalledOnce()

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)

    await rendered.unmount()
  })

  it('unmount cancels reconnect timers and closes the socket', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    socket!.serverClose()
    await rendered.unmount()
    expect(socket!.close).toHaveBeenCalledOnce()

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)
  })
})
