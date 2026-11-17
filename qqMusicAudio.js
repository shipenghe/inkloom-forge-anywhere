// Observe MP3 and M4A responses that the QQ Music web player already fetched.
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

  function streamSource(input) {
    try {
      const value = input instanceof Request ? input.url : input
      if (typeof value !== 'string' && !(value instanceof URL)) return null
      const url = new URL(value, location.href)
      const extension = url.pathname.match(/\.(mp3|m4a)$/i)?.[1].toLowerCase()
      return url.protocol === 'https:' &&
        /(?:^|\.)stream\.qqmusic\.qq\.com$/.test(url.hostname) &&
        extension
        ? {
            url: url.href,
            mime: extension === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
          }
        : null
    } catch {
      return null
    }
  }

  function range(response, expectedMime) {
    const mime = response.headers
      .get('Content-Type')
      ?.split(';')[0]
      .toLowerCase()
      .trim()
    if (
      mime !== expectedMime &&
      !(mime === 'audio/mp3' && expectedMime === 'audio/mpeg')
    )
      return null
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
    audio.preload = 'metadata'
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (capture !== track || songInfo()?.song !== track.song) return
        const notice = track.footer.querySelector('.player_music__try')
        if (notice?.textContent.includes('试听')) {
          const time = track.footer.querySelector(
            '.player_music__time'
          )?.textContent
          const duration = time
            ?.match(/\/\s*(\d+(?::\d{2}){1,2})\s*$/)?.[1]
            .split(':')
            .reduce((seconds, field) => 60 * seconds + Number(field), 0)
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
        }
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
    audio.src = track.blobUrl
    document.body.append(audio)
  }

  async function observe(track, response) {
    if (capture !== track || track.audio || track.blocked) return
    const part = range(response, track.mime)
    if (!part || response.url !== track.url) return
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

  window.fetch = function (input, ...args) {
    const result = Reflect.apply(nativeFetch, this, [input, ...args])
    const source = streamSource(input)
    if (!source) return result
    const info = songInfo()
    if (!info) return result
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
      capture = { ...info, ...source, observer, parts: new Map() }
    }
    const track = capture
    if (track.url === source.url) {
      void result.then(
        (response) => observe(track, response),
        () => {}
      )
    } else if (!track.blocked) {
      // Two different streams for the same visible song leave the source ambiguous.
      track.blocked = true
      track.parts.clear()
      discardAudio(track)
    }
    return result
  }
  window.addEventListener('pagehide', clear)
})()
