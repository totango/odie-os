// @vitest-environment jsdom

import React, { Activity, act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({ type: 'button' }),
    },
  )
  return {
    Dialog,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

const configurator = vi.hoisted(() => ({ current: null as null | {
  frame: ResourceConfiguratorFrame | null; resourceIdentity?: string; frameIdentity?: string
  authorityAvailable?: boolean; isAuthorityCurrent?: () => boolean
} }))

vi.mock('./ResourceConfiguratorHost', () => ({
  default: (props: {
    frame: ResourceConfiguratorFrame | null
    resourceIdentity?: string
    frameIdentity?: string
    authorityAvailable?: boolean
    isAuthorityCurrent?: () => boolean
    onCollectResourceUrlChange: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange: (ready: boolean | null) => void
  }) => {
    const { frame, authorityAvailable, onCollectResourceUrlChange, onSelectionReadyChange } = props
    configurator.current = props
    useEffect(() => {
      if (frame && authorityAvailable) {
        onCollectResourceUrlChange(() => Promise.resolve('https://acme.atlassian.net/browse/ENG-1'))
        onSelectionReadyChange(true)
      } else {
        onCollectResourceUrlChange(null)
        onSelectionReadyChange(null)
      }
    }, [frame, authorityAvailable, onCollectResourceUrlChange, onSelectionReadyChange])
    return <div data-testid="resource-configurator">Configurator</div>
  },
}))

const auth = vi.hoisted(() => ({ api: undefined as unknown as RpcStub<AuthenticatedApi> }))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: auth.api }),
}))

vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(...args: unknown[]) => void>() }))
vi.mock('./rpcErrors', () => ({ logRpcFailure: vi.fn<(...args: unknown[]) => void>() }))

import GatekeeperModal from './GatekeeperModal'

const JIRA_VENDOR: VendorDescription = { displayName: 'Jira', url: 'https://www.atlassian.com/software/jira', color: '#0052cc' }
const GITHUB_VENDOR: VendorDescription = { displayName: 'GitHub', url: 'https://github.com', color: '#24292f' }
const JIRA_SITE: SupportedResource = {
  title: 'Jira site',
  description: 'Pick an authorized Jira site.',
  urlPattern: 'https://:site.atlassian.net/*',
  grantable: true,
}
const JIRA_ISSUE: SupportedResource = {
  title: 'Jira issue',
  description: 'Pick an authorized Jira issue.',
  urlPattern: 'https://:site.atlassian.net/browse/:issueKey',
  grantable: true,
}
const GITHUB_REPO: SupportedResource = {
  title: 'GitHub repo',
  description: 'Pick a repository.',
  urlPattern: 'https://github.com/:owner/:repo',
  grantable: true,
}

class ConfiguratorUi extends RpcTarget { identify() { return 'resource' } }

function makeApi(ownerId = 'owner', isAdmin = false) {
  const startResourceConfigurator = vi.fn<(
    accountId: number,
    resourceUrlPattern: string,
  ) => Promise<ResourceConfiguratorFrame>>(async () => ({
    iframeHtml: '<div></div>',
    ui: new RpcStub(new ConfiguratorUi()),
  }))
  const newGatekeeper = vi.fn<(
    accountId: number,
    resourceUrl: string,
  ) => Promise<RpcStub<GatekeeperClient<any>>>>(async () => ({
    getId: async () => 17,
    [Symbol.dispose]() {},
  } as unknown as RpcStub<GatekeeperClient<any>>))
  const connectAccount = vi.fn<(
    vendorId: string,
    resourceUrlPatterns?: string[],
  ) => Promise<{ url: string }>>()
  const methods = {
    whoami: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: ownerId })),
    amIAdmin: async () => isAdmin,
    listModels: async () => [],
    listGatekeeperVendors: async () => [
      { id: 'jira', description: JIRA_VENDOR, supportedResources: [JIRA_SITE, JIRA_ISSUE] },
      { id: 'github', description: GITHUB_VENDOR, supportedResources: [GITHUB_REPO] },
    ],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      const description: AccountDescription = {
        displayName: 'Jacob Jira',
        uniqueName: 'jacob@jira',
        avatar: { url: 'https://acme.atlassian.net/avatar.png' },
        grantedResourceUrlPatterns: [JIRA_SITE.urlPattern, JIRA_ISSUE.urlPattern],
      }
      subscriber.add(3, description, JIRA_VENDOR, [JIRA_SITE, JIRA_ISSUE], true, 'jira')
      subscriber.add(7, { ...description, uniqueName: 'other@jira' }, JIRA_VENDOR, [JIRA_SITE, JIRA_ISSUE], true, 'jira')
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    },
    connectAccount,
    ensureAccountResources: vi.fn<(
      accountId: number,
      resourceUrlPatterns: string[],
    ) => Promise<{ url?: string }>>(),
    reconnectAccount: vi.fn<(accountId: number) => Promise<{ url: string }>>(),
    startResourceConfigurator,
  }
  const api = methods as unknown as RpcStub<AuthenticatedApi> & {
    startResourceConfigurator: typeof startResourceConfigurator
    connectAccount: typeof connectAccount
  }
  const overseer = {
    newGatekeeper,
  } as unknown as RpcStub<Overseer> & { newGatekeeper: typeof newGatekeeper }
  return { api, overseer, startResourceConfigurator, newGatekeeper, methods }
}

