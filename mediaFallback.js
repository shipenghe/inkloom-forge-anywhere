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

  function detachedAudioPlayer(origin) {
    // Some players keep their audio element outside the controls. Only pair
    // them when the page has one usable hidden track and one visible playback
    // control; a track list must never send a different song by inference.
    const selector = 'button[aria-label], [role="button"][aria-label]'
    const control = origin?.closest?.(selector)
    const label = control?.getAttribute?.('aria-label')?.trim()
    if (!/^(?:play|pause)(?:\s*\/\s*(?:play|pause))?$/i.test(label || ''))
      return null
    const controls = [...(document.querySelectorAll?.(selector) || [])].filter(
      (candidate) => {
        const text = candidate.getAttribute('aria-label')?.trim() || ''
        if (!/^(?:play|pause)(?:\s*\/\s*(?:play|pause))?$/i.test(text))
          return false
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
    )
    if (controls.length !== 1 || controls[0] !== control) return null
    const tracks = [...document.querySelectorAll('audio')].filter(
      (audio) => audio.readyState >= 1 && !audio.error && !audio.ended
    )
    if (
      tracks.length !== 1 ||
      tracks[0].parentElement !== document.body ||
      tracks[0].paused !== false ||
      !hiddenAudio(tracks[0])
    )
      return null
    for (
      let anchor = control.parentElement, depth = 0;
      anchor &&
      anchor !== document.body &&
      anchor !== document.documentElement &&
      depth < 6;
      anchor = anchor.parentElement, depth++
    ) {
      const { width, height } = anchor.getBoundingClientRect()
      if (
        /(?:^|[\s_-])player(?:[\s_-]|$)/i.test(
          anchor.getAttribute?.('class') || ''
        ) &&
        !anchor.querySelector?.('video') &&
        width >= 80 &&
        width <= Math.min(innerWidth, 960) &&
        height >= 18 &&
        height <= Math.min(innerHeight / 3, 240)
      )
        return { element: tracks[0], anchor, control }
    }
    return null
  }

  function audioPlayer(origin) {
    // Custom controls may share their compact container with a hidden native
    // player. Controls can sit several wrappers below the direct audio sibling.
    for (
      let anchor = origin, depth = 0;
      anchor &&
      anchor !== document.body &&
      anchor !== document.documentElement &&
      depth < 12;
      anchor = anchor.parentElement, depth++
    ) {
      const tracks = [...anchor.children].filter(
        (node) => node.tagName === 'AUDIO'
      )
      if (!tracks.length) continue
      const { width, height } = anchor.getBoundingClientRect()
      if (width < 80 || height < 18 || height > Math.min(innerHeight / 3, 240))
        continue
      if (
        tracks.every(
          (audio) =>
            audio.readyState === 0 &&
            !audio.currentSrc &&
            !audio.src &&
            !audio.srcObject &&
            !audio.querySelector?.('source[src]')
        )
      )
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
    if (location.hostname === 'y.qq.com') return qqMusicAudio(origin)
    return detachedAudioPlayer(origin)
  }

  function sameBounds(first, second, tolerance = 1) {
    return ['left', 'top', 'right', 'bottom'].every(
      (edge) => Math.abs(first[edge] - second[edge]) <= tolerance
    )
  }

  function paintedImage(image, x, y, visibleAt, ownEntry) {
    // Some galleries use a transparent, decoded img for interaction and a
    // separate layer to paint it. Only pair the two actual hit layers.
    if (
      image?.tagName !== 'IMG' ||
      !image.isConnected ||
      !image.complete ||
      !image.naturalWidth ||
      !image.naturalHeight ||
      Number(getComputedStyle(image).opacity) !== 0
    )
      return null
    const parent = image.parentElement
    if (
      !parent ||
      parent === document.body ||
      parent === document.documentElement
    )
      return null
    const root = image.getRootNode?.() || document
    const [first, anchor] = (root.elementsFromPoint?.(x, y) || []).filter(
      (layer) => layer !== ownEntry
    )
    if (
      first !== image ||
      anchor?.parentElement !== parent ||
      anchor.matches('img, video, audio, canvas, iframe') ||
      !visibleAt(anchor, x, y)
    )
      return null
    const url = safeUrl(image.currentSrc, image.ownerDocument?.baseURI)
    if (!url || getComputedStyle(anchor).backgroundImage !== `url("${url}")`)
      return null
    const bounds = image.getBoundingClientRect()
    return sameBounds(bounds, anchor.getBoundingClientRect()) &&
      sameBounds(bounds, parent.getBoundingClientRect())
      ? { element: image, anchor }
      : null
  }

  function opaqueBackdrop(style) {
    const background = style.backgroundImage
    let opacity = 0
    if (background && background !== 'none') {
      // Only computed gradients with explicit alpha colors can be transparent.
      // Image URLs and unknown paint functions block selection.
      const functions = [...background.matchAll(/([\w-]+)\(/g)].map(
        (match) => match[1]
      )
      const gradients = functions.filter((name) =>
        /^(?:repeating-)?(?:linear|radial|conic)-gradient$/.test(name)
      ).length
      const colors = [...background.matchAll(/rgba\([^()]*,\s*([\d.]+)\s*\)/g)]
      if (
        !gradients ||
        !colors.length ||
        functions.length !== gradients + colors.length
      )
        return true
      const maxAlpha = Math.max(...colors.map((match) => Number(match[1])))
      // Use the most opaque stop as a bound for every layer. Stacked gradients
      // can hide an image even when each individual gradient is translucent.
      opacity = 1 - (1 - maxAlpha) ** gradients
    }
    const color = style.backgroundColor
    if (color && color !== 'transparent') {
      const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/i)
      if (rgba) opacity = 1 - (1 - opacity) * (1 - Number(rgba[1]))
      else return true
    }
    return opacity >= 0.95
  }
  function readyVideo(element) {
    return (
      element.tagName === 'VIDEO' &&
      element.readyState >= 2 &&
      element.videoWidth > 0 &&
      element.videoHeight > 0 &&
      !element.error &&
      !element.mediaKeys &&
      /^(https?:|blob:)/i.test(element.currentSrc)
    )
  }

  function shadowVideo(path, x, y, visibleAt) {
    // Inspect open roots on the event path. A nested player can keep its
    // native video beside the controls, outside the control's event path.
    for (const host of path) {
      if (!host.shadowRoot || !visibleAt(host, x, y)) continue
      const bounds = host.getBoundingClientRect()
      const candidates = []
      let budget = 500
      function collect(root, depth) {
        for (const element of root.querySelectorAll('*')) {
          if (--budget < 0 || candidates.length > 1) return
          if (
            readyVideo(element) &&
            sameBounds(element.getBoundingClientRect(), bounds) &&
            visibleAt(element, x, y)
          )
            candidates.push(element)
          // Player-sized components can contain the media surface. Skip the
          // shadow trees of individual controls, menus, and tooltips.
          if (
            depth < 4 &&
            element.shadowRoot &&
            (sameBounds(element.getBoundingClientRect(), bounds) ||
              getComputedStyle(element).display === 'contents')
          )
            collect(element.shadowRoot, depth + 1)
        }
      }
      collect(host.shadowRoot, 1)
      if (budget < 0 || candidates.length > 1)
        return { element: null, ambiguous: true }
      if (candidates.length === 1) return { element: candidates[0] }
    }
    return null
  }

  function transparentVideoLayers(path, x, y, visibleAt) {
    const [origin] = path
    if (origin?.tagName !== 'DIV' || !visibleAt(origin, x, y)) return null
    const stack = document.elementsFromPoint?.(x, y) || []
    if (stack[0] !== origin) return null
    const bounds = origin.getBoundingClientRect()
    const modal = '[role="dialog"], [aria-modal="true"]'
    function clearLayer(layer) {
      if (
        layer.tagName !== 'DIV' ||
        layer.matches?.(modal) ||
        !sameBounds(layer.getBoundingClientRect(), bounds, 2) ||
        !visibleAt(layer, x, y)
      )
        return false
      const style = getComputedStyle(layer)
      const color = style.backgroundColor
      return (
        (!color ||
          color === 'transparent' ||
          /^rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?\s*\)$/.test(color)) &&
        [
          'backgroundImage',
          'backdropFilter',
          'filter',
          'boxShadow',
          'maskImage',
        ].every((name) => !style[name] || style[name] === 'none')
      )
    }
    // Unlabelled overlays need stronger evidence than ordinary player buttons:
    // all hit layers must be transparent, player-sized, and in the same frame.
    if (!clearLayer(origin)) return null
    for (const frame of path.slice(1, 4)) {
      if (
        frame.tagName !== 'DIV' ||
        frame.matches?.(modal) ||
        !sameBounds(frame.getBoundingClientRect(), bounds, 2)
      )
        continue
      const end = stack.indexOf(frame)
      if (end < 2 || end > 12) continue
      const videos = stack.filter(
        (element) =>
          readyVideo(element) &&
          frame.contains(element) &&
          sameBounds(element.getBoundingClientRect(), bounds, 2) &&
          visibleAt(element, x, y)
      )
      if (videos.length > 1) return { element: null, ambiguous: true }
      const [element] = videos
      if (!element) continue
      const index = stack.indexOf(element)
      if (index >= end) return null
      if (
        !stack
          .slice(0, index)
          .every((layer) => frame.contains(layer) && clearLayer(layer))
      )
        return { element: null }
      return { element }
    }
    return null
  }

  function coveredVideo(path, x, y, visibleAt) {
    const shadow = shadowVideo(path, x, y, visibleAt)
    if (shadow) return shadow

    // Some players put a full-size play/pause button over a sibling video.
    // Require both the same player bounds and a hit stack through that control.
    const control = path.find((node) =>
      node.matches?.('button, [role="button"]')
    )
    if (!control) return transparentVideoLayers(path, x, y, visibleAt)
    if (!visibleAt(control, x, y)) return null
    const bounds = control.getBoundingClientRect()
    const stack = document.elementsFromPoint?.(x, y) || []
    const videos = stack.filter(
      (node) =>
        readyVideo(node) &&
        sameBounds(node.getBoundingClientRect(), bounds) &&
        visibleAt(node, x, y) &&
        path.some(
          (ancestor) =>
            ancestor !== document.body &&
            ancestor !== document.documentElement &&
            ancestor.getBoundingClientRect &&
            ancestor.contains(node) &&
            sameBounds(ancestor.getBoundingClientRect(), bounds)
        )
    )
    if (videos.length > 1) return { element: null, ambiguous: true }
    const [element] = videos
    if (!element) return null
    const index = stack.indexOf(element)
    const controlIndex = stack.indexOf(control)
    if (controlIndex < 0 || controlIndex >= index) return null
    if (
      stack.slice(0, index).some(
        (layer) =>
          !layer.contains(element) &&
          (layer.matches('img, video, audio, canvas, iframe') ||
            opaqueBackdrop(getComputedStyle(layer)))
      )
    )
      return null
    return { element }
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

  globalThis.__inkloomMediaFallback = {
    imageUrl,
    audioPlayer,
    coveredImage,
    coveredVideo,
    paintedImage,
    opaqueBackdrop,
  }
})()
