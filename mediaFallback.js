// Select only an alternative that the same <picture> explicitly provides.
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

  globalThis.__inkloomMediaFallback = { imageUrl }
})()
