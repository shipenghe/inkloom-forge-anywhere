// Resolve only the single media item visibly covered by the browser-selected
// link. The click coordinates are not available to contextMenus.onClicked, so
// ambiguous links or competing media must be left to the picker.
;(() => {
  function transparentColor(value) {
    if (typeof value !== 'string') return false
    if (value === 'transparent') return true
    return /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(value)
  }
  function transparentLayer(node) {
    if (typeof node.textContent === 'string' && node.textContent.trim())
      return false
    if (node.matches?.('canvas,svg,img,video,dialog,[role="dialog"]'))
      return false
    if (node.querySelector?.('canvas,svg,img,video,dialog,[role="dialog"]'))
      return false
    const style = getComputedStyle(node)
    if (
      style.backgroundImage !== 'none' ||
      !transparentColor(style.backgroundColor)
    )
      return false
    for (const pseudo of ['::before', '::after']) {
      const part = getComputedStyle(node, pseudo)
      if (part.content && part.content !== 'none' && part.content !== 'normal')
        return false
      if (
        part.backgroundImage !== 'none' ||
        !transparentColor(part.backgroundColor)
      )
        return false
    }
    return true
  }
  function unoccludedSibling(link, media, box, rect) {
    if (link.closest?.('dialog,[role="dialog"]') || !transparentLayer(link))
      return false
    if (typeof document.elementsFromPoint !== 'function') return false
    const left = Math.max(box.left, rect.left),
      right = Math.min(box.right, rect.right)
    const top = Math.max(box.top, rect.top),
      bottom = Math.min(box.bottom, rect.bottom)
    for (const [fx, fy] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.5, 0.5],
      [0.25, 0.75],
      [0.75, 0.75],
    ]) {
      const stack = document.elementsFromPoint(
        left + (right - left) * fx,
        top + (bottom - top) * fy
      )
      const linkIndex = stack.findIndex(
        (node) => node === link || link.contains(node)
      )
      const mediaIndex = stack.indexOf(media)
      if (linkIndex < 0 || mediaIndex <= linkIndex) return false
      for (const layer of stack.slice(linkIndex + 1, mediaIndex)) {
        if (!layer.contains?.(media) && !transparentLayer(layer)) return false
      }
    }
    return true
  }
  function linkedMedia(linkUrl) {
    if (typeof linkUrl !== 'string') return null
    const links = [...document.querySelectorAll('a[href]')].filter(
      (link) => link.href === linkUrl
    )
    const candidates = []
    for (const link of links) {
      const parent = link.parentElement
      if (!parent) continue
      const box = link.getBoundingClientRect()
      if (!(box.width > 0 && box.height > 0)) continue
      const matches = [...parent.querySelectorAll('img,video')].filter(
        (media) => {
          const rect = media.getBoundingClientRect()
          if (!(rect.width > 0 && rect.height > 0)) return false
          for (let node = media; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.visibility === 'collapse' ||
              Number(style.opacity) === 0
            )
              return false
          }
          const width = Math.max(
            0,
            Math.min(box.right, rect.right) - Math.max(box.left, rect.left)
          )
          const height = Math.max(
            0,
            Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top)
          )
          const overlap = width * height
          const overlapping =
            overlap >= 0.8 * rect.width * rect.height &&
            overlap >= 0.8 * box.width * box.height
          if (!overlapping) return false
          return (
            link.contains(media) || unoccludedSibling(link, media, box, rect)
          )
        }
      )
      // Never use an ambiguous cover even if another same-href link looks
      // unambiguous: the browser does not expose which anchor was clicked.
      if (matches.length > 1) return null
      if (matches.length === 1) candidates.push(matches[0])
      if (candidates.length > 1) return null
    }
    if (candidates.length !== 1) return null
    const media = candidates[0]
    const mediaKind =
      media.tagName.toLowerCase() === 'video' ? 'video' : 'image'
    const url =
      mediaKind === 'image'
        ? globalThis.__inkloomMediaFallback?.imageUrl(media) ||
          media.currentSrc ||
          media.src
        : media.currentSrc || media.src
    if (typeof url !== 'string' || !/^(https?:|blob:|data:)/i.test(url))
      return null
    return {
      mediaKind,
      url,
      ...(mediaKind === 'image'
        ? { displayUrl: media.currentSrc || media.src }
        : {}),
      videoCandidates:
        mediaKind === 'video'
          ? globalThis.__inkloomVideoCandidates?.videoCandidates(media) || []
          : [],
    }
  }
  globalThis.__inkloomLinkedMedia = { linkedMedia }
})()
