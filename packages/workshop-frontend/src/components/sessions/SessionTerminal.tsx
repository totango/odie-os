import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuthenticatedApi } from '../../AuthContext'
import { useTheme } from '../../ThemeContext'
import { WorkshopButton } from '../WorkshopControls'

type PendingChunk = { byteLength: number }

const TERMINAL_THEMES = {
  light: { background: '#ffffff', foreground: '#18181b', cursor: '#ff4801', selectionBackground: '#dbeafe' },
  dark: { background: '#111318', foreground: '#f4f4f5', cursor: '#ff4801', selectionBackground: '#3f3f46' },
} as const

export default function SessionTerminal({ sessionId }: { sessionId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [error, setError] = useState<string>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let socket: WebSocket | undefined
    let pendingChunk: PendingChunk | undefined
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

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    })
    resizeObserver.observe(host)

    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data))
    })

    authenticatedApi.mintCodingSessionAttachCapability(sessionId).then((capability) => {
      if (cancelled) return
      const url = new URL(capability.url, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.addEventListener('open', () => {
        setState('connecting')
        socket?.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      })
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (!pendingChunk || bytes.byteLength !== pendingChunk.byteLength) {
            setError('Terminal protocol error.')
            socket?.close()
            return
          }
          terminal.write(bytes)
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
          if (message.type === 'ready') {
            setState('connected')
            terminal.focus()
          } else if (message.type === 'chunk' && typeof message.byteLength === 'number') {
            pendingChunk = { byteLength: message.byteLength }
          } else if (message.type === 'truncated') {
            terminal.clear()
          } else if (message.type === 'error') {
            setError(message.message ?? 'Terminal error.')
          } else if (message.type === 'exit') {
            setError(`Terminal exited${message.exit?.code === undefined ? '' : ` (${message.exit.code})`}.`)
          }
        } catch {
          setError('Terminal protocol error.')
          socket?.close()
        }
      })
      socket.addEventListener('close', () => setState('disconnected'))
      socket.addEventListener('error', () => setError('Terminal connection failed.'))
    }).catch((caught: unknown) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : 'Could not attach to terminal.')
        setState('disconnected')
      }
    })

    return () => {
      cancelled = true
      resizeObserver.disconnect()
      input.dispose()
      socket?.close()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [authenticatedApi, attempt, sessionId]) // Theme updates are applied without reconnecting below.

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[resolvedThemeMode]
  }, [resolvedThemeMode])

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div className="flex h-10 items-center justify-between border-b border-kumo-line px-3 text-[12px] text-kumo-subtle">
        <span>{state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        {state === 'disconnected' && (
          <WorkshopButton onClick={() => { setError(undefined); setState('connecting'); setAttempt((value) => value + 1) }}>
            Reconnect
          </WorkshopButton>
        )}
      </div>
      {error && <div className="border-b border-kumo-danger/20 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">{error}</div>}
      <div ref={hostRef} className="min-h-0 flex-1 p-2" aria-label="Coding session terminal" />
    </section>
  )
}
