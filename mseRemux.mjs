// MSE fragmented MP4 remuxing. Only a captured initialization segment and
// contiguous unencrypted fragments belonging to one selected media are accepted.
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_PACKETS = 100000
const MAX_GAP_SECONDS = 0.35
const AUDIO_SYNC_TOLERANCE = 0.15

function boxes(bytes, start = 0, end = bytes.length) {
  const result = []
  for (let offset = start; offset < end; ) {
    if (end - offset < 8) throw new Error('视频片段数据不完整')
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      end - offset
    )
    let size = view.getUint32(0)
    let header = 8
    if (size === 1) {
      if (end - offset < 16) throw new Error('视频片段数据不完整')
      size = Number(view.getBigUint64(8))
      header = 16
    } else if (size === 0) size = end - offset
    if (!Number.isSafeInteger(size) || size < header || offset + size > end)
      throw new Error('视频片段数据不完整')
    result.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      offset,
      header,
      end: offset + size,
    })
    offset += size
  }
  return result
}

function hasMarker(bytes, box, marker) {
  const code = Array.from(marker, (c) => c.charCodeAt(0))
  for (let i = box.offset + box.header; i <= box.end - code.length; i++) {
    if (code.every((n, j) => bytes[i + j] === n)) return true
  }
  return false
}

function validateMp4(bytes) {
  const top = boxes(bytes)
  let init = false,
    header = false,
    waitingData = false,
    previousSequence = null
  let fragments = 0
  for (const box of top) {
    if (box.type === 'ftyp') {
      if (header || init || fragments) throw new Error('视频初始化片段发生变化')
      header = true
    } else if (box.type === 'moov') {
      if (!header || init || fragments)
        throw new Error('视频初始化片段发生变化')
      if (
        ['pssh', 'tenc', 'encv', 'enca', 'sinf'].some((marker) =>
          hasMarker(bytes, box, marker)
        )
      )
        throw new Error('暂不支持加密视频')
      init = true
    } else if (box.type === 'moof') {
      if (!init || waitingData)
        throw new Error('缺少初始化数据或视频片段不连续')
      if (
        ['senc', 'saiz', 'saio'].some((marker) => hasMarker(bytes, box, marker))
      )
        throw new Error('暂不支持加密视频')
      const headers = boxes(bytes, box.offset + box.header, box.end).filter(
        (x) => x.type === 'mfhd'
      )
      if (
        headers.length !== 1 ||
        headers[0].end - headers[0].offset < headers[0].header + 8
      )
        throw new Error('无法确认视频片段顺序')
      const sequence = new DataView(
        bytes.buffer,
        bytes.byteOffset + headers[0].offset + headers[0].header + 4,
        4
      ).getUint32(0)
      if (previousSequence !== null && sequence !== previousSequence + 1)
        throw new Error('视频片段不连续，请重新采集')
      previousSequence = sequence
      waitingData = true
      fragments++
    } else if (box.type === 'mdat') {
      if (!waitingData || box.end <= box.offset + box.header)
        throw new Error('视频片段数据不完整')
      waitingData = false
    } else if (
      !['styp', 'sidx', 'free', 'skip', 'mfra', 'prft', 'emsg'].includes(
        box.type
      )
    ) {
      throw new Error('暂不支持此视频分段格式')
    }
  }
  if (!header || !init || !fragments || waitingData)
    throw new Error('缺少初始化数据或可用的视频片段')
}

export async function matchesFragmentedVideoDuration(blob, expectedDuration) {
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return false
  let input
  try {
    // The same ordering and encryption checks apply to fragments in a file.
    validateMp4(new Uint8Array(await blob.arrayBuffer()))
    input = new Input({ source: new BlobSource(blob), formats: [MP4] })
    const video = await input.getPrimaryVideoTrack()
    if (!video?.codec) return false
    const start = await input.getFirstTimestamp()
    const end = await input.computeDuration()
    const tolerance = Math.min(0.25, expectedDuration / 20)
    return Math.abs(end - start - expectedDuration) <= tolerance
  } catch {
    return false
  } finally {
    input?.dispose()
  }
}

