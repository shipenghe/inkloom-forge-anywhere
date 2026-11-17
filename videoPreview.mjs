import { BlobSource, Input, MP4, QTFF, VideoSampleSink, WEBM } from 'mediabunny'

// Decode a frame from the delivered file without starting a video player in
// the destination tab. Chromium may defer a hidden tab's media preload.
export async function inspectVideoFile(file, encodePreview) {
  const input = new Input({
    source: new BlobSource(file),
    formats: [MP4, QTFF, WEBM],
  })
  let dimensions = {}
  let timer
  async function inspect() {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return dimensions
    const width = track.displayWidth
    const height = track.displayHeight
    if (!width || !height) return dimensions
    dimensions = { width, height }
    if (typeof VideoDecoder !== 'function') return dimensions
    const start = await track.getFirstTimestamp()
    // Give introductory black frames a chance to pass.
    const sample = await new VideoSampleSink(track).getSample(
      Math.max(0, start) + 2
    )
    if (!sample) return dimensions
    try {
      const previewDataUrl = encodePreview(width, height, (context, w, h) =>
        sample.draw(context, 0, 0, w, h)
      )
      return { ...dimensions, ...(previewDataUrl ? { previewDataUrl } : {}) }
    } finally {
      sample.close()
    }
  }

  try {
    return await Promise.race([
      inspect(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(dimensions), 1_500)
      }),
    ])
  } catch {
    return dimensions
  } finally {
    clearTimeout(timer)
    input.dispose()
  }
}
