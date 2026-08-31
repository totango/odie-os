import { createTauriRuntime, isTauriRuntime } from './tauriRuntime'
import { createWebRuntime } from './webRuntime'
import type { WorkshopRuntime } from './WorkshopRuntime'

let runtimeSingleton: WorkshopRuntime | null = null

export function getWorkshopRuntime(): WorkshopRuntime {
  runtimeSingleton ??= isTauriRuntime() ? createTauriRuntime() : createWebRuntime()
  return runtimeSingleton
}

export type { WorkshopRuntime } from './WorkshopRuntime'
export { ODIE_PRODUCTION_ORIGIN } from './WorkshopRuntime'
export { parseNativeDeepLink, verifiedLinkMatrix } from './deepLinks'
export { addNativeLoginTokenListener, consumePendingNativeLoginUrl, dispatchNativeLoginToken, installNativeLoginCoordinator } from './nativeLoginCoordinator'
