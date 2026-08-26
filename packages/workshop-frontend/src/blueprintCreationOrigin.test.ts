import { describe, expect, it } from 'vitest'
import { blueprintCreationOrigin } from './blueprintCreationOrigin'

describe('generic creation origin', () => {
  it('does not stamp a generic workspace or ordinary blueprint as Finance', () => {
    expect(blueprintCreationOrigin('finance')).toBeUndefined()
  })

  it('preserves configurable hub origins', () => {
    expect(blueprintCreationOrigin('support')).toBe('support')
  })
})
