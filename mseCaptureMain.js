// Installed in MAIN world only on sites the user has authorized for capture.
// Page messages and bytes remain untrusted; the extension validates its own state.
;(() => {
  if (globalThis.__inkloomMseCapture) return
  const automatic = globalThis.__inkloomMseAutoStart === true
  delete globalThis.__inkloomMseAutoStart
  let marker
  if (automatic) {
    try {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      marker = {
        nonce: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
          ''
        ),
      }
    } catch {
      return
    }
  } else {
    try {
      const raw = sessionStorage.getItem('__inkloom_mse_prepare_v1')
      sessionStorage.removeItem('__inkloom_mse_prepare_v1')
      marker = JSON.parse(raw || 'null')
    } catch {
      return
    }
    const nav = performance.getEntriesByType('navigation')[0]
    if (
      nav?.type !== 'reload' ||
      !marker ||
      typeof marker.nonce !== 'string' ||
      !/^[a-zA-Z0-9-]{16,128}$/.test(marker.nonce) ||
      !Number.isSafeInteger(marker.expiresAt) ||
      marker.expiresAt < Date.now() ||
      marker.expiresAt > Date.now() + 120000
    )
      return
  }
  if (typeof MediaSource !== 'function' || typeof SourceBuffer !== 'function')
    return
  const MAX_INIT_BYTES = 4 * 1024 * 1024
  const MAX_INIT_TOTAL = 8 * 1024 * 1024
  const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
  const MAX_READ_BYTES = 192 * 1024
  const MAX_PARTS = 4096
  const MAX_SOURCES = 16
  const MAX_SOURCE_URLS = 64
  const streams = new WeakMap()
  const sourceByUrl = new Map()
  const unsupportedSources = new WeakSet()
  const trackedSources = new Set()
  let selected = null
  let provisional = null
  let initBytes = 0
  let captureBytes = 0
  let captureParts = 0
  let frozen = false
  let failure = ''
  let stopped = false
  let hasMedia = false
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer
  const appendBuffer = SourceBuffer.prototype.appendBuffer
  const changeType = SourceBuffer.prototype.changeType

  function dataView(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return null
  }
  // Initialization is tracked separately so tentative media can be discarded
  // without losing the data needed to identify and decode a selected source.
  function boxes(bytes) {
    const result = []
    let offset = 0
    while (offset + 8 <= bytes.length) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        bytes.length - offset
      )
      let size = view.getUint32(0)
      let header = 8
      const type = String.fromCharCode(
        ...bytes.subarray(offset + 4, offset + 8)
      )
      if (size === 1) {
        if (offset + 16 > bytes.length) return null
        size = view.getUint32(8) * 0x100000000 + view.getUint32(12)
        header = 16
      }
      if (
        !size ||
        !Number.isSafeInteger(size) ||
        size < header ||
        offset + size > bytes.length
      )
        return null
      if (result.length >= MAX_PARTS) return null
      result.push({ type, start: offset, end: offset + size })
      offset += size
    }
    return offset === bytes.length ? result : null
  }
  function storeInit(track, bytes, parsed) {
    if (!parsed) return
    for (const box of parsed) {
      if (!['ftyp', 'moov'].includes(box.type)) continue
      const size = box.end - box.start
      if (
        track.init.has(box.type) ||
        size > MAX_INIT_BYTES ||
        initBytes + size > MAX_INIT_TOTAL ||
        initBytes + captureBytes + size > MAX_CAPTURE_BYTES
      )
        continue
      track.init.set(box.type, bytes.slice(box.start, box.end))
      initBytes += size
    }
  }
  function belongsToSelected(track) {
    if (!selected || selected.source !== track.source) return false
    if (selected.video.isConnected === false) {
      failure = '视频来源已变化，请重新启用采集'
      return false
    }
    const url = selected.video.currentSrc || selected.video.src
    if (url !== selected.url) {
      failure = '视频来源已变化，请重新启用采集'
      return false
    }
    return true
  }
  function visibleVideo(video) {
    if (!video.isConnected || typeof video.getBoundingClientRect !== 'function')
      return false
    const rect = video.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return false
    if (
      Number.isFinite(window.innerWidth) &&
      Number.isFinite(window.innerHeight) &&
      (rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= window.innerWidth ||
        rect.top >= window.innerHeight)
    )
      return false
    if (typeof window.getComputedStyle !== 'function') return false
    for (
      let node = video;
      node && node.nodeType === 1;
      node = node.parentElement
    ) {
      const style = window.getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      )
        return false
    }
    return true
  }
  function soleVisiblePlayer() {
    const videos = [...document.querySelectorAll('video')].filter(visibleVideo)
    if (videos.length !== 1) return null
    const video = videos[0]
    const url = video.currentSrc || video.src
    const source = sourceByUrl.get(url)
    return source && streams.has(source) ? { video, url, source } : null
  }
  function clearProvisional() {
    if (provisional) {
      for (const track of streams.get(provisional.source) || []) {
        track.chunks.length = 0
        track.timing = null
        track.failure = null
      }
    }
    provisional = null
    captureBytes = 0
    captureParts = 0
  }
  function updateProvisional(appendingSource = null) {
    let candidate = soleVisiblePlayer()
    // Some players append their first segments before attaching the source to
    // a video element. Keep only one unambiguous source provisionally, then
    // verify the real element and URL before any of its bytes can be sent.
    if (
      automatic &&
      !candidate &&
      appendingSource &&
      trackedSources.size === 1 &&
      [...document.querySelectorAll('video')].filter(visibleVideo).length === 0
    )
      candidate = { video: null, url: null, source: appendingSource }
    if (
      provisional?.video === null &&
      candidate?.video &&
      candidate.source === provisional.source
    )
      provisional = candidate
    if (
      provisional &&
      (!candidate ||
        candidate.video !== provisional.video ||
        candidate.url !== provisional.url ||
        candidate.source !== provisional.source)
    )
      clearProvisional()
    if (!provisional && candidate) provisional = candidate
    return provisional
  }
  function captureTiming(buffer) {
    const { mode, timestampOffset, appendWindowStart, appendWindowEnd } = buffer
    if (
      mode !== 'segments' ||
      !Number.isFinite(timestampOffset) ||
      !Number.isFinite(appendWindowStart) ||
      appendWindowStart < 0 ||
      !(Number.isFinite(appendWindowEnd) || appendWindowEnd === Infinity) ||
      appendWindowEnd <= appendWindowStart
    )
      return null
    return {
      timestampOffset,
      appendWindowStart,
      appendWindowEnd: appendWindowEnd === Infinity ? null : appendWindowEnd,
    }
  }
  function sameTiming(a, b) {
    return (
      a.timestampOffset === b.timestampOffset &&
      a.appendWindowStart === b.appendWindowStart &&
      a.appendWindowEnd === b.appendWindowEnd
    )
  }
  function checkTracks(source, tracks) {
    if (unsupportedSources.has(source) || tracks.length > 2)
      throw new Error('视频媒体轨道数量过多，暂不支持采集')
    if (tracks.some((track) => track.failure === 'format-change'))
      throw new Error('采集期间视频格式发生切换，请重新采集')
    if (tracks.some((track) => track.failure === 'timing'))
      throw new Error('采集期间视频播放时间配置发生变化，暂不支持采集')
    if (
      tracks.some((track) => !/^(audio|video)\/mp4(?:\s*;|$)/i.test(track.mime))
    )
      throw new Error('视频使用了暂不支持的媒体格式')
    if (!selected && tracks.some((track) => !captureTiming(track.buffer)))
      throw new Error('视频使用了暂不支持的播放时间配置')
  }
  URL.createObjectURL = function (object) {
    const url = createObjectURL.apply(this, arguments)
    if (
      !stopped &&
      object instanceof MediaSource &&
      (trackedSources.has(object) || trackedSources.size < MAX_SOURCES)
    ) {
      if (!streams.has(object)) {
        streams.set(object, [])
        trackedSources.add(object)
      }
      if (sourceByUrl.size < MAX_SOURCE_URLS) sourceByUrl.set(url, object)
    }
    return url
  }
  URL.revokeObjectURL = function (url) {
    // A video already attached to the URL keeps using its MediaSource after
    // revocation. Retain a bounded association until capture stops.
    return revokeObjectURL.apply(this, arguments)
  }
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const result = addSourceBuffer.apply(this, arguments)
    if (!stopped && typeof mime === 'string') {
      if (!streams.has(this) && trackedSources.size < MAX_SOURCES) {
        streams.set(this, [])
        trackedSources.add(this)
      }
      const tracks = streams.get(this)
      if (tracks && tracks.length < 4) {
        const track = {
          source: this,
          buffer: result,
          mime,
          init: new Map(),
          chunks: [],
          failure: null,
          timing: null,
        }
        tracks.push(track)
        buffers.set(result, track)
        if (automatic && !hasMedia) {
          hasMedia = true
          try {
            window.postMessage({ __inkloomMse: 'available' }, '*')
          } catch {}
        }
      } else if (tracks) unsupportedSources.add(this)
    }
    return result
  }
  const buffers = new WeakMap()
  if (typeof changeType === 'function') {
    SourceBuffer.prototype.changeType = function () {
      const result = changeType.apply(this, arguments)
      const track = !stopped && buffers.get(this)
      if (track && belongsToSelected(track)) {
        track.failure = 'format-change'
      } else if (track && !selected) {
        if (provisional?.source === track.source) clearProvisional()
        for (const bytes of track.init.values()) initBytes -= bytes.length
        track.init.clear()
        track.mime = arguments[0]
      }
      return result
    }
  }
  SourceBuffer.prototype.appendBuffer = function (data) {
    const track = !stopped && buffers.get(this)
    // Inspect settings before the append: the native call may synchronously
    // change timestampOffset, especially for sequence-mode segments.
    let timing
    try {
      timing = track && captureTiming(this)
    } catch {}
    const result = appendBuffer.apply(this, arguments)
    try {
      const bytes = track && dataView(data)
      if (!bytes || !bytes.length || frozen) return result
      const parsed = boxes(bytes)
      if (!selected || selected.source === track.source)
        storeInit(track, bytes, parsed)
      const current = selected ? null : updateProvisional(track.source)
      if (
        (selected
          ? !belongsToSelected(track)
          : !current || current.source !== track.source) ||
        failure
      )
        return result
      // Keep the raw appended data (excluding initialization boxes) only for the
      // selected source. An unsupported split/format fails later during remux.
      const mediaBoxes = parsed?.filter(
        (box) => box.type !== 'ftyp' && box.type !== 'moov'
      )
      const size = mediaBoxes
        ? mediaBoxes.reduce((sum, box) => sum + box.end - box.start, 0)
        : bytes.byteLength
      if (
        initBytes + captureBytes + size > MAX_CAPTURE_BYTES ||
        captureParts + (mediaBoxes?.length ?? 1) > MAX_PARTS
      ) {
        if (selected) {
          failure = '采集片段超过内存上限，请缩短播放时间后重试'
          return result
        }
        clearProvisional()
        provisional = current
        if (
          initBytes + size > MAX_CAPTURE_BYTES ||
          (mediaBoxes?.length ?? 1) > MAX_PARTS
        )
          return result
      }
      if (size) {
        if (!timing || (track.timing && !sameTiming(track.timing, timing))) {
          if (selected) {
            track.failure = 'timing'
            return result
          }
          clearProvisional()
          provisional = current
          if (!timing) return result
        }
        track.timing = timing
      }
      const chunks = mediaBoxes
        ? mediaBoxes.map((box) => bytes.slice(box.start, box.end))
        : [bytes.slice()]
      track.chunks.push(...chunks)
      captureBytes += size
      captureParts += chunks.length
      return result
    } catch {
      // Collection is best effort and must never disrupt the player.
      return result
    }
  }
  function select(url) {
    if (typeof url !== 'string' || !url.startsWith('blob:'))
      throw new Error('该视频不是受支持的分段视频')
    const videos = [...document.querySelectorAll('video')].filter(
      (video) => (video.currentSrc || video.src) === url
    )
    if (videos.length !== 1) throw new Error('无法唯一确定视频，请重新选择')
    if (selected) {
      if (
        !frozen &&
        !failure &&
        selected.url === url &&
        selected.video === videos[0] &&
        sourceByUrl.get(url) === selected.source
      ) {
        const tracks = streams.get(selected.source) || []
        checkTracks(selected.source, tracks)
        return { tracks: tracks.length }
      }
      throw new Error('已有正在采集的视频，请先停止')
    }
    const source = sourceByUrl.get(url)
    if (!source)
      throw new Error('无法关联该视频的播放器，可能使用不支持的播放方式')
    const tracks = streams.get(source)
    if (!tracks?.length)
      throw new Error('播放器尚未加载媒体轨道，请先播放视频后重试')
    checkTracks(source, tracks)
    if (
      tracks.some((track) => !track.init.has('ftyp') || !track.init.has('moov'))
    )
      throw new Error('缺少视频初始化数据，请重新启用采集并刷新页面')
    const candidate = updateProvisional()
    const useProvisional =
      candidate?.source === source &&
      candidate.video === videos[0] &&
      candidate.url === url
    if (!useProvisional) clearProvisional()
    selected = { source, video: videos[0], url }
    provisional = null
    failure = ''
    if (!useProvisional) {
      captureBytes = 0
      captureParts = 0
    }
    frozen = false
    if (!useProvisional)
      for (const track of tracks) {
        track.chunks.length = 0
        track.timing = null
      }
    // Discard init data for all unrelated sources as soon as selection is made.
    if (!automatic)
      for (const other of trackedSources) {
        if (other === source) continue
        for (const track of streams.get(other) || []) {
          for (const bytes of track.init.values()) initBytes -= bytes.length
          track.init.clear()
        }
      }
    return { tracks: tracks.length }
  }
  // Do not freeze on a lone box or a truncated append. Players may split a box
  // across several appendBuffer calls; read headers without concatenating 64 MiB.
  function hasCompleteFragment(track) {
    const chunks = track.chunks
    const ends = []
    let total = 0
    for (const chunk of chunks) {
      total += chunk.length
      ends.push(total)
    }
    function byteAt(position) {
      let low = 0
      let high = ends.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (ends[middle] <= position) low = middle + 1
        else high = middle
      }
      if (low >= chunks.length) return 0
      return chunks[low][position - (low ? ends[low - 1] : 0)]
    }
    function uint32(position) {
      return (
        byteAt(position) * 0x1000000 +
        byteAt(position + 1) * 0x10000 +
        byteAt(position + 2) * 0x100 +
        byteAt(position + 3)
      )
    }
    let offset = 0
    let pending = false
    let complete = false
    let boxCount = 0
    while (offset < total) {
      if (total - offset < 8 || ++boxCount > MAX_PARTS) return false
      let size = uint32(offset)
      const type = String.fromCharCode(
        byteAt(offset + 4),
        byteAt(offset + 5),
        byteAt(offset + 6),
        byteAt(offset + 7)
      )
      let header = 8
      if (size === 1) {
        if (total - offset < 16) return false
        size = uint32(offset + 8) * 0x100000000 + uint32(offset + 12)
        header = 16
      }
      if (!Number.isSafeInteger(size) || size < header || offset + size > total)
        return false
      if (type === 'moof') {
        if (pending) return false
        pending = true
      } else if (type === 'mdat' && pending) {
        if (size === header) return false
        pending = false
        complete = true
      }
      offset += size
    }
    return complete && !pending
  }
  function snapshot() {
    if (!selected) throw new Error('请先选择要采集的视频')
    if (!belongsToSelected({ source: selected.source }) || failure)
      throw new Error(failure || '视频来源已变化')
    const tracks = streams.get(selected.source) || []
    checkTracks(selected.source, tracks)
    if (
      tracks.some((track) => !track.init.has('ftyp') || !track.init.has('moov'))
    )
      throw new Error('缺少视频初始化数据，请重新启用采集并刷新页面')
    if (tracks.some((track) => !hasCompleteFragment(track)))
      throw new Error('尚未获取到足够片段，请继续播放或拖动进度条后重试')
    frozen = true
    return {
      tracks: tracks.map((track) => ({
        mime: track.mime,
        ...track.timing,
        parts: [
          track.init.get('ftyp'),
          track.init.get('moov'),
          ...track.chunks,
        ].map((part) => part.byteLength),
      })),
      size:
        captureBytes +
        tracks.reduce(
          (sum, track) =>
            sum + track.init.get('ftyp').length + track.init.get('moov').length,
          0
        ),
    }
  }
  function read(trackIndex, partIndex, offset, length) {
    if (!frozen || !selected) throw new Error('请先准备采集片段')
    if (
      ![trackIndex, partIndex, offset, length].every(Number.isSafeInteger) ||
      trackIndex < 0 ||
      partIndex < 0 ||
      offset < 0 ||
      length < 1 ||
      length > MAX_READ_BYTES
    )
      throw new Error('片段读取参数无效')
    const track = (streams.get(selected.source) || [])[trackIndex]
    const parts = track && [
      track.init.get('ftyp'),
      track.init.get('moov'),
      ...track.chunks,
    ]
    const part = parts?.[partIndex]
    if (!part || offset >= part.byteLength) throw new Error('片段读取位置无效')
    return part.slice(offset, Math.min(offset + length, part.byteLength))
  }
  function release() {
    // Clear every provisional/selected media buffer while keeping bounded
    // initialization data for subsequent videos in this document.
    for (const source of trackedSources)
      for (const track of streams.get(source) || []) {
        track.chunks.length = 0
        track.timing = null
        track.failure = null
      }
    selected = null
    provisional = null
    captureBytes = captureParts = 0
    failure = ''
    frozen = false
  }
  function stop() {
    stopped = true
    selected = null
    provisional = null
    for (const source of trackedSources) {
      for (const track of streams.get(source) || []) {
        track.chunks.length = 0
        track.init.clear()
      }
    }
    trackedSources.clear()
    sourceByUrl.clear()
    initBytes = captureBytes = captureParts = 0
    frozen = false
    failure = ''
    // Preserve wrappers installed by a page after ours.
    if (URL.createObjectURL === wrappedCreate)
      URL.createObjectURL = createObjectURL
    if (URL.revokeObjectURL === wrappedRevoke)
      URL.revokeObjectURL = revokeObjectURL
    if (MediaSource.prototype.addSourceBuffer === wrappedAdd)
      MediaSource.prototype.addSourceBuffer = addSourceBuffer
    if (SourceBuffer.prototype.appendBuffer === wrappedAppend)
      SourceBuffer.prototype.appendBuffer = appendBuffer
    if (SourceBuffer.prototype.changeType === wrappedChange)
      SourceBuffer.prototype.changeType = changeType
    window.removeEventListener('message', handleMessage)
    window.removeEventListener('pagehide', stop)
    delete globalThis.__inkloomMseCapture
  }
  const wrappedCreate = URL.createObjectURL
  const wrappedRevoke = URL.revokeObjectURL
  const wrappedAdd = MediaSource.prototype.addSourceBuffer
  const wrappedAppend = SourceBuffer.prototype.appendBuffer
  const wrappedChange = SourceBuffer.prototype.changeType
  function handleMessage(event) {
    if (event.source !== window || event.data?.__inkloomMse !== 'request')
      return
    const { id, kind, url, track, part, offset, length } = event.data
    if (typeof id !== 'string' || id.length > 128) return
    try {
      const value =
        kind === 'STATUS'
          ? {
              nonce: marker.nonce,
              ...(automatic ? { auto: true, hasMedia } : {}),
            }
          : kind === 'SELECT'
          ? select(url)
          : kind === 'SNAPSHOT'
          ? snapshot()
          : kind === 'READ'
          ? read(track, part, offset, length)
          : kind === 'RELEASE'
          ? release()
          : kind === 'STOP'
          ? stop()
          : null
      if (
        !['STATUS', 'SELECT', 'SNAPSHOT', 'READ', 'RELEASE', 'STOP'].includes(
          kind
        )
      )
        return
      window.postMessage({ __inkloomMse: 'response', id, ok: true, value }, '*')
    } catch (error) {
      window.postMessage(
        {
          __inkloomMse: 'response',
          id,
          ok: false,
          error: error?.message || '视频采集失败',
        },
        '*'
      )
    }
  }
  window.addEventListener('message', handleMessage)
  window.addEventListener('pagehide', stop, { once: true })
  globalThis.__inkloomMseCapture = { select, snapshot, read, release, stop }
})()