function concatStreams(streams) {
  if (!Array.isArray(streams) || streams.length < 1 || streams.length > 2)
    throw new Error('视频轨道数量不受支持')
  let total = 0
  return streams.map((stream) => {
    if (
      !stream ||
      typeof stream.mime !== 'string' ||
      !/^(video|audio)\/mp4(?:;|$)/i.test(stream.mime) ||
      !Array.isArray(stream.chunks) ||
      !stream.chunks.length
    )
      throw new Error('暂不支持此视频分段格式')
    let length = 0
    for (const chunk of stream.chunks) {
      if (!(chunk instanceof Uint8Array) || !chunk.byteLength)
        throw new Error('视频片段数据无效')
      length += chunk.byteLength
      total += chunk.byteLength
      if (total > MAX_BYTES) throw new Error('已采集的视频片段过大')
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of stream.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    validateMp4(bytes)
    return bytes
  })
}

function streamTiming(stream) {
  const timestampOffset =
    stream.timestampOffset === undefined ? 0 : stream.timestampOffset
  const appendWindowStart =
    stream.appendWindowStart === undefined ? 0 : stream.appendWindowStart
  const appendWindowEnd = stream.appendWindowEnd ?? Infinity
  if (
    typeof timestampOffset !== 'number' ||
    !Number.isFinite(timestampOffset) ||
    typeof appendWindowStart !== 'number' ||
    !Number.isFinite(appendWindowStart) ||
    appendWindowStart < 0 ||
    typeof appendWindowEnd !== 'number' ||
    (appendWindowEnd !== Infinity && !Number.isFinite(appendWindowEnd)) ||
    appendWindowEnd <= appendWindowStart
  )
    throw new Error('视频片段时间配置无效')
  return { timestampOffset, appendWindowStart, appendWindowEnd }
}

async function readPackets(track, timing) {
  const packets = []
  let started = false
  let ended = false
  let firstKeyTimestamp
  let scanned = 0
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (++scanned > MAX_PACKETS) throw new Error('视频片段过长')
    if (
      !Number.isFinite(packet.timestamp) ||
      !Number.isFinite(packet.duration) ||
      packet.duration < 0 ||
      !packet.data.byteLength
    )
      throw new Error('视频片段时间信息无效')
    const timestamp = packet.timestamp + timing.timestampOffset
    if (!Number.isFinite(timestamp)) throw new Error('视频片段时间信息无效')
    // SourceBuffer discards coded frames outside the append window. Start a
    // video clip only at a fully contained random-access point, then retain a
    // contiguous run in decode order. Once any subsequent packet is clipped,
    // later interframes can no longer be guaranteed to decode safely.
    const contained =
      timestamp >= timing.appendWindowStart - 1e-7 &&
      timestamp + packet.duration <= timing.appendWindowEnd + 1e-7
    if (!contained) {
      if (started) ended = true
      continue
    }
    // In decode order an out-of-window frame followed by an in-window frame
    // leaves a possible reference hole. Refuse rather than silently join it.
    if (ended) throw new Error('播放窗口造成片段不连续，无法安全组装')
    if (!started) {
      if (track.type === 'video' && packet.type !== 'key') continue
      started = true
      if (track.type === 'video') firstKeyTimestamp = timestamp
    }
    // Leading pictures whose presentation time precedes the retained key
    // frame may depend on pictures discarded by the window; don't include them.
    if (track.type === 'video' && timestamp < firstKeyTimestamp - 1e-7) {
      ended = true
      continue
    }
    packets.push(packet.clone({ timestamp }))
  }
  if (!packets.length)
    throw new Error(
      track.type === 'video'
        ? '播放窗口内没有可用关键帧，无法组装视频片段'
        : '播放窗口内没有完整音频数据，无法组装视频片段'
    )
  return { packets, ...packetRange(packets) }
}

function packetRange(packets) {
  const timeline = packets
    .map((p) => ({ start: p.timestamp, end: p.timestamp + p.duration }))
    .sort((a, b) => a.start - b.start)
  let end = timeline[0].end
  for (const item of timeline.slice(1)) {
    if (item.start > end + MAX_GAP_SECONDS)
      throw new Error('视频片段不连续，请重新采集')
    end = Math.max(end, item.end)
  }
  return { start: timeline[0].start, end }
}

function trimVideoToAudio(video, audio) {
  if (
    !audio ||
    (video.start >= audio.start - AUDIO_SYNC_TOLERANCE &&
      video.end <= audio.end + AUDIO_SYNC_TOLERANCE)
  )
    return video

  // Audio and video can buffer at different rates. Retain a prefix in decode
  // order, beginning at a real keyframe within the shared buffered time.
  const packets = []
  let start
  for (const packet of video.packets) {
    if (start === undefined) {
      if (
        packet.type !== 'key' ||
        packet.timestamp < audio.start - AUDIO_SYNC_TOLERANCE
      )
        continue
      start = packet.timestamp
    }
    if (
      packet.timestamp < start ||
      packet.timestamp + packet.duration > audio.end + AUDIO_SYNC_TOLERANCE
    )
      break
    packets.push(packet)
  }
  if (!packets.length) throw new Error('音视频片段时间范围不一致，请重新采集')
  return { packets, ...packetRange(packets) }
}

