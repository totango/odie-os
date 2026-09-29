// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  ObserverAccountChoice,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div data-testid="account-select">{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Select,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ObserverConfigModal from './ObserverConfigModal'

const VENDOR = {
  displayName: 'Google',
  color: '#4285f4',
} as VendorDescription

const DOC_RESOURCE: SupportedResource = {
  urlPattern: 'https://docs.google.com/document/d/:docId/*',
  title: 'Google Doc',
  description: 'Read and edit documents you choose.',
  grantable: true,
}

const GMAIL_RESOURCE_PATTERN = 'https://mail.google.com/*'

const NEED: ObserverBindingNeed = {
  gatekeeperId: 12,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

function account(id: number, uniqueName: string, grantedResourceUrlPatterns?: string[]) {
  return {
    id,
    description: {
      displayName: uniqueName,
      uniqueName,
      grantedResourceUrlPatterns,
    } as AccountDescription,
  }
}

type ApiOverrides = {
  subscribeConnectedAccounts?: Mock<(
    subscriber: ConnectedAccountsSubscriber,
  ) => Promise<{ [Symbol.dispose](): void }>>
  connectAccount?: Mock<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>
  ensureAccountResources?: Mock<(
    accountId: number,
    resourceUrlPatterns: string[],
  ) => Promise<{ url?: string }>>
  reconnectAccount?: Mock<(accountId: number) => Promise<{ url: string }>>
}

function fakeApi(
  accountEntries: ReturnType<typeof account>[],
  overrides: ApiOverrides = {},
): RpcStub<AuthenticatedApi> {
  return {
    subscribeConnectedAccounts: overrides.subscribeConnectedAccounts ?? ((subscriber: ConnectedAccountsSubscriber) => {
      for (const entry of accountEntries) {
        subscriber.add(entry.id, entry.description, VENDOR, [DOC_RESOURCE], true, 'google')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
        [Symbol.dispose]() {},
      })
    }),
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: VENDOR,
      supportedResources: [DOC_RESOURCE],
    }],
    listAddableGatekeepers: async () => [],
    connectAccount: overrides.connectAccount ??
      vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>(),
    ensureAccountResources: overrides.ensureAccountResources ??
      vi.fn<(accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>>(),
    reconnectAccount: overrides.reconnectAccount ??
      vi.fn<(accountId: number) => Promise<{ url: string }>>(),
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('ObserverConfigModal account selection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    root = undefined
    container = undefined
  })

  async function render(
    accountEntries: ReturnType<typeof account>[],
    options: {
      api?: RpcStub<AuthenticatedApi>
      onConfirm?: (choices: ObserverAccountChoice[]) => void
    } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal
          needs={[NEED]}
          authenticatedApi={options.api ?? fakeApi(accountEntries)}
          onConfirm={options.onConfirm ?? (() => {})}
          onCancel={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('shows a single matching account directly instead of putting it in a dropdown', async () => {
    const rendered = await render([account(1, 'dan@cloudflare.com')])

    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.querySelector('[data-testid="account-select"]')).toBeNull()
  })

  it('disposes a pending account subscription on unmount', async () => {
    const dispose = vi.fn<() => void>()
    const pendingSubscription = Object.assign(new Promise<{ [Symbol.dispose](): void }>(() => {}), {
      [Symbol.dispose]: dispose,
    })
    const subscribeConnectedAccounts = vi.fn<
      (subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>
    >().mockReturnValue(pendingSubscription)
    await render([], { api: fakeApi([], { subscribeConnectedAccounts }) })

    act(() => root!.unmount())
    root = undefined

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the account dropdown when multiple accounts match', async () => {
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
  })

  it('requests the resource scope when connecting a new account', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const rendered = await render([], {
      api: fakeApi([], { connectAccount }),
    })

    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    expect(connectAccount).toHaveBeenCalledWith('google', [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(rendered.textContent).toContain('Your browser blocked the popup')
    expect(rendered.querySelector('a[href="https://accounts.google.test/oauth"]')).not.toBeNull()
    expect(connect?.disabled).toBe(false)
    await act(async () => connect!.click())
    expect(connectAccount).toHaveBeenCalledTimes(2)
  })

  it('offers a retry 30 seconds after an opened popup with no callback, then resets on retry', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    const popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const rendered = await render([], { api: fakeApi([], { connectAccount }) })
    vi.useFakeTimers()
    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')!
    await act(async () => connect.click())
    expect(connect.disabled).toBe(true)
    expect(connect.textContent).toBe('Waiting for connection…')
    await act(async () => vi.advanceTimersByTime(29_999))
    expect(connect.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(1))
    expect(connect.disabled).toBe(false)
    expect(connect.textContent).toBe('Try connecting again')
    expect(connectAccount).toHaveBeenCalledTimes(1)

    await act(async () => connect.click())
    expect(connectAccount).toHaveBeenCalledTimes(2)
    expect(connect.disabled).toBe(true)
    expect(connect.textContent).toBe('Waiting for connection…')
    expect(vi.getTimerCount()).toBe(1)
    act(() => root!.unmount())
    root = undefined
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending popup retry when a connected account arrives', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    const popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    let subscriber: ConnectedAccountsSubscriber | undefined
    const api = fakeApi([], { connectAccount, subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>(s => {
      subscriber = s
      s.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    }) })
    const rendered = await render([], { api })
    vi.useFakeTimers()
    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')!
    await act(async () => connect.click())
    expect(vi.getTimerCount()).toBe(1)
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    act(() => subscriber!.add(granted.id, granted.description, VENDOR, [DOC_RESOURCE], true, 'google'))
    expect(vi.getTimerCount()).toBe(0)
    expect(rendered.querySelector('a[href="https://accounts.google.test/oauth"]')).toBeNull()
    expect(rendered.textContent).toContain('Ready')
  })

  it('navigates a pre-opened popup without exposing an opener', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    const popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const rendered = await render([], { api: fakeApi([], { connectAccount }) })

    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')
    await act(async () => connect!.click())

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(popup.opener).toBeNull()
    expect(popup.location.href).toBe('https://accounts.google.test/oauth')
    const fallback = rendered.querySelector('a[href="https://accounts.google.test/oauth"]')
    expect(fallback?.getAttribute('target')).toBe('_blank')
    expect(fallback?.getAttribute('rel')).toBe('noreferrer')
  })

  it('expands an existing account grant before allowing verification', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >()
      .mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()
    expect(rendered.textContent).not.toContain('Ready')

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(rendered.textContent).toContain('Your browser blocked the popup')
    expect(rendered.querySelector('a[href="https://accounts.google.test/oauth"]')).not.toBeNull()
    expect(rendered.textContent).not.toContain('Ready')
    expect(verify?.disabled).toBe(true)
  })

  it('checks the resource grant when legacy account metadata omits it', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(rendered.textContent).toContain('Your browser blocked the popup')
    expect(rendered.querySelector('a[href="https://accounts.google.test/oauth"]')).not.toBeNull()
  })

  it('offers a manual link and another attempt when reconnect popup is blocked', async () => {
    const reconnectAccount = vi.fn<(accountId: number) => Promise<{ url: string }>>()
      .mockResolvedValue({ url: 'https://accounts.google.test/reconnect' })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const expired = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([expired], {
      api: fakeApi([expired], {
        reconnectAccount,
        subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>(subscriber => {
          subscriber.add(expired.id, expired.description, VENDOR, [DOC_RESOURCE], false, 'google')
          subscriber.ready()
          return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
        }),
      }),
    })
    const reconnect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent?.includes('This account has expired'))
    expect(reconnect).toBeDefined()
    await act(async () => reconnect!.click())
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(rendered.querySelector('a[href="https://accounts.google.test/reconnect"]')).not.toBeNull()
    expect(reconnect?.disabled).toBe(false)
  })

  it('allows retrying a pending grant popup after 30 seconds', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >().mockResolvedValue({ url: 'https://accounts.google.test/oauth' })
    const popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })
    vi.useFakeTimers()
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')!
    await act(async () => grant.click())
    expect(grant.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(grant.disabled).toBe(false)
    expect(grant.textContent).toContain('Try connecting again')
    await act(async () => grant.click())
    expect(ensureAccountResources).toHaveBeenCalledTimes(2)
  })

  it('allows retrying a pending reconnect popup after 30 seconds', async () => {
    const reconnectAccount = vi.fn<(accountId: number) => Promise<{ url: string }>>()
      .mockResolvedValue({ url: 'https://accounts.google.test/reconnect' })
    const popup = { opener: window, location: { href: 'about:blank' }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const expired = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([expired], {
      api: fakeApi([expired], {
        reconnectAccount,
        subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>>(subscriber => {
          subscriber.add(expired.id, expired.description, VENDOR, [DOC_RESOURCE], false, 'google')
          subscriber.ready()
          return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
        }),
      }),
    })
    vi.useFakeTimers()
    const reconnect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent?.includes('This account has expired'))!
    await act(async () => reconnect.click())
    expect(reconnect.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(reconnect.disabled).toBe(false)
    expect(reconnect.textContent).toContain('Try connecting again')
    await act(async () => reconnect.click())
    expect(reconnectAccount).toHaveBeenCalledTimes(2)
  })

  it('allows verification when the gatekeeper confirms an unknown grant needs no OAuth', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<{ url?: string }>
    >().mockResolvedValue({})
    const legacy = account(1, 'dan@cloudflare.com')
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    await act(async () => grant!.click())

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(rendered.textContent).toContain('Ready')
    expect(verify?.disabled).toBe(false)
  })

  it('allows verification when the account already has the required grant', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], { onConfirm })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(verify?.disabled).toBe(false)
    expect(rendered.textContent).toContain('Ready')

    await act(async () => verify!.click())
    expect(onConfirm).toHaveBeenCalledWith([{ gatekeeperId: 12, accountId: 1 }])
  })
})
