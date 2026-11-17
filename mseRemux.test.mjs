import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import {
  matchesFragmentedVideoDuration,
  remuxCapturedVideo,
} from './mseRemux.mjs'

const open = (bytes) =>
  new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
const fixture = await readFile(
  new URL('./fixtures/remux-sample.mp4', import.meta.url)
)

async function fragmented(kind, offset = 0.1) {
  const input = open(fixture)
  const track =
    kind === 'video'
      ? await input.getPrimaryVideoTrack()
      : await input.getPrimaryAudioTrack()
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 1,
    }),
    target: new BufferTarget(),
  })
  const source =
    kind === 'video'
      ? new EncodedVideoPacketSource(track.codec)
      : new EncodedAudioPacketSource(track.codec)
  if (kind === 'video') output.addVideoTrack(source)
  else output.addAudioTrack(source)
  await output.start()
  let first = true
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(
      packet.clone({ timestamp: packet.timestamp + offset }),
      first ? { decoderConfig: await track.getDecoderConfig() } : undefined
    )
    first = false
  }
  source.close()
  await output.finalize()
  input.dispose()
  return new Uint8Array(output.target.buffer)
}
const video = await fragmented('video')
const audio = await fragmented('audio')
const stream = (kind, bytes) => ({ mime: `${kind}/mp4`, chunks: [bytes] })
async function hash(track) {
  const h = createHash('sha256')
  for await (const packet of new EncodedPacketSink(track).packets())
    h.update(packet.data)
  return h.digest('hex')
}

test('accepts a standalone fragmented file only when structurally complete for the player duration', async () => {
  const blob = new Blob([video], { type: 'video/mp4' })
  assert.equal(await matchesFragmentedVideoDuration(blob, 15), true)
  assert.equal(await matchesFragmentedVideoDuration(blob, 30), false)
  assert.equal(await matchesFragmentedVideoDuration(blob), false)
  assert.equal(
    await matchesFragmentedVideoDuration(blob.slice(0, blob.size - 1), 15),
    false
  )
})

test('remuxes contiguous separate tracks without re-encoding video or losing audio', async () => {
  const result = await remuxCapturedVideo(
    [stream('video', video), stream('audio', audio)],
    { requireAudio: true }
  )
  assert.equal(result.hasAudio, true)
  assert.equal(result.blob.type, 'video/mp4')
  assert.ok(result.duration > 1)
  const source = open(video)
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  const originalTrack = await source.getPrimaryVideoTrack()
  const outputTrack = await output.getPrimaryVideoTrack()
  assert.equal(await hash(originalTrack), await hash(outputTrack))
  assert.ok(await output.getPrimaryAudioTrack())
  source.dispose()
  output.dispose()
})

test('reports a video-only result, and refuses it when the caller expects audio', async () => {
  const result = await remuxCapturedVideo([stream('video', video)])
  assert.equal(result.hasAudio, false)
  await assert.rejects(
    remuxCapturedVideo([stream('video', video)], { requireAudio: true }),
    /音视频轨道不完整/
  )
})

test('uses the shared interval when video buffers past the end of the audio', async () => {
  const result = await remuxCapturedVideo(
    [stream('video', video), { ...stream('audio', audio), appendWindowEnd: 4 }],
    { requireAudio: true }
  )
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  try {
    const outVideo = await output.getPrimaryVideoTrack()
    const outAudio = await output.getPrimaryAudioTrack()
    assert.equal(
      (await new EncodedPacketSink(outVideo).getFirstPacket()).type,
      'key'
    )
    assert.ok(
      result.sourceStart < 1 &&
        result.sourceEnd > 3.5 &&
        result.sourceEnd <= 4.15
    )
    assert.ok(
      Math.abs(
        (await outVideo.computeDuration()) - (await outAudio.computeDuration())
      ) < 0.16
    )
  } finally {
    output.dispose()
  }
})

test('starts on the next keyframe when audio begins late and rejects disjoint tracks', async () => {
  const result = await remuxCapturedVideo(
    [
      stream('video', video),
      { ...stream('audio', audio), appendWindowStart: 2 },
    ],
    { requireAudio: true }
  )
  assert.ok(result.sourceStart > 12 && result.sourceStart < 14)
  assert.ok(result.duration > 1)
  await assert.rejects(
    remuxCapturedVideo([
      { ...stream('video', video), appendWindowEnd: 4 },
      { ...stream('audio', audio), appendWindowStart: 7 },
    ]),
    /音视频片段时间范围不一致/
  )
})

