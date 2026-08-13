import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthenticatedApi } from '../../AuthContext'
import { useTheme } from '../../ThemeContext'
import { WorkshopButton } from '../WorkshopControls'
import type { CodingSessionTerminalKind } from '@gadgets/workshop-shared/api'
import { OrderedTerminalOperationQueue, TerminalWriteBatcher } from './orderedTerminalOperations'

type PendingChunk = { byteLength: number }

const TERMINAL_THEMES = {
  light: { background: '#ffffff', foreground: '#18181b', cursor: '#ff4801', selectionBackground: '#dbeafe' },
  dark: { background: '#111318', foreground: '#f4f4f5', cursor: '#ff4801', selectionBackground: '#3f3f46' },
} as const

export default function SessionTerminal({
  sessionId,
  terminalKind = 'opencode',
}: {
  sessionId: string
  terminalKind?: CodingSessionTerminalKind
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<'connecting' | 'starting' | 'connected' | 'disconnected'>('connecting')
  const [interactive, setInteractive] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setState('connecting')
    setInteractive(false)
    setError(undefined)
    let cancelled = false
    let socket: WebSocket | undefined
    let pendingChunk: PendingChunk | undefined
    let resizeFrame: number | undefined
    let lastSize = ''
    let visibleOutputDetected = false
    const inputEncoder = new TextEncoder()
    const terminalOperations = new OrderedTerminalOperationQueue()
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: TERMINAL_THEMES[resolvedThemeMode],
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fit.fit()

    const sendSize = (force = false) => {
      fit.fit()
      const size = `${terminal.cols}x${terminal.rows}`
      if ((!force && size === lastSize) || socket?.readyState !== WebSocket.OPEN) return
      lastSize = size
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
    }
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined
        sendSize()
      })
    })
    resizeObserver.observe(host)

    const input = terminal.onData((data) => {
      if (socket?.readyState !== WebSocket.OPEN) return
      socket.send(inputEncoder.encode(data))
    })

    const writeOutput = (bytes: Uint8Array, done: () => void) => {
      terminal.write(bytes, () => {
        if (!cancelled && terminalKind === 'opencode' && !visibleOutputDetected && terminalHasVisibleContent(terminal)) {
          visibleOutputDetected = true
          window.requestAnimationFrame(() => {
            if (!cancelled) setInteractive(true)
          })
        }
        done()
      })
    }
    const outputBatcher = new TerminalWriteBatcher(
      terminalOperations,
      writeOutput,
      (flush) => window.requestAnimationFrame(flush),
      (handle) => window.cancelAnimationFrame(handle),
    )

    authenticatedApi.mintCodingSessionAttachCapability(sessionId, terminalKind).then((capability) => {
      if (cancelled) return
      const url = new URL(capability.url, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.addEventListener('open', () => {
        if (cancelled) return
        setState('starting')
        sendSize()
      })
      socket.addEventListener('message', (event) => {
        if (cancelled) return
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (!pendingChunk || bytes.byteLength !== pendingChunk.byteLength) {
            setError('Terminal protocol error.')
            socket?.close()
            return
          }
          outputBatcher.push(bytes)
          if (!visibleOutputDetected) {
            setState('connected')
          }
          pendingChunk = undefined
          return
        }
        if (typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as {
            type?: string
            byteLength?: number
            message?: string
            exit?: { code?: number }
          }
          if (pendingChunk && message.type !== 'chunk') {
            setError('Terminal protocol error.')
            socket?.close()
            return
          }
          if (message.type === 'ready') {
            setState('connected')
            if (terminalKind === 'shell') setInteractive(true)
            sendSize(true)
            terminal.focus()
          } else if (message.type === 'chunk' && typeof message.byteLength === 'number') {
            if (pendingChunk || !Number.isSafeInteger(message.byteLength) || message.byteLength < 0) {
              setError('Terminal protocol error.')
              socket?.close()
              return
            }
            pendingChunk = { byteLength: message.byteLength }
          } else if (message.type === 'truncated') {
            outputBatcher.flush()
            terminalOperations.enqueue((done) => {
              if (!cancelled) terminal.clear()
              done()
            })
          } else if (message.type === 'error') {
            setError(message.message ?? 'Terminal error.')
          } else if (message.type === 'exit') {
            setError(`Terminal exited${message.exit?.code === undefined ? '' : ` (${message.exit.code})`}.`)
          } else {
            setError('Terminal protocol error.')
            socket?.close()
          }
        } catch {
          setError('Terminal protocol error.')
          socket?.close()
        }
      })
      socket.addEventListener('close', () => { if (!cancelled) setState('disconnected') })
      socket.addEventListener('error', () => { if (!cancelled) setError('Terminal connection failed.') })
    }).catch((caught: unknown) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : 'Could not attach to terminal.')
        setState('disconnected')
      }
    })

    return () => {
      cancelled = true
      outputBatcher.cancel()
      terminalOperations.cancel()
      resizeObserver.disconnect()
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      input.dispose()
      socket?.close()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [authenticatedApi, attempt, sessionId, terminalKind]) // Theme updates are applied without reconnecting below.

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[resolvedThemeMode]
  }, [resolvedThemeMode])

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div className="flex h-10 items-center justify-between border-b border-kumo-line px-3 text-[12px] text-kumo-subtle">
        <span>{state === 'connected' ? 'Connected' : state === 'starting' ? 'Starting terminal…' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        {state === 'disconnected' && (
          <WorkshopButton onClick={() => { setError(undefined); setInteractive(false); setState('connecting'); setAttempt((value) => value + 1) }}>
            Reconnect
          </WorkshopButton>
        )}
      </div>
      {error && <div className="border-b border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">{error}</div>}
      <div className="relative min-h-0 flex-1">
        {!interactive && state !== 'disconnected' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-kumo-base/90 text-xs text-kumo-subtle">
            {state === 'connecting' ? 'Connecting to the sandbox…' : terminalKind === 'opencode' ? 'Starting OpenCode…' : 'Starting shell…'}
          </div>
        )}
        <div ref={hostRef} className="h-full min-h-0" aria-label={`${terminalKind === 'opencode' ? 'OpenCode' : 'Shell'} session terminal`} />
      </div>
    </section>
  )
}

function terminalHasVisibleContent(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  const firstLine = Math.max(0, buffer.viewportY)
  const lastLine = Math.min(buffer.length, firstLine + terminal.rows)
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex++) {
    if (buffer.getLine(lineIndex)?.translateToString(true).trim()) return true
  }
  return false
}
