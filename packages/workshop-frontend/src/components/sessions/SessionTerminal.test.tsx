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

  serverOpen() {
    this.dispatch('open')
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

async function renderTerminal(
  props: Partial<React.ComponentProps<typeof SessionTerminal>> = {},
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(SessionTerminal, { sessionId: 'session-1', ...props }))
  })
  await act(async () => {})
  return {
    container,
    async rerender(nextProps: Partial<React.ComponentProps<typeof SessionTerminal>>) {
      await act(async () => root.render(createElement(SessionTerminal, { sessionId: 'session-1', ...nextProps })))
    },
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
  it('sends one initial resize instead of redrawing again on ready', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverOpen())
    expect(socket!.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(socket!.send.mock.calls[0]![0] as string)).toEqual({
      type: 'resize', cols: 80, rows: 24,
    })

    await act(async () => socket!.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(socket!.send).toHaveBeenCalledTimes(1)

    await rendered.unmount()
  })

  it('submits a prepared Work Item prompt once when the coding agent is ready', async () => {
    const onInitialInputSent = vi.fn<() => void>()
    const rendered = await renderTerminal({
      initialInput: 'Start working on Jira issue AI-3540.',
      onInitialInputSent,
    })
    const socket = testState.sockets[0]!

    await act(async () => socket.serverOpen())
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))

    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(new TextDecoder().decode(socket.send.mock.calls[1]![0] as Uint8Array))
      .toBe('Start working on Jira issue AI-3540.\r')
    expect(onInitialInputSent).toHaveBeenCalledOnce()

    await rendered.rerender({ onInitialInputSent })
    expect(testState.sockets).toHaveLength(1)
    await act(async () => socket.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(socket.send).toHaveBeenCalledTimes(2)

    await act(async () => socket.serverClose())
    await advance(1000)
    const reconnect = testState.sockets[1]!
    await act(async () => reconnect.serverOpen())
    await act(async () => reconnect.serverMessage(JSON.stringify({ type: 'ready' })))
    expect(reconnect.send).toHaveBeenCalledTimes(1)
    expect(onInitialInputSent).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('reconnects with a delivered chunk cursor only after the terminal write callback commits it', async () => {
    const rendered = await renderTerminal()
    const api = testState.authenticatedApi
    const firstSocket = testState.sockets[0]
    expect(firstSocket).toBeDefined()
    expect(firstSocket!.url).not.toContain('cursor=')

    firstSocket!.serverMessage(JSON.stringify({ type: 'ready' }))
    firstSocket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
    firstSocket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
    // Interactive output reaches xterm without waiting for requestAnimationFrame.
    expect(testState.terminalWriteCallbacks).toHaveLength(1)
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

  it('leaves fatal protocol errors disconnected and allows a manual reconnect with a fresh ticket', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverMessage(JSON.stringify({ type: 'ready', cursor: '' })))
    expect(rendered.container.textContent).toContain('Terminal protocol error.')
    expect(rendered.container.textContent).toContain('Disconnected')

    await advance(60_000)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)
    expect(testState.sockets).toHaveLength(1)

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')

    await rendered.unmount()
  })

  it('auto-retries a failed manual reconnect after the previous terminal exited', async () => {
    const rendered = await renderTerminal()
    const api = testState.authenticatedApi
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => socket!.serverMessage(JSON.stringify({
      type: 'exit', cursor: 'exit-cursor', exit: { code: 1 },
    })))
    api.mintCodingSessionAttachCapability.mockRejectedValueOnce(new Error('replacement not ready'))

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(rendered.container.textContent).toContain('Disconnected')
    await advance(1_000)

    expect(api.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(3)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('cursor')).toBe('exit-cursor')

    await rendered.unmount()
  })

  it('commits an exit cursor after pending output before manually reconnecting', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverMessage(JSON.stringify({ type: 'exit', cursor: 'exit-cursor', exit: { code: 0 } }))
    })

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('cursor')).toBe('exit-cursor')

    await rendered.unmount()
  })

  it('reports an exited session only after its final output write completes', async () => {
    const onSessionUnavailable = vi.fn<() => void>()
    const rendered = await renderTerminal({ onSessionUnavailable })
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverMessage(JSON.stringify({ type: 'exit', cursor: 'exit-cursor', exit: { code: 0 } }))
      await Promise.resolve()
    })

    expect(onSessionUnavailable).not.toHaveBeenCalled()

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    await rendered.unmount()
  })

  it('stops auto-retrying quickly stable connections at the reconnect cap but keeps manual reconnect available', async () => {
    const rendered = await renderTerminal()

    for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
      const socket = testState.sockets.at(-1)
      expect(socket).toBeDefined()
      await act(async () => {
        socket!.serverMessage(JSON.stringify({ type: 'ready' }))
        socket!.serverClose()
      })
      await advance(delay)
    }

    const cappedSocket = testState.sockets.at(-1)
    expect(cappedSocket).toBeDefined()
    await act(async () => {
      cappedSocket!.serverMessage(JSON.stringify({ type: 'ready' }))
      cappedSocket!.serverClose()
    })
    await advance(60_000)

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(6)
    expect(testState.sockets).toHaveLength(6)
    expect(rendered.container.textContent).toContain('Terminal connection was lost.')
    expect(rendered.container.textContent).toContain('Disconnected')

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(7)
    expect(testState.sockets).toHaveLength(7)
    expect(new URL(testState.sockets[6]!.url).searchParams.get('ticket')).toBe('7')

    await rendered.unmount()
  })

  it('does not send an uncommitted partial chunk cursor when reconnecting', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready', cursor: 'ready-cursor' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'partial-cursor' }))
      socket!.serverClose()
    })
    await advance(1000)

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    const reconnectUrl = new URL(testState.sockets[1]!.url)
    expect(reconnectUrl.searchParams.get('ticket')).toBe('2')
    expect(reconnectUrl.searchParams.get('cursor')).toBe('ready-cursor')

    await rendered.unmount()
  })

  it('lets a manual reconnect supersede an auto reconnect already waiting for terminal operations', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      socket!.serverClose()
    })
    await advance(1_000)

    expect(testState.terminalWriteCallbacks).toHaveLength(1)
    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('ticket')).toBe('2')

    await rendered.unmount()
  })

  it('lets the latest manual reconnect supersede earlier manual clicks waiting for terminal operations', async () => {
    const rendered = await renderTerminal()
    const socket = testState.sockets[0]
    expect(socket).toBeDefined()

    await act(async () => {
      socket!.serverMessage(JSON.stringify({ type: 'ready' }))
      socket!.serverMessage(JSON.stringify({ type: 'chunk', byteLength: 3, cursor: 'chunk-cursor' }))
      socket!.serverMessage(new Uint8Array([1, 2, 3]).buffer)
      await vi.advanceTimersByTimeAsync(16)
      socket!.serverMessage(JSON.stringify({ type: 'bogus' }))
    })

    expect(testState.terminalWriteCallbacks).toHaveLength(1)
    expect(rendered.container.textContent).toContain('Terminal protocol error.')

    const button = Array.from(rendered.container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect'))
    expect(button).toBeTruthy()
    await act(async () => button!.click())
    await act(async () => button!.click())

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(1)

    await act(async () => {
      testState.terminalWriteCallbacks.shift()?.()
      await Promise.resolve()
    })

    expect(testState.authenticatedApi.mintCodingSessionAttachCapability).toHaveBeenCalledTimes(2)
    expect(testState.sockets).toHaveLength(2)
    expect(new URL(testState.sockets[1]!.url).searchParams.get('ticket')).toBe('2')

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
