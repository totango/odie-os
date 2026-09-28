// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'
import type { ChatLiveEditPreviews, EditPreviewEvent } from './ChatInterface'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { entry, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { INCOMPLETE_DESCRIPTION_COPY } from './components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from './components/RestrictedApprovalNotice'
import { linkActionLog } from './useActions'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

function withChatApi(
  server: ReturnType<typeof makeOverseer>,
  getChatMessage = vi.fn<(chatId: number, sequence: number) => Promise<AiChatMessage | null>>(),
  chats: AiChatMetadata[] = [],
) {
  let subscriber: AiChatSubscriber | undefined
  const subscribeToChat = vi.fn<(next: AiChatSubscriber) => { [Symbol.dispose](): void }>((next) => {
    subscriber = next
    return { [Symbol.dispose]: () => {} }
  })
  Object.assign(server.overseer as object, {
    negotiateEditingProtocol: async () => ({ protocol: 'git-ot-v1', state: 'ready' }),
    getEditingProtocol: async () => ({ protocol: 'git-ot-v1', state: 'ready' }),
    getChatMessage,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => chats,
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat,
  })
  return {
    getChatMessage,
    subscribeToChat,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
    emitStream(event: Parameters<AiChatSubscriber['stream']>[1]) {
      act(() => subscriber!.stream(7, event))
    },
    emitGeneration(generation: number) {
      act(() => subscriber!.streamGeneration(generation))
    },
    emitMetadata(metadata: AiChatMetadata) {
      act(() => subscriber!.metadata(metadata))
    },
  }
}

function renderChat(
  overseer: RpcStub<Overseer>,
  props: { restricted?: boolean, selectedChatId?: number,
    onLiveEditPreviewsChange?: (previews: ChatLiveEditPreviews | undefined) => void } = {},
) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      restricted={props.restricted}
      selectedChatId={props.selectedChatId ?? null}
      onLiveEditPreviewsChange={props.onLiveEditPreviewsChange}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
}

const actionMessage = {
  chatId: 1,
  sequence: 0,
  timestamp: new Date(),
  author: { type: 'agent', id: 'model', name: 'Model' },
  type: 'action',
  actionId: 1,
  actionLog: entry(1),
} as AiChatMessage

const resolvedMessage =
  { ...actionMessage, actionLog: entry(1, { state: 'approved' }) } as AiChatMessage

// Renders a first session that caches a pending action card, then settles it so a linked swap
// can resume. Pass a key to link the stub; unlinked sessions never park a watermark.
async function cachePendingCard(key?: string) {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  if (key !== undefined) linkActionLog(first.overseer, key)
  await renderChat(first.overseer)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1)] })
  firstChat.emitMessage(actionMessage)
}

describe('ChatInterface action refresh', () => {
  it('records the turn-end reset even with no preview subscriber, then replays it on reveal', async () => {
    const server = makeOverseer()
    const active: AiChatMetadata = { id: 7, title: 'Turn', started: new Date(), lastActive: new Date(),
      activeAgent: { type: 'agent', id: 'model', name: 'Model' } }
    const chat = withChatApi(server, undefined, [active])
    let source: ChatLiveEditPreviews | undefined
    await renderChat(server.overseer, { selectedChatId: 7, onLiveEditPreviewsChange: value => { source = value } })
    expect(source).toBeDefined()
    chat.emitStream({ type: 'editPreviewStart', toolCallId: 'B', file: { workpieceId: 1, filename: 'notes.txt' } })
    const before = source!.terminalSequence()
    chat.emitMetadata({ ...active, activeAgent: undefined })
    const events: EditPreviewEvent[] = []
    source!.subscribe(event => events.push(event), before)
    expect(events).toEqual([{ kind: 'reset' }])
  })
  it('replays missed clear/reset on the real chat preview source before any current stream', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server)
    let source: ChatLiveEditPreviews | undefined
    await renderChat(server.overseer, { selectedChatId: 7, onLiveEditPreviewsChange: value => { source = value } })
    expect(source).toBeDefined()
    chat.emitGeneration(1)
    chat.emitStream({ type: 'editPreviewStart', toolCallId: 'A', file: { workpieceId: 1, filename: 'notes.txt' } })
    chat.emitStream({ type: 'editPreviewDelta', toolCallId: 'A', delta: 'A' })
    chat.emitStream({ type: 'editPreviewStart', toolCallId: 'B', file: { workpieceId: 1, filename: 'notes.txt' } })
    chat.emitStream({ type: 'editPreviewDelta', toolCallId: 'B', delta: 'B' })
    const first: EditPreviewEvent[] = []
    const unsubscribe = source!.subscribe(event => first.push(event))
    expect(first).toEqual([
      { kind: 'start', toolCallId: 'B', workpieceId: 1, filename: 'notes.txt' },
      { kind: 'delta', toolCallId: 'B', delta: 'B' },
    ])
    const cursor = source!.terminalSequence()
    unsubscribe() // the code pane's Activity effects disconnect here
    chat.emitStream({ type: 'editPreviewClear', toolCallId: 'B' })
    chat.emitGeneration(2) // DO restart while no preview consumer is subscribed
    const resumed: EditPreviewEvent[] = []
    const stopResumed = source!.subscribe(event => resumed.push(event), cursor)
    expect(resumed).toEqual([{ kind: 'clear', toolCallId: 'B' }, { kind: 'reset' }])
    stopResumed()
    const staleCursor = source!.terminalSequence()
    for (let i = 0; i < 65; i++) chat.emitStream({ type: 'editPreviewClear', toolCallId: `failed-${i}` })
    const agedOut: EditPreviewEvent[] = []
    source!.subscribe(event => agedOut.push(event), staleCursor)
    expect(agedOut).toEqual([{ kind: 'reset' }])
  })
  it('waits for each fresh negotiation before subscribing and allows compatible paused replay', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server)
    let release!: (status: { protocol: string; state: string }) => void
    Object.assign(server.overseer, { negotiateEditingProtocol: vi.fn<(protocol: string) => Promise<{ protocol: string; state: string }>>(
      () => new Promise(resolve => { release = resolve })) })
    await renderChat(server.overseer)
    expect(chat.subscribeToChat).not.toHaveBeenCalled()
    await act(async () => release({ protocol: 'git-ot-v1', state: 'paused' }))
    expect(chat.subscribeToChat).toHaveBeenCalledOnce()
    const replacement = makeOverseer()
    const next = withChatApi(replacement)
    Object.assign(replacement.overseer, { negotiateEditingProtocol: undefined })
    await renderChat(replacement.overseer)
    expect(next.subscribeToChat).not.toHaveBeenCalled()
    expect(next.getChatMessage).not.toHaveBeenCalled()
  })
  it('refetches cached mutable cards when an unlinked stub swaps', async () => {
    await cachePendingCard()

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    await renderChat(second.overseer)
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })

  it('skips the cached-card refetch on a resumed linked stub swap', async () => {
    await cachePendingCard('ws-chat-resume')

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    linkActionLog(second.overseer, 'ws-chat-resume')
    await renderChat(second.overseer)
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1)] })
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()
  })
})

