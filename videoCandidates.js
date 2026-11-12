// Only inspect sources explicitly attached to the video the user selected.
;(() => {
  function videoCandidates(video) {
    const result = []
    const seen = new Set([video.currentSrc || video.src])
    const add = (raw, declaredType) => {
      if (!raw || typeof raw !== 'string') return
      let url
      try {
        url = new URL(raw, video.ownerDocument.baseURI)
      } catch {
        return
      }
      if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href))
        return
      const type = (declaredType || '').split(';')[0].trim().toLowerCase()
      const supported = ['video/mp4', 'video/webm', 'video/quicktime']
      if (type && !supported.includes(type)) return
      if (!type && !/\.(mp4|webm|mov)$/i.test(url.pathname)) return
      if (/\.(m4s|m3u8|mpd|ts)$/i.test(url.pathname)) return
      seen.add(url.href)
      result.push(url.href)
    }
    add(video.getAttribute('src'), '')
    for (const source of video.querySelectorAll('source[src]')) {
      if (source.getAttribute('media')) {
        try {
          if (!window.matchMedia(source.getAttribute('media')).matches) continue
        } catch {
          continue
        }
      }
      add(source.getAttribute('src'), source.getAttribute('type'))
      if (result.length >= 5) break
    }
    return result
  }
  globalThis.__inkloomVideoCandidates = { videoCandidates }
})()