describe('GatekeeperModal requestConnection accept flow', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverMock
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
    configurator.current = null
  })

  async function renderVendorOnly() {
    const harness = makeApi()
    auth.api = harness.api
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const view = <GatekeeperModal open onClose={() => {}} getOverseer={() => harness.overseer}
      onCreated={vi.fn<(gk: RpcStub<GatekeeperClient<any>>) => Promise<void>>(async () => {})} initialVendorId="jira" />
    await act(async () => {
      root!.render(<Activity mode="visible">{view}</Activity>)
    })
    await act(async () => { await Promise.resolve() })
    return { ...harness, rerender: (hidden = false) => act(async () => root!.render(
      <Activity mode={hidden ? 'hidden' : 'visible'}>{React.cloneElement(view)}</Activity>,
    )) }
  }

  it('shows only the requested vendor and waits for an explicit resource choice', async () => {
    await renderVendorOnly()

    expect(container!.textContent).toContain('Choose which Jira resource to grant.')
    expect(container!.textContent).toContain('Jira site')
    expect(container!.textContent).toContain('Jira issue')
    expect(container!.textContent).not.toContain('GitHub repo')
    expect(container!.textContent).not.toContain('AI Model')
  })

  it('reuses an existing authorized account after the user chooses a vendor resource', async () => {
    const harness = await renderVendorOnly()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const issueButton = Array.from(container!.querySelectorAll('button')).toReversed()
      .find(button => button.textContent?.includes('Jira issue'))
    expect(issueButton).toBeDefined()
    expect(issueButton!.textContent).toContain('Pick an authorized Jira issue.')

    await act(async () => { issueButton!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container!.textContent).toContain('Account')
    expect(harness.api.connectAccount).not.toHaveBeenCalled()
    expect(harness.startResourceConfigurator).toHaveBeenCalledWith(3, JIRA_ISSUE.urlPattern)
    expect(container!.textContent).toContain('jacob@jira')
  })

  async function select(label: string) {
    const button = Array.from(container!.querySelectorAll('button')).toReversed().find(item => item.textContent?.includes(label))
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }

  it('preserves a non-default selection through unresolved identity and incremental account replay, then authorizes only the fresh frame', async () => {
    const first = await renderVendorOnly()
    await select('Jira issue'); await select('other@jira')
    const old = configurator.current!
    const documentNode = container!.querySelector('[data-testid="resource-configurator"]')
    expect(old.authorityAvailable).toBe(true)
    expect(old.resourceIdentity).toContain(',7,')
    const second = makeApi()
    let verify!: (value: { id: string }) => void
    second.methods.whoami.mockImplementation(() => new Promise(resolve => { verify = resolve }))
    let subscriber!: ConnectedAccountsSubscriber
    second.methods.subscribeConnectedAccounts = value => {
      subscriber = value
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    }
    let acquire!: (value: ResourceConfiguratorFrame) => void
    second.startResourceConfigurator.mockImplementation(() => new Promise(resolve => { acquire = resolve }))
    auth.api = second.api; await first.rerender()
    expect(configurator.current!.authorityAvailable).toBe(false)
    expect(old.isAuthorityCurrent!()).toBe(false)
    expect(second.startResourceConfigurator).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-testid="resource-configurator"]')).toBe(documentNode)
    await act(async () => verify({ id: 'owner' }))
    const description: AccountDescription = { displayName: 'Account', avatar: { url: 'https://example.com/avatar' }, grantedResourceUrlPatterns: [JIRA_SITE.urlPattern, JIRA_ISSUE.urlPattern] }
    await act(async () => subscriber.add(3, description, JIRA_VENDOR, [JIRA_SITE, JIRA_ISSUE], true, 'jira'))
    expect(second.startResourceConfigurator).not.toHaveBeenCalled()
    await act(async () => { subscriber.add(7, { ...description, uniqueName: 'other@jira' }, JIRA_VENDOR, [JIRA_SITE, JIRA_ISSUE], true, 'jira'); subscriber.ready() })
    expect(second.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(7, JIRA_ISSUE.urlPattern)
    expect(configurator.current!.authorityAvailable).toBe(false)
    const freshFrame = { iframeHtml: '<div>fresh</div>', ui: new RpcStub(new ConfiguratorUi()) }
    await act(async () => acquire(freshFrame))
    expect(configurator.current!.frame).toBe(freshFrame)
    expect(configurator.current!.frameIdentity).toBe(old.resourceIdentity)
    expect(configurator.current!.authorityAvailable).toBe(true)
    expect(configurator.current!.isAuthorityCurrent!()).toBe(true)
    expect(container!.querySelector('[data-testid="resource-configurator"]')).toBe(documentNode)
  })

  it.each([['different-owner', false], ['owner', true]] as const)('resets selection after verified owner/admin context changes (%s, %s)', async (owner, admin) => {
    const first = await renderVendorOnly()
    await select('Jira issue'); await select('other@jira')
    const old = configurator.current!
    auth.api = makeApi(owner, admin).api
    await first.rerender()
    expect(old.isAuthorityCurrent!()).toBe(false)
    expect(container!.textContent).toContain('Choose which Jira resource to grant.')
    expect(container!.querySelector('[data-testid="resource-configurator"]')).toBeNull()
  })

  it('retains selection through Activity while releasing and freshly acquiring backend authority', async () => {
    const harness = await renderVendorOnly()
    await select('Jira issue'); await select('other@jira')
    const old = configurator.current!
    const node = container!.querySelector('[data-testid="resource-configurator"]')
    harness.startResourceConfigurator.mockClear()
    await harness.rerender(true)
    expect(old.isAuthorityCurrent!()).toBe(false)
    await harness.rerender(false)
    expect(harness.startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(7, JIRA_ISSUE.urlPattern)
    expect(configurator.current!.frameIdentity).toBe(old.frameIdentity)
    expect(configurator.current!.authorityAvailable).toBe(true)
    expect(container!.querySelector('[data-testid="resource-configurator"]')).toBe(node)
  })

  it('disposes a late acquisition and never labels it with a newly selected account', async () => {
    const harness = await renderVendorOnly()
    let acquire!: (value: ResourceConfiguratorFrame) => void
    harness.startResourceConfigurator.mockImplementationOnce(() => new Promise(resolve => { acquire = resolve }))
    await select('Jira issue')
    await select('other@jira')
    const current = configurator.current!
    const dispose = vi.fn<() => void>()
    class LateUi extends ConfiguratorUi { [Symbol.dispose]() { dispose() } }
    const lateUi = new RpcStub(new LateUi())
    await act(async () => acquire({ iframeHtml: '<div>late</div>', ui: lateUi }))
    expect(dispose).toHaveBeenCalledOnce()
    expect(configurator.current!.frame).toBe(current.frame)
    expect(configurator.current!.frameIdentity).toContain(',7,')
    expect(configurator.current!.authorityAvailable).toBe(true)
  })
})
