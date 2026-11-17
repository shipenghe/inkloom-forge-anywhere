import { ADTS, BlobSource, FLAC, Input, MP3, MP4, OGG, WAVE } from 'mediabunny'
import './audioFormats.js'

const parsers = { MP3, WAVE, MP4, ADTS, OGG, FLAC }
const mimeByFormat = new Map(
  Object.entries(parsers).map(([name, parser]) => [
    parser,
    globalThis.ForgeAudioFormats.formats[name].mime,
  ])
)

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
