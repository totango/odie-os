import { getWorkshopRuntime } from './runtime'

export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

function makeFilename(title: string, fallback: string): string {
  return title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function makeBlueprintFilename(title: string, version: number): string {
  return `${makeFilename(title, 'blueprint')}-v${version}${BLUEPRINT_ARCHIVE_EXTENSION}`
}

export function makeExportFilename(title: string, extension: string): string {
  return `${makeFilename(title, 'gadget')}${extension}`
}

type SaveFileHandle = {
  createWritable(): Promise<WritableStream<Uint8Array>>
}

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}) => Promise<SaveFileHandle>

export async function saveStreamToFile(
  createStream: () => Promise<ReadableStream<Uint8Array>>,
  filename: string,
  fileType: {
    description: string
    contentType: string
    extension: string
  },
): Promise<void> {
  const runtime = getWorkshopRuntime()
  if (runtime.kind === 'web') {
    const showSaveFilePicker = (window as Window & {
      showSaveFilePicker?: SaveFilePicker
    }).showSaveFilePicker

    if (showSaveFilePicker) {
      // Open the file picker immediately after user interaction and before fetching file stream
      // to avoid browser security errors raised when delay is too long.
      let handle: SaveFileHandle
      try {
        handle = await showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: fileType.description,
            accept: {
              [fileType.contentType]: [fileType.extension],
            },
          }],
        })
      } catch (error) {
        // AbortError means the user exited the file picker without selecting a destination.
        if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
        return
      }

      const writable = await handle.createWritable()
      let stream: ReadableStream<Uint8Array>
      try {
        stream = await createStream()
      } catch (error) {
        await writable.abort(error).catch(() => {})
        throw error
      }
      await stream.pipeTo(writable)
      return
    }
  }

  const stream = await createStream()
  await runtime.saveBlob(await new Response(stream, {
    headers: { 'Content-Type': fileType.contentType },
  }).blob(), {
    filename,
    contentType: fileType.contentType,
    extension: fileType.extension,
    description: fileType.description,
  })
}

export function saveTextToFile(filename: string, content: string): void {
  void getWorkshopRuntime().saveText(filename, content)
}
