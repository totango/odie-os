// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, ConnectedAccountsSubscriber, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: {
    listModels: vi.fn<() => Promise<AiChatAuthorInfo[]>>(async () => [
      { type: 'agent' as const, id: 'team-pi-codex/gpt-5.6-sol', name: 'Team PI Codex gpt-5.6-sol' },
    ]),
    listGatekeeperVendors: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => [
      {
        id: 'team-pi',
        description: { displayName: 'TEAM_PI', url: 'https://example.test' },
        supportedResources: [],
      },
    ]),
    listAddableGatekeepers: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => []),
    subscribeConnectedAccounts: vi.fn<(subscriber: ConnectedAccountsSubscriber, filter: { includeForcedAutoProvisionedAccounts: boolean }) => Promise<{ [Symbol.dispose](): void }>>(),
  },
  subscriber: undefined as ConnectedAccountsSubscriber | undefined,
  subscriptionDisposed: vi.fn<() => void>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import {
  GettingStartedPage,
  GettingStartedPageContent,
  isJarvisAccount,
  isTeamPiCodexModel,
  isTeamPiVendor,
} from './getting-started'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Getting started', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    testState.subscriber = undefined
    testState.subscriptionDisposed.mockClear()
    vi.clearAllMocks()
  })

  it('recognizes deployment-managed Team PI Codex models', () => {
    expect(isTeamPiCodexModel({ type: 'agent', id: 'team-pi-codex/gpt-5.6-sol', name: 'Managed' })).toBe(true)
    expect(isTeamPiCodexModel({ type: 'agent', id: 'openai/gpt-5', name: 'Team PI Codex fallback' })).toBe(false)
    expect(isTeamPiCodexModel({ type: 'agent', id: 'openai/gpt-5', name: 'GPT-5' })).toBe(false)
  })

  it('uses precise readiness predicates for JARVIS and TEAM_PI', () => {
    expect(isJarvisAccount({
      id: 1,
      accountDescription: { displayName: 'Management UI only', avatar: { url: '' }, providesUi: { title: 'JARVIS UI' } },
      vendorDescription: { displayName: 'Other', url: 'https://example.test' },
      vendorId: 'other',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isJarvisAccount({
      id: 4,
      accountDescription: { displayName: 'JARVIS unavailable', avatar: { url: '' } },
      vendorDescription: { displayName: 'JARVIS', url: 'https://example.test' },
      vendorId: 'jarvis',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isJarvisAccount({
      id: 2,
      accountDescription: { displayName: 'Repo knowledge', avatar: { url: '' }, singleton: { tsType: 'JarvisSession' } },
      vendorDescription: { displayName: 'Other', url: 'https://example.test' },
      vendorId: 'other',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(true)
    expect(isJarvisAccount({
      id: 3,
      accountDescription: { displayName: 'Context Library', avatar: { url: '' }, singleton: { tsType: 'ContextSession' } },
      vendorDescription: { displayName: 'Context', url: 'https://example.test' },
      vendorId: 'context',
      supportedResources: [],
      credentialsValid: true,
    })).toBe(false)
    expect(isTeamPiVendor({ id: 'github', description: { displayName: 'GitHub', url: 'https://example.test' } })).toBe(false)
    expect(isTeamPiVendor({ id: 'team-pi', description: { displayName: 'TEAM_PI', url: 'https://example.test' } })).toBe(true)
  })

  it('clearly distinguishes model, JARVIS, production investigation, and TEAM_PI paths', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent
        readiness={{
          models: [{ type: 'agent', id: 'team-pi-codex/gpt-5.6-sol', name: 'Team PI Codex gpt-5.6-sol' }],
          accounts: [{
            id: 1,
            accountDescription: {
              displayName: 'JARVIS',
              avatar: { url: '' },
              singleton: { tsType: 'JarvisSession' },
            },
            vendorDescription: { displayName: 'JARVIS', url: 'https://example.test', autoProvisionsAccount: true },
            vendorId: 'jarvis',
            supportedResources: [],
            credentialsValid: true,
          }],
          vendors: [
            {
              id: 'team-pi',
              description: { displayName: 'TEAM_PI', url: 'https://example.test' },
              supportedResources: [],
            },
            {
              id: 'github',
              description: { displayName: 'GitHub', url: 'https://example.test' },
              supportedResources: [],
            },
          ],
          addableGatekeepers: [],
          modelsLoaded: true,
          accountsLoaded: true,
          vendorsLoaded: true,
          loadError: false,
        }}
      />,
    ))

    expect(container.textContent).toContain('Team PI Codex is a deployment-managed model route')
    expect(container.textContent).toContain('Prompt links below only prepare text')
    expect(container.textContent).toContain('Prepare Codex prompt')
    expect(container.textContent).toContain('JARVIS is an ambient binding')
    expect(container.textContent).toContain('Never connect Odie directly to raw production MCP')
    expect(container.textContent).toContain('Install or start-connection operations must remain approval-gated')
    expect([...container.querySelectorAll('a')].some((link) => link.getAttribute('href') === '/gatekeepers')).toBe(true)
  })

  it('does not treat an unrelated connectable vendor as TEAM_PI readiness', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GettingStartedPageContent
        readiness={{
          models: [],
          accounts: [],
          vendors: [{
            id: 'github',
            description: { displayName: 'GitHub', url: 'https://example.test' },
            supportedResources: [],
          }],
          addableGatekeepers: [],
          modelsLoaded: true,
          accountsLoaded: true,
          vendorsLoaded: true,
          loadError: false,
        }}
      />,
    ))

    expect(container.textContent).toContain('TEAM_PI is not listed as a connectable vendor')
    expect(container.textContent).not.toContain('connect it before asking for TEAM_PI reads')
  })

  it('subscribes to forced accounts and disposes the live RPC subscription on unmount', async () => {
    testState.authenticatedApi.subscribeConnectedAccounts.mockImplementation(async (subscriber, filter) => {
      testState.subscriber = subscriber as ConnectedAccountsSubscriber
      expect(filter).toEqual({ includeForcedAutoProvisionedAccounts: true })
      subscriber.ready()
      return { [Symbol.dispose]: testState.subscriptionDisposed }
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<GettingStartedPage />))

    expect(testState.authenticatedApi.listModels).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.listGatekeeperVendors).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.listAddableGatekeepers).toHaveBeenCalledOnce()
    expect(testState.authenticatedApi.subscribeConnectedAccounts).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Team PI Codex model')

    act(() => root!.unmount())
    expect(testState.subscriptionDisposed).toHaveBeenCalledOnce()
  })
})
