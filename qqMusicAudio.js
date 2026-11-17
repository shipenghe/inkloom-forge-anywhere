// Observe audio responses that the QQ Music web player already fetched.
;(() => {
  if (
    location.hostname !== 'y.qq.com' ||
    !/^\/n\/ryqq(?:_v2)?\/player\/?$/.test(location.pathname)
  )
    return

  const maxBytes = 32 * 1024 * 1024
  const nativeFetch = window.fetch
  let capture

  function songInfo() {
    const footer = document.querySelector('.player__ft')
    const link = footer?.querySelector(
      '.player_music__info a[href*="/songDetail/"]'
    )
    return link ? { footer, song: link.pathname } : null
  }

  function clear() {
    capture?.observer.disconnect()
    if (capture) discardAudio(capture)
    capture = null
  }

  function discardAudio(track) {
    track.audio?.remove()
    if (track.blobUrl) URL.revokeObjectURL(track.blobUrl)
    track.audio = null
    track.blobUrl = null
  }

  function streamUrl(input) {
    try {
      const value = input instanceof Request ? input.url : input
      if (typeof value !== 'string' && !(value instanceof URL)) return null
      const url = new URL(value, location.href)
      return url.protocol === 'https:' &&
        /(?:^|\.)stream\.qqmusic\.qq\.com$/.test(url.hostname)
        ? url
        : null
    } catch {
      return null
    }
  }

  function range(response) {
    const length = Number(response.headers.get('Content-Length'))
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes)
      return null
    if (response.status === 200) return { start: 0, end: length, total: length }
    const value = response.headers
      .get('Content-Range')
      ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
    if (response.status !== 206 || !value) return null
    const [start, last, total] = value.slice(1).map(Number)
    if (total > maxBytes || last >= total || last - start + 1 !== length)
      return null
    return { start, end: last + 1, total }
  }

  function listedDuration(footer) {
    const time = footer.querySelector('.player_music__time')?.textContent
    return time
      ?.match(/\/\s*(\d+(?::\d{2}){1,2})\s*$/)?.[1]
      .split(':')
      .reduce((seconds, field) => 60 * seconds + Number(field), 0)
  }

  function expose(track) {
    const sorted = [...track.parts.values()].sort((a, b) => a.start - b.start)
    let offset = 0
    for (const part of sorted) {
      if (part.start !== offset || !part.blob) return
      offset = part.end
    }
    if (offset !== track.total) return

    const audio = document.createElement('audio')
    track.audio = audio
    track.blobUrl = URL.createObjectURL(
      new Blob(
        sorted.map((part) => part.blob),
        {
          type: track.mime,
        }
      )
    )
    track.parts.clear()
    audio.setAttribute('data-forge-qq-audio', '')
    audio.hidden = true
    const trial = track.footer
      .querySelector('.player_music__try')
      ?.textContent.includes('试听')
    audio.preload = trial ? 'metadata' : 'none'
    if (trial) {
      audio.addEventListener(
        'loadedmetadata',
        () => {
          if (capture !== track || songInfo()?.song !== track.song) return
          const duration = listedDuration(track.footer)
          // A trial may only expose a short file, never the underlying full track.
          if (
            !Number.isFinite(duration) ||
            !Number.isFinite(audio.duration) ||
            audio.duration > 61 ||
            audio.duration >= duration - 1
          ) {
            clear()
            return
          }
          audio.setAttribute('data-forge-qq-trial', '')
          audio.setAttribute('data-forge-qq-song', track.song)
        },
        { once: true }
      )
      audio.addEventListener(
        'error',
        () => {
          if (capture === track) clear()
        },
        { once: true }
      )
    } else {
      // The common importer inspects the bytes even when Chrome cannot preview them.
      const duration = listedDuration(track.footer)
      if (Number.isFinite(duration) && duration > 0)
        audio.setAttribute('data-forge-qq-duration', String(duration))
      audio.setAttribute('data-forge-qq-song', track.song)
    }
    audio.src = track.blobUrl
    document.body.append(audio)
  }

  async function observe(info, url, response) {
    if (response.url !== url.href) return
    const mime = globalThis.ForgeAudioFormats.responseMime(
      response.headers.get('Content-Type'),
      url.pathname
    )
    if (!mime) return
    const part = range(response)
    const current = songInfo()
    if (!part || current?.song !== info.song || current.footer !== info.footer)
      return
    const track = fileCapture(info, url.href, mime)
    if (track.blocked || track.audio) return
    if (track.total && track.total !== part.total) return
    if (
      track.parts.size >= 128 ||
      [...track.parts.values()].some(
        (other) => part.start < other.end && other.start < part.end
      )
    )
      return
    track.total = part.total
    track.parts.set(part.start, part)
    try {
      const blob = await response.clone().blob()
      if (capture !== track || track.blocked || songInfo()?.song !== track.song)
        return
      if (blob.size !== part.end - part.start) {
        track.parts.delete(part.start)
        return
      }
      part.blob = blob
      expose(track)
    } catch {
      track.parts.delete(part.start)
    }
  }

  function fileCapture(info, url, mime) {
    if (
      capture &&
      (capture.song !== info.song || capture.footer !== info.footer)
    )
      clear()
    if (!capture) {
      const observer = new MutationObserver(() => {
        if (capture?.song !== songInfo()?.song) clear()
      })
      observer.observe(info.footer, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['href'],
      })
      capture = { ...info, url, mime, observer, parts: new Map() }
    }
    const track = capture
    if (!track.blocked && (track.url !== url || track.mime !== mime)) {
      // Two different streams for the same visible song leave the source ambiguous.
      track.blocked = true
      track.parts.clear()
      discardAudio(track)
    }
    return track
  }

  window.fetch = function (input, ...args) {
    const result = Reflect.apply(nativeFetch, this, [input, ...args])
    const url = streamUrl(input)
    const info = url && songInfo()
    if (info)
      void result
        .then((response) => observe(info, url, response))
        .catch(() => {})
    return result
  }
  window.addEventListener('pagehide', clear)
})()
