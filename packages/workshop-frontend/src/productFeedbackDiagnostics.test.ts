// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { installProductFeedbackDiagnostics, productFeedbackDiagnosticsSnapshot } from './productFeedbackDiagnostics'

describe('product feedback diagnostics', () => {
  it('captures and sanitizes current-tab console diagnostics', () => {
    installProductFeedbackDiagnostics()
    console.warn(
      'authorization: Bearer abc.def',
      'token=secret',
      'https://odie.test/share#bearer-capability',
      'https://user:password@example.com/private',
    )
    const last = productFeedbackDiagnosticsSnapshot().at(-1)
    expect(last?.level).toBe('warn')
    expect(last?.message).toContain('authorization=[redacted]')
    expect(last?.message).toContain('[redacted-url]')
    expect(last?.message).not.toContain('abc.def')
    expect(last?.message).not.toContain('secret')
    expect(last?.message).not.toContain('bearer-capability')
    expect(last?.message).not.toContain('user:password')
  })
})
