import { createContext, useContext } from 'react'
import { ServerConfig, AuthVendorInfo, DEPLOYMENT_HUB_IDS, type DeploymentHubId, resolveSiteName } from '@gadgets/workshop-shared/api'

export type ServerConfigUpdate = Partial<ServerConfig>

// Deployment-level configuration fetched once at boot via PublicApi.getServerConfig().
// `null` while still loading.
export const ServerConfigContext = createContext<ServerConfig | null>(null)
export const ServerConfigErrorContext = createContext(false)
export const ServerConfigUpdateContext = createContext<(update: ServerConfigUpdate) => void>(() => {})

// Returns the server config, or null while it is still loading.
export function useServerConfig(): ServerConfig | null {
  return useContext(ServerConfigContext)
}

// Returns whether the latest deployment-config request failed.
export function useServerConfigError(): boolean {
  return useContext(ServerConfigErrorContext)
}

// Returns a safe updater for locally patching deployment config after successful admin mutations.
export function useServerConfigUpdater(): (update: ServerConfigUpdate) => void {
  return useContext(ServerConfigUpdateContext)
}

// Convenience: the admin-configured site name, falling back to the default while config is still
// loading or when the admin hasn't set one.
export function useSiteName(): string {
  return resolveSiteName(useContext(ServerConfigContext)?.siteName)
}

// Convenience: the gatekeeper vendors offered as sign-in methods (empty until config loads / none).
export function useAuthVendors(): AuthVendorInfo[] {
  return useContext(ServerConfigContext)?.authVendors ?? []
}

// Convenience: whether the Cloudflare limits / top-up flow is enabled.
export function useCloudflareLimitsEnabled(): boolean {
  return useContext(ServerConfigContext)?.cloudflareLimitsEnabled ?? false
}

// Convenience: the globally curated hubs, with launch defaults while config is loading.
export function useEnabledHubs(): DeploymentHubId[] {
  return useContext(ServerConfigContext)?.enabledHubs ?? [...DEPLOYMENT_HUB_IDS]
}