test('rejects incomplete, oversized and clearly encrypted data', async () => {
  await assert.rejects(
    remuxCapturedVideo([stream('video', video.subarray(0, video.length - 1))]),
    /不完整/
  )
  await assert.rejects(
    remuxCapturedVideo([stream('video', new Uint8Array(64 * 1024 * 1024 + 1))]),
    /过大/
  )
  const encrypted = video.slice()
  const text = new TextDecoder('latin1').decode(encrypted)
  const moov = text.indexOf('moov')
  assert.ok(moov > 0)
  encrypted.set(new TextEncoder().encode('tenc'), moov + 8)
  await assert.rejects(remuxCapturedVideo([stream('video', encrypted)]), /加密/)
})

test('rejects a missing fragmented MP4 sequence number', async () => {
  const broken = video.slice()
  const text = new TextDecoder('latin1').decode(broken)
  const first = text.indexOf('mfhd')
  const second = text.indexOf('mfhd', first + 4)
  assert.ok(second > first)
  const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength)
  view.setUint32(second + 8, view.getUint32(second + 8) + 2)
  await assert.rejects(remuxCapturedVideo([stream('video', broken)]), /不连续/)
})

test('the checked-in classic worker bundle exposes the same remux API without imports', async () => {
  const { runInThisContext } = await import('node:vm')
  const bundle = await readFile(
    new URL('./mseRemux.bundle.js', import.meta.url),
    'utf8'
  )
  runInThisContext(bundle, { filename: 'mseRemux.bundle.js' })
  assert.equal(
    typeof globalThis.__inkloomMseRemux.remuxCapturedVideo,
    'function'
  )
  const result = await globalThis.__inkloomMseRemux.remuxCapturedVideo([
    stream('video', video),
  ])
  assert.equal(result.blob.type, 'video/mp4')
  assert.equal(result.hasAudio, false)
  await assert.rejects(
    globalThis.__inkloomMseRemux.remuxCapturedVideo([
      {
        ...stream('video', video),
        timestampOffset: 2,
        appendWindowStart: 3,
        appendWindowEnd: 5,
      },
    ]),
    /关键帧/
  )
  delete globalThis.__inkloomMseRemux
})

test('trims audio that starts early while preserving alignment', async () => {
  const fullVideo = await fragmented('video', 0.7)
  let pos = 0
  while (pos < fullVideo.length) {
    const size = new DataView(
      fullVideo.buffer,
      fullVideo.byteOffset + pos
    ).getUint32(0)
    const type = String.fromCharCode(...fullVideo.subarray(pos + 4, pos + 8))
    pos += size
    if (type === 'mdat') break
  }
  const delayedVideo = fullVideo.subarray(0, pos)
  const result = await remuxCapturedVideo(
    [stream('video', delayedVideo), stream('audio', audio)],
    { requireAudio: true }
  )
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  const videoTrack = await output.getPrimaryVideoTrack()
  const audioTrack = await output.getPrimaryAudioTrack()
  const delta =
    (await videoTrack.getFirstTimestamp()) -
    (await audioTrack.getFirstTimestamp())
  assert.ok(delta >= 0 && delta < 0.1, `audio lead ${delta}`)
  output.dispose()
})

test('honors distinct SourceBuffer timestamp offsets to keep audio and video aligned', async () => {
  const laterAudio = await fragmented('audio', 1.7)
  const result = await remuxCapturedVideo(
    [
      {
        ...stream('video', video),
        timestampOffset: 2,
        appendWindowStart: 2,
        appendWindowEnd: null,
      },
      {
        ...stream('audio', laterAudio),
        timestampOffset: 0.4,
        appendWindowStart: 2,
        appendWindowEnd: 100,
      },
    ],
    { requireAudio: true }
  )
  const inputVideo = open(video)
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  const outVideo = await output.getPrimaryVideoTrack()
  const outAudio = await output.getPrimaryAudioTrack()
  assert.equal(
    await hash(await inputVideo.getPrimaryVideoTrack()),
    await hash(outVideo)
  )
  const delta =
    (await outVideo.getFirstTimestamp()) - (await outAudio.getFirstTimestamp())
  assert.ok(delta >= 0 && delta < 0.1, `audio lead ${delta}`)
  inputVideo.dispose()
  output.dispose()
})

test('trims a clipped window from the first fully contained keyframe and preserves audio', async () => {
  const result = await remuxCapturedVideo(
    [
      { ...stream('video', video), appendWindowStart: 1, appendWindowEnd: 14 },
      { ...stream('audio', audio), appendWindowStart: 1, appendWindowEnd: 14 },
    ],
    { requireAudio: true }
  )
  assert.equal(result.hasAudio, true)
  assert.ok(result.duration > 1 && result.duration < 1.5)
  const input = open(video)
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  const expectedHash = createHash('sha256')
  let started = false
  for await (const packet of new EncodedPacketSink(
    await input.getPrimaryVideoTrack()
  ).packets()) {
    if (!started && packet.type === 'key' && packet.timestamp >= 1)
      started = true
    if (started && packet.timestamp + packet.duration <= 14 + 1e-7)
      expectedHash.update(packet.data)
  }
  const outVideo = await output.getPrimaryVideoTrack()
  const outAudio = await output.getPrimaryAudioTrack()
  assert.equal(await hash(outVideo), expectedHash.digest('hex'))
  assert.ok(outAudio)
  const lead =
    (await outVideo.getFirstTimestamp()) - (await outAudio.getFirstTimestamp())
  assert.ok(Math.abs(lead) < 0.1, `audio lead ${lead}`)
  input.dispose()
  output.dispose()
})

