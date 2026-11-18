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
  // Some MSE players append a complete moov without a file-type box. This
  // generic brand wraps that unchanged movie metadata for the MP4 parser.
  const defaultFileType = Uint8Array.of(
    0,
    0,
    0,
    20,
    102,
    116,
    121,
    112,
    105,
    115,
    111,
    54,
    0,
    0,
    0,
    0,
    105,
    115,
    111,
    54
  )
  const streams = new WeakMap()
  const sourceByUrl = new Map()
  const unsupportedSources = new WeakSet()
  const trackedSources = new Set()
  let selected = null
  let provisional = null
  let initBytes = 0
  let pendingInitBytes = 0
  let pendingMediaBytes = 0
  let captureBytes = 0
  let captureParts = 0
  let frozenParts = null
  let failure = ''
  let stopped = false
  let hasMedia = false
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer
  const appendBuffer = SourceBuffer.prototype.appendBuffer
  const changeType = SourceBuffer.prototype.changeType
  const abort = SourceBuffer.prototype.abort

  function dataView(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return null
  }
  function isInit(type) {
    return type === 'ftyp' || type === 'moov'
  }
  function bufferedBytes() {
    return initBytes + pendingInitBytes + captureBytes + pendingMediaBytes
  }
  function freePendingData(box) {
    if (!box?.data) return
    if (isInit(box.type)) pendingInitBytes -= box.size
    else pendingMediaBytes -= box.size
    box.data = null
  }
  function resetAppendParser(track) {
    freePendingData(track.pendingBox)
    track.pendingBox = null
    track.headerLength = 0
  }
  function forgetInit(track, type) {
    const bytes = track.init.get(type)
    if (bytes) initBytes -= bytes.length
    track.init.delete(type)
  }
  function storeInit(track, type, bytes, ownsBytes) {
    const previous = track.init.get(type)
    if (frozenParts && selected?.source === track.source && type === 'ftyp')
      return
    if (previous && type === 'ftyp') return
    if (previous) {
      if (
        previous.length === bytes.length &&
        previous.every((byte, i) => byte === bytes[i])
      )
        return
      if (selected?.source === track.source) {
        track.staleInit = true
        if (!frozenParts) track.failure = 'format-change'
        return
      }
      if (provisional?.source === track.source) {
        const current = provisional
        clearProvisional()
        provisional = current
      }
      forgetInit(track, type)
    }
    if (
      bytes.length > MAX_INIT_BYTES ||
      initBytes + pendingInitBytes + bytes.length > MAX_INIT_TOTAL ||
      bufferedBytes() + bytes.length > MAX_CAPTURE_BYTES
    )
      return
    track.init.set(type, ownsBytes ? bytes : bytes.slice())
    initBytes += bytes.length
  }
  // An appendBuffer call is a byte stream chunk, not an MP4 box boundary.
  // Inspect complete boxes in order, even if their headers are split or the
  // native append finishes halfway through the next box.
  function appendBoxes(track, bytes, keepMedia, visit) {
    let offset = 0
    const header = track.header
    const view = new DataView(header.buffer)
    let boxes = 0
    while (offset < bytes.length) {
      const pending = track.pendingBox
      if (pending) {
        if (pending.data && !isInit(pending.type) && !keepMedia())
          freePendingData(pending)
        const count = Math.min(
          pending.size - pending.used,
          bytes.length - offset
        )
        pending.data?.set(bytes.subarray(offset, offset + count), pending.used)
        offset += count
        pending.used += count
        if (pending.used === pending.size) {
          const data = pending.data
          freePendingData(pending)
          track.pendingBox = null
          if (data) visit(pending.type, data, true)
        }
        continue
      }
      const start = track.headerLength ? -1 : offset
      while (offset < bytes.length) {
        header[track.headerLength++] = bytes[offset++]
        if (track.headerLength < 8) continue
        let size = view.getUint32(0)
        const length = size === 1 ? 16 : 8
        if (track.headerLength < length) continue
        if (length === 16) size = Number(view.getBigUint64(8))
        track.headerLength = 0
        if (!Number.isSafeInteger(size) || size < length || ++boxes > MAX_PARTS)
          return
        const type = String.fromCharCode(...header.subarray(4, 8))
        const init = isInit(type)
        const end = offset + size - length
        if (start >= 0 && end <= bytes.length) {
          if (init || keepMedia()) visit(type, bytes.subarray(start, end))
          offset = end
        } else {
          let data = null
          if (
            bufferedBytes() + size <= MAX_CAPTURE_BYTES &&
            (init
              ? size <= MAX_INIT_BYTES &&
                initBytes + pendingInitBytes + size <= MAX_INIT_TOTAL
              : keepMedia())
          ) {
            data = new Uint8Array(size)
            data.set(header.subarray(0, length))
            if (init) pendingInitBytes += size
            else pendingMediaBytes += size
          }
          if (size === length) {
            if (data) {
              freePendingData({ type, size, data })
              visit(type, data, true)
            }
          } else track.pendingBox = { type, size, used: length, data }
        }
        break
      }
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
        if (!isInit(track.pendingBox?.type)) freePendingData(track.pendingBox)
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
          header: new Uint8Array(16),
          headerLength: 0,
          pendingBox: null,
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
      if (!track) return result
      resetAppendParser(track)
      if (selected?.source === track.source) {
        track.failure = 'format-change'
        track.nextMime = arguments[0]
        track.staleInit = true
      } else {
        if (provisional?.source === track.source) clearProvisional()
        forgetInit(track, 'ftyp')
        forgetInit(track, 'moov')
        track.mime = arguments[0]
      }
      return result
    }
  }
  if (typeof abort === 'function') {
    SourceBuffer.prototype.abort = function () {
      const result = abort.apply(this, arguments)
      const track = !stopped && buffers.get(this)
      if (track) resetAppendParser(track)
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
      if (!bytes?.length || !/^(audio|video)\/mp4(?:\s*;|$)/i.test(track.mime))
        return result
      let current = null
      if (!selected) {
        try {
          current = updateProvisional(track.source)
        } catch {}
      }
      const capturing =
        !frozenParts &&
        (selected ? belongsToSelected(track) : current?.source === track.source)
      function clearCapture() {
        if (selected) {
          failure = '采集片段超过内存上限，请缩短播放时间后重试'
        } else {
          clearProvisional()
          provisional = current
        }
      }
      if (capturing && bytes.length > MAX_CAPTURE_BYTES) {
        clearCapture()
        resetAppendParser(track)
        return result
      }
      function keepMedia() {
        if (!capturing || failure || track.failure) return false
        if (!timing || (track.timing && !sameTiming(track.timing, timing))) {
          if (selected) {
            track.failure = 'timing'
            return false
          }
          clearProvisional()
          provisional = current
          if (!timing) return false
        }
        track.timing = timing
        return true
      }
      appendBoxes(track, bytes, keepMedia, (type, box, ownsBytes) => {
        if (isInit(type)) {
          storeInit(track, type, box, ownsBytes)
          return
        }
        if (
          bufferedBytes() + box.length > MAX_CAPTURE_BYTES ||
          captureParts >= MAX_PARTS - 4
        ) {
          clearCapture()
          if (
            selected ||
            !keepMedia() ||
            bufferedBytes() + box.length > MAX_CAPTURE_BYTES
          )
            return
        }
        track.chunks.push(ownsBytes ? box : box.slice())
        captureBytes += box.length
        captureParts++
      })
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
        !frozenParts &&
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
    if (tracks.some((track) => !track.init.has('moov') || track.staleInit))
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
    frozenParts = null
    if (!useProvisional)
      for (const track of tracks) {
        track.chunks.length = 0
        track.timing = null
        if (!isInit(track.pendingBox?.type)) freePendingData(track.pendingBox)
      }
    // Discard init data for all unrelated sources as soon as selection is made.
    if (!automatic)
      for (const other of trackedSources) {
        if (other === source) continue
        for (const track of streams.get(other) || []) {
          forgetInit(track, 'ftyp')
          forgetInit(track, 'moov')
        }
      }
    return { tracks: tracks.length }
  }
  function wholeFragments(chunks) {
    // appendBoxes already emits complete boxes. A capture can begin with
    // data from an earlier fragment or stop before the next data box arrives.
    const type = (bytes) => String.fromCharCode(...bytes.subarray(4, 8))
    let start = 0
    while (start < chunks.length && type(chunks[start]) === 'mdat') start++
    let pending = -1
    let complete = false
    for (let index = start; index < chunks.length; index++) {
      const box = chunks[index]
      const kind = type(box)
      if (kind === 'moof') {
        if (pending >= 0) return null
        pending = index
      } else if (kind === 'mdat') {
        if (pending < 0) return null
        const header =
          new DataView(box.buffer, box.byteOffset).getUint32(0) === 1 ? 16 : 8
        if (box.length <= header) return null
        pending = -1
        complete = true
      }
    }
    return complete
      ? chunks.slice(start, pending < 0 ? undefined : pending)
      : null
  }
  function snapshot() {
    if (!selected) throw new Error('请先选择要采集的视频')
    if (!belongsToSelected({ source: selected.source }) || failure)
      throw new Error(failure || '视频来源已变化')
    const tracks = streams.get(selected.source) || []
    checkTracks(selected.source, tracks)
    if (tracks.some((track) => !track.init.has('moov') || track.staleInit))
      throw new Error('缺少视频初始化数据，请重新启用采集并刷新页面')
    const media = tracks.map((track) => wholeFragments(track.chunks))
    if (media.some((chunks) => !chunks))
      throw new Error('尚未获取到足够片段，请继续播放或拖动进度条后重试')
    const parts = tracks.map((track, index) => [
      track.init.get('ftyp') || defaultFileType,
      track.init.get('moov'),
      ...media[index],
    ])
    const sizes = parts.map((chunks) => chunks.map((part) => part.byteLength))
    const size = sizes.reduce(
      (sum, lengths) =>
        sum + lengths.reduce((trackSize, length) => trackSize + length, 0),
      0
    )
    if (size > MAX_CAPTURE_BYTES)
      throw new Error('采集片段超过内存上限，请缩短播放时间后重试')
    frozenParts = parts
    return {
      tracks: tracks.map((track, index) => ({
        mime: track.mime,
        ...track.timing,
        parts: sizes[index],
      })),
      size,
    }
  }
  function read(trackIndex, partIndex, offset, length) {
    if (!frozenParts || !selected) throw new Error('请先准备采集片段')
    if (
      ![trackIndex, partIndex, offset, length].every(Number.isSafeInteger) ||
      trackIndex < 0 ||
      partIndex < 0 ||
      offset < 0 ||
      length < 1 ||
      length > MAX_READ_BYTES
    )
      throw new Error('片段读取参数无效')
    const part = frozenParts[trackIndex]?.[partIndex]
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
        if (!isInit(track.pendingBox?.type)) freePendingData(track.pendingBox)
        if (track.staleInit) {
          forgetInit(track, 'ftyp')
          forgetInit(track, 'moov')
          track.staleInit = false
        }
        if (track.nextMime !== undefined) {
          track.mime = track.nextMime
          track.nextMime = undefined
        }
      }
    selected = null
    provisional = null
    captureBytes = captureParts = 0
    failure = ''
    frozenParts = null
  }
  function stop() {
    stopped = true
    selected = null
    provisional = null
    for (const source of trackedSources) {
      for (const track of streams.get(source) || []) {
        track.chunks.length = 0
        track.init.clear()
        resetAppendParser(track)
      }
    }
    trackedSources.clear()
    sourceByUrl.clear()
    initBytes =
      pendingInitBytes =
      captureBytes =
      pendingMediaBytes =
      captureParts =
        0
    frozenParts = null
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
    if (SourceBuffer.prototype.abort === wrappedAbort && abort)
      SourceBuffer.prototype.abort = abort
    window.removeEventListener('message', handleMessage)
    window.removeEventListener('pagehide', stop)
    delete globalThis.__inkloomMseCapture
  }
  const wrappedCreate = URL.createObjectURL
  const wrappedRevoke = URL.revokeObjectURL
  const wrappedAdd = MediaSource.prototype.addSourceBuffer
  const wrappedAppend = SourceBuffer.prototype.appendBuffer
  const wrappedChange = SourceBuffer.prototype.changeType
  const wrappedAbort = SourceBuffer.prototype.abort
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
