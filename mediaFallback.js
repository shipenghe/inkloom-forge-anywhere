// Resolve media that a page exposes through an alternate element or control.
;(() => {
  const space = /[\t\n\f\r ]/
  const safeUrl = (value, base) => {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const url = new URL(value, base)
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null
    } catch {
      return null
    }
  }

  // Follow srcset's URL/descriptor separation; ambiguous descriptors are ignored.
  function candidates(value, base) {
    const result = []
    let position = 0
    while (position < value.length) {
      while (
        position < value.length &&
        (space.test(value[position]) || value[position] === ',')
      )
        position++
      let raw = ''
      while (position < value.length && !space.test(value[position]))
        raw += value[position++]
      if (!raw) break
      const trailingComma = raw.endsWith(',')
      raw = raw.replace(/,+$/, '')
      let descriptor = ''
      if (!trailingComma) {
        while (position < value.length && value[position] !== ',')
          descriptor += value[position++]
        if (value[position] === ',') position++
      }
      const url = safeUrl(raw, base)
      descriptor = descriptor.trim()
      const width = descriptor.match(/^([1-9]\d*)w$/)
      const density = descriptor.match(/^(\d+(?:\.\d+)?)x$/)
      if (!url || (descriptor && !width && !density)) continue
      const amount = width ? Number(width[1]) : density ? Number(density[1]) : 1
      if (!Number.isFinite(amount) || amount <= 0) continue
      result.push({ url, amount, kind: width ? 'w' : 'x' })
    }
    return result
  }

  function matchesMedia(source) {
    const media = (source.getAttribute('media') || '').trim()
    if (!media) return true
    try {
      return window.matchMedia(media).matches
    } catch {
      return false
    }
  }

  function selectCandidate(items, image) {
    if (!items.length || items.some((item) => item.kind !== items[0].kind))
      return null
    const pixelRatio = Number(window.devicePixelRatio) || 1
    const desired =
      items[0].kind === 'w'
        ? Math.max(
            1,
            image.getBoundingClientRect().width || image.clientWidth || 1
          ) * pixelRatio
        : pixelRatio
    const ordered = [...items].sort((a, b) => a.amount - b.amount)
    return (
      ordered.find((item) => item.amount >= desired) ||
      ordered[ordered.length - 1]
    ).url
  }

  function imageUrl(image) {
    const current = image.currentSrc || image.src
    const picture = image.parentElement
    if (!current || !picture || picture.tagName.toLowerCase() !== 'picture')
      return current
    const base = image.ownerDocument.baseURI
    const currentUrl = safeUrl(current, base)
    if (!currentUrl) return current
    const sources = Array.from(picture.children).filter(
      (child) =>
        child.tagName.toLowerCase() === 'source' &&
        child.hasAttribute('srcset') &&
        matchesMedia(child)
    )
    const selectedSource = sources.find((source) =>
      candidates(source.getAttribute('srcset') || '', base).some(
        (item) => item.url === currentUrl
      )
    )
    const selectedType = (selectedSource?.getAttribute('type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const path = new URL(currentUrl).pathname
    if (selectedType !== 'image/avif' && !/\.avif$/i.test(path)) return current

    // Only alternatives for the same media condition avoid mixing art-directed crops.
    const selectedMedia = (selectedSource?.getAttribute('media') || '').trim()
    if (selectedSource) {
      for (const source of sources) {
        const type = (source.getAttribute('type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase()
        const media = (source.getAttribute('media') || '').trim()
        if (type !== 'image/webp' || media !== selectedMedia) continue
        const selected = selectCandidate(
          candidates(source.getAttribute('srcset') || '', base),
          image
        )
        if (selected) return selected
      }
    }
    // The img src is the picture's universal fallback only for an unconditional source.
    const fallback = safeUrl(image.getAttribute('src') || '', base)
    if (
      !selectedMedia &&
      fallback &&
      /\.(?:jpe?g|png|webp)$/i.test(new URL(fallback).pathname)
    )
      return fallback
    return current
  }

  function qqMusicAudio(origin) {
    if (
      location.hostname !== 'y.qq.com' ||
      !/^\/n\/ryqq(?:_v2)?\/player\/?$/.test(location.pathname)
    )
      return null
    const control = origin?.closest?.(
      '.player_music, .btn_big_play, .player_progress:not(.player_voice)'
    )
    const anchor = control?.closest('.player__ft')
    if (!anchor?.isConnected) return null

    // QQ Music appends its zero-size audio element directly to the body.
    const tracks = [
      ...document.querySelectorAll('body > audio:not([data-forge-qq-audio])'),
    ].filter((audio) => audio.readyState >= 1 && !audio.error && !audio.ended)
    const playing = tracks.filter((audio) => !audio.paused)
    const candidates = playing.length ? playing : tracks
    if (candidates.length > 1) return null
    let [element] = candidates
    if (!element) {
      const song = anchor.querySelector?.(
        '.player_music__info a[href*="/songDetail/"]'
      )?.pathname
      if (!song) return null
      element = document.querySelector('audio[data-forge-qq-song]')
      if (
        element?.getAttribute('data-forge-qq-song') !== song ||
        !element.src.startsWith('blob:')
      )
        return null
      const trial = anchor
        .querySelector('.player_music__try')
        ?.textContent.includes('试听')
      if (trial && !element.hasAttribute('data-forge-qq-trial')) return null
    }
    if (
      !element ||
      element.mediaKeys ||
      !/^(https?:|blob:)/i.test(element.currentSrc || element.src)
    )
      return null
    return { element, anchor, control }
  }

  function hiddenAudio(element) {
    if (
      element?.tagName !== 'AUDIO' ||
      !element.isConnected ||
      element.readyState < 1 ||
      element.error ||
      element.mediaKeys ||
      element.srcObject ||
      !/^(https?:|blob:)/i.test(element.currentSrc)
    )
      return false
    const { width, height } = element.getBoundingClientRect()
    return width === 0 || height === 0
  }

  function audioPlayer(origin) {
    // Custom controls may share their compact container with a hidden native
    // player. Only use a direct child audio element in that container.
    for (
      let anchor = origin, depth = 0;
      anchor &&
      anchor !== document.body &&
      anchor !== document.documentElement &&
      depth < 8;
      anchor = anchor.parentElement, depth++
    ) {
      const tracks = [...anchor.children].filter(
        (node) => node.tagName === 'AUDIO'
      )
      if (!tracks.length) continue
      const { width, height } = anchor.getBoundingClientRect()
      if (width < 80 || height < 18 || height > Math.min(innerHeight / 3, 240))
        continue
      const [element] = tracks
      return tracks.length === 1 && hiddenAudio(element)
        ? { element, anchor, control: anchor }
        : null
    }

    // Apple Music places the preview's audio element outside its control bar.
    if (location.hostname === 'music.apple.com') {
      const anchor = origin?.closest('[data-testid="player-bar"]')
      const element = anchor && document.getElementById('apple-music-player')
      return hiddenAudio(element) ? { element, anchor, control: anchor } : null
    }
    return qqMusicAudio(origin)
  }

  function sameBounds(first, second) {
    return ['left', 'top', 'right', 'bottom'].every(
      (edge) => Math.abs(first[edge] - second[edge]) <= 1
    )
  }

  function coveredImage(origin, x, y, visibleAt) {
    const container = origin?.parentElement
    if (
      origin?.tagName !== 'BUTTON' ||
      !container ||
      container === document.body ||
      container === document.documentElement
    )
      return null
    const bounds = container.getBoundingClientRect()
    if (
      bounds.width * bounds.height > innerWidth * innerHeight * 2 ||
      !sameBounds(origin.getBoundingClientRect(), bounds)
    )
      return null
    const { backgroundColor, backgroundImage } = getComputedStyle(origin)
    if (
      (backgroundColor &&
        !['transparent', 'rgba(0, 0, 0, 0)'].includes(backgroundColor)) ||
      (backgroundImage && backgroundImage !== 'none')
    )
      return null
    if (
      [...container.querySelectorAll('video')].some(
        (video) => video.readyState >= 2 && visibleAt(video, x, y)
      )
    )
      return null
    const images = [...container.querySelectorAll('img')].filter((image) =>
      visibleAt(image, x, y)
    )
    if (!images.length) return null
    if (
      images.some(
        (image) =>
          !image.complete || !image.naturalWidth || !image.naturalHeight
      )
    )
      return { element: null }

    const foreground = images.filter((image) => {
      const rect = image.getBoundingClientRect()
      return (
        !sameBounds(rect, bounds) &&
        Math.abs(
          (rect.width * image.naturalHeight) /
            (rect.height * image.naturalWidth) -
            1
        ) < 0.05
      )
    })
    // A fitted photo can share its slide with a full-size backdrop. Only
    // prefer it when all other candidates fill that same slide.
    if (
      foreground.length === 1 &&
      images.every(
        (image) =>
          image === foreground[0] ||
          sameBounds(image.getBoundingClientRect(), bounds)
      )
    )
      return { element: foreground[0] }

    const [first] = images
    const url = first.currentSrc || first.src
    return url &&
      images.every((image) => (image.currentSrc || image.src) === url)
      ? { element: first }
      : { element: null, ambiguous: true }
  }

  globalThis.__inkloomMediaFallback = { imageUrl, audioPlayer, coveredImage }
})()
