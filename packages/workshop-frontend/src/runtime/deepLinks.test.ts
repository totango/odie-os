import { describe, expect, it } from 'vitest'
import { parseNativeDeepLink, verifiedLinkMatrix } from './deepLinks'

const origin = 'https://odie-os.odie-os.workers.dev'

describe('parseNativeDeepLink', () => {
  it('accepts claimed SPA routes and native OAuth returns', () => {
    expect(parseNativeDeepLink(`${origin}/`)).toEqual({ kind: 'spa-route', path: '/' })
    expect(parseNativeDeepLink(`${origin}/workspace/abc?x=1`)).toEqual({ kind: 'spa-route', path: '/workspace/abc?x=1' })
    expect(parseNativeDeepLink(`${origin}/native/oauth-return/${'a'.repeat(32)}`)).toEqual({ kind: 'oauth-return', handle: 'a'.repeat(32) })
  })

  it('retains only validated workspace share fragments', () => {
    expect(parseNativeDeepLink(`${origin}/workspace/abc#share=${'s'.repeat(32)}`)).toEqual({
      kind: 'spa-route',
      path: `/workspace/abc#share=${'s'.repeat(32)}`,
    })
    expect(parseNativeDeepLink(`${origin}/workspace/abc#share=short`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/workspaces#share=${'s'.repeat(32)}`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/workspace/abc#token=${'s'.repeat(32)}`)).toBeNull()
  })

  it('rejects excluded routes and unsafe URL shapes', () => {
    expect(parseNativeDeepLink(`${origin}/api`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/gatekeeper/google/oauth`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/native/oauth-start/ticket`)).toBeNull()
    expect(parseNativeDeepLink(`http://odie-os.odie-os.workers.dev/workspaces`)).toBeNull()
    expect(parseNativeDeepLink(`https://user:pass@odie-os.odie-os.workers.dev/workspaces`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/native/oauth-return/${'b'.repeat(32)}#token`)).toBeNull()
    expect(parseNativeDeepLink(`${origin}/native/oauth-return/%E0%A4%A`)).toBeNull()
  })

  it('keeps the verified-link matrix explicit', () => {
    expect(verifiedLinkMatrix.claimed).toContain('/native/oauth-return/*')
    expect(verifiedLinkMatrix.excluded).toContain('/api/*')
    expect(verifiedLinkMatrix.excluded).toContain('/native/oauth-start/*')
  })
})
