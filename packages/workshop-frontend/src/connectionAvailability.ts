export function availableConnectionVendors<T extends { id: string }>(
  vendors: readonly T[],
  connectedVendorIds: Iterable<string>,
): T[] {
  const connected = new Set(connectedVendorIds)
  const available = new Map<string, T>()
  for (const vendor of vendors) {
    if (!connected.has(vendor.id) && !available.has(vendor.id)) available.set(vendor.id, vendor)
  }
  return [...available.values()]
}
