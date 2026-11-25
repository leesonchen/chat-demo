import { Capacitor, registerPlugin } from '@capacitor/core'

type Transfer = { id: string; name: string; type: string }

const NativeFiles = registerPlugin<{
  append(options: Transfer & { data: string }): Promise<void>
  discard(options: Transfer): Promise<void>
  save(options: Transfer): Promise<void>
  open(options: Transfer): Promise<void>
}>('NativeFiles')

export const usesAndroidFiles = () => Capacitor.getPlatform() === 'android'

const asBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

export const transferAndroidFile = async (blob: Blob, name: string, open = false) => {
  const transfer = {
    id: crypto.randomUUID(),
    // Keep the extension for document providers and stay within filesystem name limits.
    name: Array.from(name.replace(/[/\\]/g, '_'), (character) =>
      character.charCodeAt(0) < 32 ? '_' : character
    )
      .slice(-60)
      .join(''),
    type: blob.type || 'application/octet-stream',
  }
  const chunkSize = 256 * 1024
  try {
    for (let offset = 0; offset < Math.max(1, blob.size); offset += chunkSize) {
      const data = await asBase64(blob.slice(offset, offset + chunkSize))
      await NativeFiles.append({ ...transfer, data })
    }
    await (open ? NativeFiles.open(transfer) : NativeFiles.save(transfer))
  } catch (error) {
    await NativeFiles.discard(transfer).catch(() => {})
    throw error
  }
}
