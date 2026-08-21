import { describe, expect, it } from 'vitest'
import { isSupportCuratedAsset, rankForSelectedHub } from './supportCuration'

describe('support curation ranking', () => {
  it('promotes support-curated assets only under the Support hub without hiding others', () => {
    const items = [
      { id: 'analytics' },
      { id: 'zendesk' },
      { id: 'jira' },
      { id: 'notion' },
    ]

    expect(rankForSelectedHub(items, 'support', (item) =>
      isSupportCuratedAsset('connector', item.id),
    ).map((item) => item.id)).toEqual(['zendesk', 'jira', 'analytics', 'notion'])

    expect(rankForSelectedHub(items, 'ops', (item) =>
      isSupportCuratedAsset('connector', item.id),
    ).map((item) => item.id)).toEqual(['analytics', 'zendesk', 'jira', 'notion'])
  })

  it('includes Team PI without matching unrelated partial words', () => {
    expect(isSupportCuratedAsset('connector', 'team-pi')).toBe(true)
    expect(isSupportCuratedAsset('featured', 'customer-success-board')).toBe(true)
    expect(isSupportCuratedAsset('featured', 'incidentally-useful')).toBe(false)
  })
})