// A pending action whose description runs to several paragraphs: what the approver has to read
// in full when the workspace is restricted.
const longDescription = [
  'Send the following email to alice@example.com:',
  'Hi Alice, attached are the quarterly numbers you asked for.',
  'Regards, the workspace.',
].join('\n\n')

function pendingLog(over: Partial<Record<string, unknown>> = {}) {
  return entry(1, {
    description: { title: 'Send email', description: longDescription, implementsRevert: false, ...over },
  })
}

// Renders chat 1 selected, so its messages -- and the action card for `log` -- are actually on
// screen.
async function renderPendingCard(log: ActionLogEntry, props: { restricted?: boolean } = {}) {
  const server = makeOverseer()
  const chat = withChatApi(server, undefined, [
    { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
  ])
  await renderChat(server.overseer, { ...props, selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [log] })
  chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const approve = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!approve) throw new Error('No Approve button rendered')
  const ids = approve.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('restricted approval', () => {
  it('shows the notice and the full request on a pending card while restricted', async () => {
    await renderPendingCard(pendingLog(), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(clampedDescription()).toBeNull()
    // The controls precede the review text in DOM order, so the buttons name it explicitly.
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names only the restricted notice and request for a complete description', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }), { restricted: true })

    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows the notice and the full request on a blocking card while restricted', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).toBeNull()
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
  })

  it('names the fields as part of the request while restricted', async () => {
    const fields = [{ label: 'To', kind: 'list', items: ['a@example.com'] }]
    await renderPendingCard(pendingLog({ descriptionIsComplete: true, fields }), { restricted: true })

    expect(approveDescribedBy()).toContain('a@example.com')
  })

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} card's long fields without a scroll cap while restricted`, async () => {
      const fields = [{ label: 'Body', kind: 'text', value: 'Full body text' }]
      await renderPendingCard(pendingLog({ ...over, fields }), { restricted: true })

      const body = [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')
      expect(body?.className).not.toContain('max-h-56')
      expect(document.querySelector('[class*="max-h-[360px]"]')).toBeNull()
    })
  }

  it('keeps the scrolling description and no notice when not restricted', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
  })
})

describe('incomplete description notice', () => {
  it('flags a pending action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('flags a blocking action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }))

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no notice when the description is complete', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }))

    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})

describe('action fields', () => {
  const body = 'LGTM ```but``` <script>alert(1)</script>'
  const fields = [{ label: 'Body', kind: 'text', value: body, syntax: 'markdown' }]

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} action's fields as literal text after the description`, async () => {
      await renderPendingCard(pendingLog({ ...over, fields }))

      const pre = [...document.body.querySelectorAll('pre')].find(el => el.textContent === body)
      expect(pre).toBeDefined()
      expect(document.body.querySelector('script')).toBeNull()
      expect(document.body.textContent).toContain('Send the following email to alice@example.com:')
    })
  }
})