/**
 * @param {{mime:string,chunks:Uint8Array[],timestampOffset?:number,appendWindowStart?:number,appendWindowEnd?:number|null}[]} streams SourceBuffer streams for exactly one selected MediaSource. A null end denotes Infinity.
 * @param {{requireAudio?:boolean}} options Tell the caller when the source declared an audio track.
 * @returns {Promise<{blob:Blob,duration:number,hasAudio:boolean,sourceStart:number,sourceEnd:number}>} A captured clip with the original player timeline, before resetting output timestamps.
 */
export async function remuxCapturedVideo(
  streams,
  { requireAudio = false } = {}
) {
  const buffers = concatStreams(streams)
  const timings = streams.map(streamTiming)
  const inputs = buffers.map(
    (bytes) =>
      new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
  )
  try {
    const tracks = []
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]
      const found = await input.getTracks()
      const media = found.filter(
        (track) => track.type === 'video' || track.type === 'audio'
      )
      if (!media.length || media.length !== found.length)
        throw new Error('视频片段没有可用媒体轨道')
      tracks.push(...media.map((track) => ({ track, timing: timings[index] })))
    }
    const videos = tracks.filter((item) => item.track.type === 'video')
    const audios = tracks.filter((item) => item.track.type === 'audio')
    if (
      videos.length !== 1 ||
      audios.length > 1 ||
      (requireAudio && audios.length !== 1)
    )
      throw new Error('音视频轨道不完整或存在多个轨道，无法安全组装')
    const video = videos[0].track,
      audio = audios[0]?.track
    if (!video.codec || (audio && !audio.codec))
      throw new Error('暂不支持此音视频编码')
    const [capturedVideo, audioData, videoConfig, audioConfig] =
      await Promise.all([
        readPackets(video, videos[0].timing),
        audio ? readPackets(audio, audios[0].timing) : null,
        video.getDecoderConfig(),
        audio ? audio.getDecoderConfig() : null,
      ])
    if (
      !videoConfig ||
      (audio && !audioConfig) ||
      capturedVideo.packets[0].type !== 'key'
    )
      throw new Error('缺少初始化数据或关键帧，无法组装视频片段')
    const videoData = trimVideoToAudio(capturedVideo, audioData)
    // Retain only audio packets that overlap the video interval; otherwise an
    // earlier audio buffer can add a long lead-in before the first video frame.
    const alignedAudio = audioData && {
      ...audioData,
      packets: audioData.packets.filter(
        (packet) =>
          packet.timestamp + packet.duration > videoData.start &&
          packet.timestamp < videoData.end
      ),
    }
    if (alignedAudio && !alignedAudio.packets.length)
      throw new Error('音视频片段时间范围不一致，请重新采集')
    const start = alignedAudio
      ? alignedAudio.packets.reduce(
          (time, packet) => Math.min(time, packet.timestamp),
          videoData.start
        )
      : videoData.start
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    })
    const videoSource = new EncodedVideoPacketSource(video.codec)
    output.addVideoTrack(videoSource)
    const audioSource = audio && new EncodedAudioPacketSource(audio.codec)
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()
    const write = async (source, data, config, limit) => {
      let first = true
      for (const packet of data.packets) {
        if (packet.timestamp >= limit) continue
        await source.add(
          packet.clone({ timestamp: packet.timestamp - start }),
          first ? { decoderConfig: config } : undefined
        )
        first = false
      }
      source.close()
    }
    await Promise.all([
      write(videoSource, videoData, videoConfig, Infinity),
      audioSource
        ? write(audioSource, alignedAudio, audioConfig, videoData.end)
        : null,
    ])
    await output.finalize()
    if (!output.target.buffer || output.target.buffer.byteLength > MAX_BYTES)
      throw new Error('组装后的视频片段过大')
    return {
      blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
      duration: videoData.end - videoData.start,
      sourceStart: videoData.start,
      sourceEnd: videoData.end,
      hasAudio: !!audio,
    }
  } catch (error) {
    if (error instanceof Error && /[\u4e00-\u9fff]/.test(error.message))
      throw error
    throw new Error('视频片段格式不受支持或数据不完整')
  } finally {
    for (const input of inputs) input.dispose()
  }
}
