import type { ServiceBinding } from './release/manifest-lib.ts';

/** Optional private backend binding: never participates in router or ambient gatekeeper discovery. */
export function requestBuildNotifierBinding(gatekeepers: readonly { name: string }[]): ServiceBinding[] {
  const jarvis = gatekeepers.find(gatekeeper => gatekeeper.name === 'gatekeeper-jarvis');
  return jarvis ? [{ binding: 'REQUEST_BUILD_NOTIFIER', service: jarvis.name, entrypoint: 'RequestBuildNotifierEntrypoint' }] : [];
}
