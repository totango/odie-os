import type { DeploymentHubId } from '@gadgets/workshop-shared/api'

export function blueprintCreationOrigin(hub: DeploymentHubId): DeploymentHubId | undefined {
  return hub === 'finance' ? undefined : hub
}
