/** OpenCode v1.18.30 SnapshotFileDiff (packages/sdk/js/src/v2/gen/types.gen.ts).
 * The runtime returns patches, not complete before/after documents. */
export type SessionChange = {
  path: string
  status?: 'added' | 'deleted' | 'modified'
  additions?: number
  deletions?: number
  patch?: string
  omission?: string
}

export type SessionChanges = { files: SessionChange[]; notice?: string }

const MAX_FILES = 100
const MAX_PATCH_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const encoder = new TextEncoder()

export const readDiffResponse = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Diff response has no body.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      // Bound the wire representation too, before JSON parsing (including escaped text).
      if (bytes > 2 * 1024 * 1024) throw new Error('Diff response exceeds the size limit.')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const parseOpenCodeChanges = (value: unknown): SessionChanges => {
  if (!Array.isArray(value)) return { files: [], notice: 'Unsupported diff response.' }
  let remaining = MAX_TOTAL_BYTES
  const files = value.slice(0, MAX_FILES).map((entry: unknown, index): SessionChange => {
    const fallback = `Entry ${index + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { path: fallback, omission: 'Malformed diff entry.' }
    }
    const item = entry as Record<string, unknown>
    // Paths are display labels only; never use them to read or write the sandbox.
    if (typeof item.file !== 'string' || !item.file || item.file.length > 1024 ||
        [...item.file].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      return { path: fallback, omission: 'Missing or invalid file path.' }
    }
    const result: SessionChange = { path: item.file }
    if (!count(item.additions) || !count(item.deletions) ||
        (item.status !== undefined && !['added', 'deleted', 'modified'].includes(String(item.status)))) {
      return { ...result, omission: 'Malformed diff metadata.' }
    }
    result.additions = item.additions
    result.deletions = item.deletions
    result.status = item.status as SessionChange['status']
    if (typeof item.patch !== 'string' || !item.patch) {
      return { ...result, omission: 'Patch not supplied by the runtime.' }
    }
    if (item.patch.length > MAX_PATCH_BYTES || item.patch.length > remaining) {
      return { ...result, omission: 'Patch omitted: display size limit exceeded.' }
    }
    const bytes = encoder.encode(item.patch).length
    if (bytes > MAX_PATCH_BYTES || bytes > remaining) {
      return { ...result, omission: 'Patch omitted: display size limit exceeded.' }
    }
    remaining -= bytes
    if (item.patch.includes('\0') || /^(Binary files .* differ|GIT binary patch)/m.test(item.patch)) {
      return { ...result, omission: 'Binary changes cannot be displayed as text.' }
    }
    if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(item.patch)) {
      return { ...result, omission: 'No supported text hunks in this patch.' }
    }
    return { ...result, patch: item.patch }
  })
  return { files, ...(value.length > MAX_FILES ? { notice: `${value.length - MAX_FILES} additional files omitted.` } : {}) }
}
