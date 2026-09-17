import { describe, expect, it } from 'vitest'
import { parseOpenCodeChanges, readDiffResponse } from './openCodeChanges'

const patch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const entry = { file: 'src/a.ts', additions: 1, deletions: 1, status: 'modified', patch }

describe('OpenCode 1.18.30 changes adapter', () => {
  it('limits the wire body before parsing and rejects malformed JSON', async () => {
    await expect(readDiffResponse(new Response(JSON.stringify([entry])))).resolves.toEqual([entry])
    await expect(readDiffResponse(new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow('size limit')
    await expect(readDiffResponse(new Response('{broken'))).rejects.toThrow(SyntaxError)
  })
  it('preserves runtime patches exactly, without inventing whole file contents', () => {
    expect(parseOpenCodeChanges([entry])).toEqual({ files: [{ path: 'src/a.ts', additions: 1, deletions: 1, status: 'modified', patch }] })
  })
  it('distinguishes empty responses from unsupported and malformed data', () => {
    expect(parseOpenCodeChanges([])).toEqual({ files: [] })
    expect(parseOpenCodeChanges({ diff: [] }).notice).toContain('Unsupported')
    expect(parseOpenCodeChanges([null, { ...entry, file: 'bad\0path' }, { ...entry, additions: -1 }]).files.every(file => file.omission)).toBe(true)
  })
  it('reports binary, missing, unsupported and oversized patches honestly', () => {
    const files = parseOpenCodeChanges([
      { ...entry, patch: 'Binary files a/a.png and b/a.png differ' },
      { ...entry, patch: undefined },
      { ...entry, patch: 'not a unified patch' },
      { ...entry, patch: 'x'.repeat(128 * 1024 + 1) },
    ]).files
    expect(files.map(file => file.omission)).toEqual([
      'Binary changes cannot be displayed as text.', 'Patch not supplied by the runtime.',
      'No supported text hunks in this patch.', 'Patch omitted: display size limit exceeded.',
    ])
    expect(files.every(file => file.patch === undefined)).toBe(true)
  })
  it('bounds file count and aggregate UTF-8 bytes', () => {
    const result = parseOpenCodeChanges(Array.from({ length: 101 }, () => ({ ...entry, patch: patch + 'é'.repeat(60_000) })))
    expect(result.files).toHaveLength(100)
    expect(result.notice).toBe('1 additional files omitted.')
    expect(result.files.filter(file => file.patch)).toHaveLength(4)
  })
})
