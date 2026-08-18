import { describe, expect, it } from 'vitest'
import { availableConnectionVendors } from './connectionAvailability'

describe('availableConnectionVendors', () => {
  it('removes connected vendors and deduplicates remaining vendor sources', () => {
    const github = { id: 'github', source: 'oauth' }
    const teamPi = { id: 'team_pi', source: 'oauth' }
    const context = { id: 'context', source: 'ambient' }

    expect(availableConnectionVendors(
      [github, teamPi, teamPi, context],
      ['github', 'team_pi'],
    )).toEqual([context])
  })

  it('makes a vendor available again after its last account is removed', () => {
    const teamPi = { id: 'team_pi' }

    expect(availableConnectionVendors([teamPi], [])).toEqual([teamPi])
  })
})
