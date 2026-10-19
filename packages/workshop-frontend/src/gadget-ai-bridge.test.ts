import { afterEach, describe, expect, it, vi } from 'vitest'
import { GadgetAiBridge } from './gadget-ai-bridge'

const targets = vi.hoisted(() => [] as { run(input: unknown): Promise<string> }[])
vi.mock('capnweb', () => ({
  RpcTarget: class {},
  newMessagePortRpcSession: (port: MessagePort, target: { run(input: unknown): Promise<string> }) => {
    targets.push(target)
    return { [Symbol.dispose]: () => port.close() }
  },
}))

const bridges: GadgetAiBridge[] = []
function setup() {
  const notify = vi.fn<(confirmation: unknown) => void>()
  const execute = vi.fn<(request: unknown) => Promise<string>>().mockResolvedValue('Answer')
  const bridge = new GadgetAiBridge(notify)
  bridges.push(bridge)
  bridge.resume(execute)
  bridge.handshake({ close: vi.fn<() => void>() } as unknown as MessagePort)
  return { bridge, execute, notify, api: targets.at(-1)! }
}

afterEach(() => {
  bridges.splice(0).forEach(bridge => bridge.dispose())
  targets.length = 0
  vi.useRealTimers()
})

describe('interactive Gadget AI authority', () => {
  it('requires trusted-host confirmation and no organization ID', async () => {
    const { bridge, api, execute, notify } = setup()
    const input = { prompt: 'Explain gravity' }
    const result = api.run(input)
    expect(execute).not.toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith({ request: { prompt: input.prompt }, running: false })
    input.prompt = 'Changed after confirmation'
    bridge.approve()
    await expect(result).resolves.toBe('Answer')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ prompt: 'Explain gravity' })
  })

  it('rejects untrusted model routing and oversized or empty inputs before confirmation', () => {
    const { api, execute } = setup()
    for (const input of [null, {}, { prompt: ' ' }, { prompt: 'x'.repeat(65_537) },
      { prompt: 'Q', systemPrompt: 'x'.repeat(16_385) }, { prompt: 'Q', modelId: 'custom' }]) {
      expect(() => api.run(input)).toThrow(/required|prompt|model/)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not allow automatic concurrent requests or approval through the iframe API', async () => {
    const { bridge, api, execute } = setup()
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(api))).not.toContain('approve')
    const result = api.run({ prompt: 'Q' })
    expect(() => api.run({ prompt: 'Another' })).toThrow('already pending')
    bridge.cancel()
    await expect(result).rejects.toThrow('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes pending requests on hide and never replays them after resume', async () => {
    const { bridge, api, execute } = setup()
    const result = api.run({ prompt: 'Q' })
    bridge.suspend()
    await expect(result).rejects.toThrow('cancelled')
    expect(() => api.run({ prompt: 'Hidden' })).toThrow('active view')
    bridge.resume(execute)
    bridge.approve()
    expect(execute).not.toHaveBeenCalled()
  })

  it('fences an approval suspended before dispatch', async () => {
    const { bridge, api, execute } = setup()
    const result = api.run({ prompt: 'Q' })
    bridge.approve()
    bridge.suspend()
    await expect(result).rejects.toThrow('cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('expires an unanswered confirmation without inference', async () => {
    vi.useFakeTimers()
    const { api, execute } = setup()
    const result = api.run({ prompt: 'Q' })
    const rejected = result.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await rejected).toBe('AI request cancelled.')
    expect(execute).not.toHaveBeenCalled()
  })
})