test('drops only tail packets crossing the window, including microsecond video and millisecond audio overhangs', async () => {
  const inputVideo = open(video)
  const inputAudio = open(audio)
  async function packets(track) {
    const values = []
    for await (const packet of new EncodedPacketSink(track).packets())
      values.push(packet)
    return values
  }
  const v = await packets(await inputVideo.getPrimaryVideoTrack())
  const a = await packets(await inputAudio.getPrimaryAudioTrack())
  const vEnd = v.at(-1).timestamp + v.at(-1).duration - 0.000005
  const aEnd = a.at(-1).timestamp + a.at(-1).duration - 0.00476
  const result = await remuxCapturedVideo(
    [
      { ...stream('video', video), appendWindowEnd: vEnd },
      { ...stream('audio', audio), appendWindowEnd: aEnd },
    ],
    { requireAudio: true }
  )
  const output = open(new Uint8Array(await result.blob.arrayBuffer()))
  const outV = await packets(await output.getPrimaryVideoTrack())
  const outA = await packets(await output.getPrimaryAudioTrack())
  assert.equal(outV.length, v.length - 1)
  const videoStart = Math.min(
    ...v.slice(0, -1).map((packet) => packet.timestamp)
  )
  const videoEnd = Math.max(
    ...v.slice(0, -1).map((packet) => packet.timestamp + packet.duration)
  )
  const expectedAudio = a.filter(
    (packet) =>
      packet.timestamp >= -1e-7 &&
      packet.timestamp + packet.duration <= aEnd + 1e-7 &&
      packet.timestamp + packet.duration > videoStart &&
      packet.timestamp < videoEnd
  )
  assert.equal(outA.length, expectedAudio.length)
  assert.ok(outA.length < a.length)
  assert.ok(result.duration > 14)
  inputVideo.dispose()
  inputAudio.dispose()
  output.dispose()
})

test('rejects a clipped window without a keyframe and invalid timing metadata', async () => {
  await assert.rejects(
    remuxCapturedVideo([
      {
        ...stream('video', video),
        timestampOffset: 2,
        appendWindowStart: 3,
        appendWindowEnd: 5,
      },
    ]),
    /关键帧/
  )
  for (const timing of [
    { timestampOffset: null },
    { timestampOffset: Infinity },
    { appendWindowStart: -1 },
    { appendWindowStart: null },
    { appendWindowStart: 2, appendWindowEnd: 2 },
  ]) {
    await assert.rejects(
      remuxCapturedVideo([{ ...stream('video', video), ...timing }]),
      /时间配置无效/
    )
  }
})

test('reports the original player interval before normalizing the exported clip to zero', async () => {
  const result = await remuxCapturedVideo(
    [
      {
        ...stream('video', video),
        timestampOffset: 20,
        appendWindowStart: 0,
        appendWindowEnd: null,
      },
      {
        ...stream('audio', audio),
        timestampOffset: 20,
        appendWindowStart: 0,
        appendWindowEnd: null,
      },
    ],
    { requireAudio: true }
  )
  const source = open(video)
  const track = await source.getPrimaryVideoTrack()
  const packets = []
  for await (const packet of new EncodedPacketSink(track).packets())
    packets.push(packet)
  const expectedStart = Math.min(...packets.map((p) => p.timestamp)) + 20
  const expectedEnd =
    Math.max(...packets.map((p) => p.timestamp + p.duration)) + 20
  assert.ok(Math.abs(result.sourceStart - expectedStart) < 1e-6)
  assert.ok(Math.abs(result.sourceEnd - expectedEnd) < 1e-6)
  assert.ok(result.sourceStart >= 20)
  assert.ok(
    Math.abs(result.duration - (result.sourceEnd - result.sourceStart)) < 1e-6
  )
  const exported = open(new Uint8Array(await result.blob.arrayBuffer()))
  const outputTrack = await exported.getPrimaryVideoTrack()
  const first = await new EncodedPacketSink(outputTrack).getFirstPacket()
  assert.ok(
    first.timestamp < 1,
    'export timeline is reset but the UI interval is not'
  )
  source.dispose()
  exported.dispose()
})
