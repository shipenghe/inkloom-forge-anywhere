// Runs only after the user explicitly chooses the current tab.
;(async () => {
  if (globalThis.ForgeI18n) await globalThis.ForgeI18n.ready
  const t = (value) => globalThis.ForgeI18n?.text(value) ?? value
  globalThis.__inkloomPickerCleanup?.()
  let hovered = null
  const outline = document.createElement('div')
  outline.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;display:none;border:3px solid #1a73e8;background:#1a73e822;box-sizing:border-box'
  const pickerHint = '点击图片、视频或音频 · Esc 取消'
  let hintMessage = pickerHint
  const hint = document.createElement('div')
  const setHint = (value) => {
    hintMessage = value
    return t(value)
  }
  const unsubscribeLanguage = globalThis.ForgeI18n?.subscribe(() => {
    hint.textContent = setHint(hintMessage)
  })
  hint.style.cssText =
    'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;color:white;background:#1c2736;border-radius:8px;font:14px system-ui,sans-serif;box-shadow:0 2px 12px #0006'
  hint.textContent = setHint(pickerHint)
  document.documentElement.append(outline, hint)
  let audioControlsStyle
  try {
    // Native audio controls consume mouse events before they reach the picker.
    audioControlsStyle = new CSSStyleSheet()
    audioControlsStyle.replaceSync(
      'audio::-webkit-media-controls, audio::-webkit-media-controls-panel { pointer-events: none !important; }'
    )
    document.adoptedStyleSheets.push(audioControlsStyle)
  } catch {
    audioControlsStyle = null
  }
  function visibleAt(element, x, y) {
    if (!element.isConnected || !Number.isFinite(x) || !Number.isFinite(y))
      return false
    const rect = element.getBoundingClientRect()
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    )
      return false
    for (
      let node = element;
      node instanceof Element;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node)
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
  function findMedia(event) {
    const x = event.clientX
    const y = event.clientY
    // A direct hit identifies the requested element, including within an open
    // shadow tree. Treat it as authoritative instead of guessing from a card.
    const path = event.composedPath?.() || [event.target]
    const origin = path.find((node) => node instanceof Element)
    for (const node of path) {
      if (!(node instanceof Element)) continue
      const direct = node.closest('img, video, audio')
      if (direct && visibleAt(direct, x, y)) return { element: direct }
    }
    // A full-card link or overlay can sit above a pointer-events:none image.
    // Inspect hit elements and their descendants, but never scan the document
    // root, and refuse overlapping candidates instead of choosing arbitrarily.
    const candidates = new Set()
    const actionable = origin?.closest(
      'a, button, [role="link"], [role="button"]'
    )
    const boundary = actionable || origin
    const maxDepth = actionable ? 1 : 2
    function scopeAllowed(node) {
      return (
        node instanceof Element &&
        node !== document.body &&
        node !== document.documentElement &&
        node.parentElement !== document.body &&
        !node.matches('dialog, [role="dialog"], [aria-modal="true"]')
      )
    }
    function opaqueBackdrop(style) {
      if (style.backgroundImage && style.backgroundImage !== 'none') return true
      const color = style.backgroundColor
      if (!color || color === 'transparent') return false
      const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/i)
      if (rgba) return Number(rgba[1]) >= 0.95
      return /^rgb\(/i.test(color)
    }
    function sharesCard(media) {
      // An unrelated modal may cover an image elsewhere on the page. Require a
      // tightly scoped parent rather than finding images under page-wide roots.
      let depth = 0
      for (
        let node = boundary;
        node instanceof Element && depth <= maxDepth;
        node = node.parentElement, depth++
      ) {
        if (!scopeAllowed(node)) return false
        if (!node.contains(media)) {
          if (opaqueBackdrop(getComputedStyle(node))) return false
          continue
        }
        const container = node.getBoundingClientRect()
        const rect = media.getBoundingClientRect()
        return (
          container.width > 0 &&
          container.height > 0 &&
          container.width * container.height <= rect.width * rect.height * 8
        )
      }
      return false
    }
    let scope = null
    for (
      let node = boundary, depth = 0;
      node instanceof Element && depth <= maxDepth;
      node = node.parentElement, depth++
    ) {
      if (!scopeAllowed(node)) break
      scope = node
    }
    function addCandidate(media) {
      if (sharesCard(media) && visibleAt(media, x, y)) candidates.add(media)
    }
    for (const layer of document.elementsFromPoint(x, y)) {
      if (!(layer instanceof Element)) continue
      if (layer.matches('img, video, audio')) addCandidate(layer)
      if (candidates.size > 1) return { element: null, ambiguous: true }
    }
    // Inspect only the nearest safe scope once, not every page ancestor on each
    // pointer move (large media feeds may contain thousands of other nodes).
    for (const media of scope?.querySelectorAll('img, video, audio') || []) {
      addCandidate(media)
      if (candidates.size > 1) return { element: null, ambiguous: true }
    }
    return { element: candidates.size === 1 ? [...candidates][0] : null }
  }
  function move(event) {
    hovered = findMedia(event).element
    if (!hovered) {
      outline.style.display = 'none'
      return
    }
    const rect = hovered.getBoundingClientRect()
    Object.assign(outline.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
  }
  function cleanup() {
    unsubscribeLanguage?.()
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('click', click, true)
    document.removeEventListener('keydown', keydown, true)
    outline.remove()
    hint.remove()
    if (audioControlsStyle)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (style) => style !== audioControlsStyle
      )
    delete globalThis.__inkloomPickerCleanup
  }
  function keydown(event) {
    if (event.key === 'Escape') {
      cleanup()
      chrome.runtime.sendMessage({ kind: 'PICKER_CANCEL' }).catch(() => {})
    }
  }
  async function click(event) {
    event.preventDefault()
    event.stopImmediatePropagation()
    const { element, ambiguous } = findMedia(event)
    if (!element) {
      hint.textContent = setHint(
        ambiguous ? '此处有多个素材，请点击更明确的位置' : pickerHint
      )
      return
    }
    const kind =
      element.tagName === 'AUDIO'
        ? 'audio'
        : element instanceof HTMLVideoElement
        ? 'video'
        : 'image'
    const displayUrl =
      kind === 'image' ? element.currentSrc || element.src : null
    let url =
      kind === 'image'
        ? globalThis.__inkloomMediaFallback.imageUrl(element)
        : element.currentSrc || element.src
    if (!url) {
      hint.textContent = setHint('未找到媒体文件，请选择其他素材')
      return
    }
    if (url.startsWith('data:')) {
      try {
        hint.textContent = setHint('正在准备素材…')
        const blob = await (await fetch(url)).blob()
        if (blob.size > 200 * 1024 * 1024) throw new Error('媒体文件过大')
        if (globalThis.__inkloomPickerBlobUrl)
          URL.revokeObjectURL(globalThis.__inkloomPickerBlobUrl)
        url = URL.createObjectURL(blob)
        globalThis.__inkloomPickerBlobUrl = url
      } catch {
        hint.textContent = setHint('无法读取此媒体，请选择其他素材')
        return
      }
    }
    try {
      if (kind === 'image') globalThis.__inkloomSelectedImage = element
      const result = await chrome.runtime.sendMessage({
        kind: 'MEDIA_SELECTED',
        url,
        mediaKind: kind,
        ...(displayUrl && { displayUrl }),
        videoCandidates:
          kind === 'video'
            ? globalThis.__inkloomVideoCandidates.videoCandidates(element)
            : [],
      })
      if (!result?.ok) throw new Error(result?.error || '无法选中素材')
      cleanup()
    } catch (error) {
      const message = error?.message
      hint.textContent = t(
        typeof message === 'string' &&
          message.length <= 160 &&
          !/https?:\/\/|\btoken\b/i.test(message)
          ? message
          : '无法选中素材，请重试'
      )
    }
  }
  document.addEventListener('pointermove', move, true)
  document.addEventListener('click', click, true)
  document.addEventListener('keydown', keydown, true)
  globalThis.__inkloomPickerCleanup = cleanup
})()
