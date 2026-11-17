import { ADTS, BlobSource, FLAC, Input, MP3, MP4, OGG, WAVE } from 'mediabunny'

const mimeByFormat = new Map([
  [MP3, 'audio/mpeg'],
  [WAVE, 'audio/wav'],
  [MP4, 'audio/mp4'],
  [ADTS, 'audio/aac'],
  [OGG, 'audio/ogg'],
  [FLAC, 'audio/flac'],
])

export async function inspectAudioFile(blob) {
  const input = new Input({
    source: new BlobSource(blob),
    formats: [...mimeByFormat.keys()],
  })
  try {
    const mime = mimeByFormat.get(await input.getFormat())
    const track = await input.getPrimaryAudioTrack()
    if (!mime || !track || (await input.getPrimaryVideoTrack())) return null
    const duration = await track.computeDuration().catch(() => undefined)
    return { mime, duration }
  } catch {
    return null
  } finally {
    input.dispose()
  }
}
