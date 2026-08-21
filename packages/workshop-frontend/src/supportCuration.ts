import type { DeploymentHubId } from '@gadgets/workshop-shared/api'

export type SupportAssetType = 'connector' | 'featured' | 'format' | 'schedule'

export type CuratedAssetKey = `${SupportAssetType}:${string}`

const SUPPORT_CURATION_KEYS: ReadonlySet<CuratedAssetKey> = new Set([
  'connector:context',
  'connector:github',
  'connector:jira',
  'connector:linear',
  'connector:odie-kg',
  'connector:team-pi',
  'connector:totango-kg',
  'connector:zendesk',
  'featured:customer-impact',
  'featured:support',
  'format:incident-report',
  'format:support-brief',
  'schedule:support-follow-up',
])

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export function curatedAssetKey(type: SupportAssetType, id: string): CuratedAssetKey {
  return `${type}:${normalize(id)}`
}

export function isSupportCuratedAsset(type: SupportAssetType, id: string): boolean {
  const normalized = normalize(id)
  if (SUPPORT_CURATION_KEYS.has(curatedAssetKey(type, normalized))) return true
  return type === 'featured' || type === 'format'
    ? normalized.split(/[-_.\s]+/).some((part) =>
        ['support', 'customer', 'ticket', 'incident', 'zendesk'].includes(part),
      )
    : false
}

export function isSupportOrigin(originHubId: DeploymentHubId | undefined): boolean {
  return originHubId === 'support'
}

export function rankForSelectedHub<T>(
  items: readonly T[],
  hub: DeploymentHubId,
  isSupportItem: (item: T) => boolean,
): T[] {
  if (hub !== 'support') return [...items]
  const support: T[] = []
  const other: T[] = []
  for (const item of items) (isSupportItem(item) ? support : other).push(item)
  return [...support, ...other]
}
