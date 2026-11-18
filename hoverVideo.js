// A right-click entry point for media whose page suppresses native menus.
// Registered only on webpages the user has already authorized.
;(async () => {
  if (globalThis.ForgeI18n) await globalThis.ForgeI18n.ready
  const fallback = globalThis.__inkloomMediaFallback
  const t = (value) => globalThis.ForgeI18n?.text(value) ?? value
  globalThis.__forgeHoverVideoCleanup?.()
  let media = null
  let mediaControl = null
  let paintedImageAnchor = null
  let selectedUrl = null
  let lastPointer = null
  let stopped = false
  let serial = 0
  let targetAvailable = false
  let entryAvailable = false
  let targetCheckedAt = 0
  let stateRequest = null
  let busy = false
  let iconFailed = false
  let statusTimer
  let selectionTimer
  let idleTimer
  let pendingTimer
  let noticeMessage = ''

  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;z-index:2147483647;display:none;pointer-events:auto;'
  host.style.display = 'none'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    button { all: initial; box-sizing: border-box; display: grid; place-items: center;
      width: 36px; height: 36px; border: 1px solid #ffffff55; border-radius: 12px;
      background: #242326; color: white; box-shadow: 0 3px 12px #0006;
      font: 700 13px system-ui, sans-serif; cursor: pointer; }
    button:hover { background: #39363b; }
    button:focus-visible { outline: 2px solid #ff9f89; outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: .8; }
    button img { width: 23px; height: 23px; display: block; }
    .notice { position: absolute; top: 43px; right: 0; width: max-content;
      max-width: 240px; padding: 7px 10px; border-radius: 9px;
      background: #242326; color: white; font: 12px/1.4 system-ui, sans-serif;
      box-shadow: 0 3px 12px #0004; overflow-wrap: anywhere; }
    .notice[hidden] { display: none; }
  `
  const button = document.createElement('button')
  button.type = 'button'
  button.title = t('发送到画布')
  button.setAttribute('aria-label', t('发送素材到画布'))
  // Embedded copy of the packaged Forge favicon; no requests to the host page.
  const icon = document.createElement('img')
  icon.alt = ''
  icon.addEventListener('error', () => {
    iconFailed = true
    if (!busy) button.textContent = 'FA'
  })
  icon.src =
    'data:image/png;base64,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'
  button.append(icon)
  const notice = document.createElement('div')
  notice.className = 'notice'
  notice.hidden = true
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  shadow.append(style, button, notice)
  document.documentElement.append(host)

  function visibleAt(element, x, y, audio = element?.tagName === 'AUDIO') {
    if (!element?.isConnected) return false
    const rect = element.getBoundingClientRect()
    if (
      rect.width < 80 ||
      rect.height < (audio ? 18 : 60) ||
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    )
      return false
    for (
      let node = element;
      node instanceof Element;
      node = node.parentElement || node.getRootNode?.().host
    ) {
      const computed = getComputedStyle(node)
      if (
        computed.display === 'none' ||
        computed.visibility === 'hidden' ||
        computed.visibility === 'collapse' ||
        Number(computed.opacity) === 0
      )
        return false
    }
    return true
  }

  function isMedia(element) {
    return (
      element instanceof HTMLImageElement ||
      element instanceof HTMLVideoElement ||
      element?.tagName === 'AUDIO'
    )
  }
  function sendLabel(element) {
    if (!targetAvailable) return '打开 Forge'
    if (element?.tagName === 'AUDIO') return '发送音频到画布'
    return element instanceof HTMLImageElement
      ? '发送图片到画布'
      : '发送视频到画布'
  }
  function resolveMedia(candidates, x, y) {
    if (candidates.size === 1) return [...candidates][0]
    if (candidates.size !== 2) return null
    const video = [...candidates].find(
      (node) => node instanceof HTMLVideoElement
    )
    const image = [...candidates].find(
      (node) => node instanceof HTMLImageElement
    )
    // Video cards can retain their poster image beneath the playing preview.
    // Require a decoded frame, the same parent and bounds, and an actual hit
    // stack proving the video is painted above that image. Other overlaps are
    // still ambiguous; DOM order alone cannot identify the requested media.
    if (
      !video ||
      !image ||
      video.parentElement !== image.parentElement ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight ||
      Number(getComputedStyle(video).opacity) !== 1
    )
      return null
    const videoRect = video.getBoundingClientRect()
    const imageRect = image.getBoundingClientRect()
    if (
      ['left', 'top', 'right', 'bottom'].some(
        (edge) => Math.abs(videoRect[edge] - imageRect[edge]) > 1
      )
    )
      return null
    const root = video.getRootNode?.() || document
    const stack = root.elementsFromPoint?.(x, y) || []
    const videoIndex = stack.indexOf(video)
    return videoIndex >= 0 && stack.indexOf(image) > videoIndex ? video : null
  }
  function findMedia(event) {
    const { clientX: x, clientY: y } = event
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const path = event.composedPath?.() || [event.target]
    for (const node of path) {
      if (isMedia(node) && visibleAt(node, x, y)) return { element: node }
    }
    const origin = path.find((node) => node instanceof Element)
    if (!origin) return null
    const video = fallback?.coveredVideo?.(path, x, y, visibleAt)
    if (video) return video
    const player = globalThis.__inkloomMediaFallback?.audioPlayer?.(origin)
    if (player && visibleAt(player.anchor, x, y, true)) return player
    const covered = globalThis.__inkloomMediaFallback?.coveredImage?.(
      origin,
      x,
      y,
      visibleAt
    )
    if (covered) return covered
    const painted = fallback?.paintedImage?.(origin, x, y, visibleAt)
    if (painted) return painted
    const dialog = origin.closest(
      'dialog, [role="dialog"], [aria-modal="true"]'
    )
    const candidates = new Set()
    function blockedByOpaqueLayer(media, common) {
      for (
        let layer = origin;
        layer instanceof Element && layer !== common;
        layer = layer.parentElement
      ) {
        if (layer.contains(media)) continue
        if (fallback.opaqueBackdrop(getComputedStyle(layer))) return true
      }
      return false
    }
    let scope = origin
    for (let depth = 0; scope instanceof Element && depth <= 3; depth++) {
      if (scope === document.body || scope === document.documentElement) break
      const rect = scope.getBoundingClientRect()
      // Never scan a feed-sized ancestor on every pointer movement.
      if (rect.width * rect.height > innerWidth * innerHeight * 4) break
      if (candidates.size) {
        const found = [...candidates][0].getBoundingClientRect()
        if (rect.width * rect.height > found.width * found.height * 4) break
      }
      for (const item of scope.querySelectorAll('img, video, audio')) {
        if (!isMedia(item) || !visibleAt(item, x, y)) continue
        // Unstarted previews can leave an empty video element over the cover.
        if (
          !(item instanceof HTMLImageElement) &&
          !(item.currentSrc || item.src)
        )
          continue
        if (dialog && !dialog.contains(item)) continue
        if (blockedByOpaqueLayer(item, scope)) continue
        const bounds = item.getBoundingClientRect()
        // Do not select media through a page-wide overlay or unrelated dialog.
        if (rect.width * rect.height > bounds.width * bounds.height * 4)
          continue
        candidates.add(item)
        if (candidates.size > 2) return null
      }
      scope = scope.parentElement
    }
    const element = resolveMedia(candidates, x, y)
    return element ? { element } : null
  }

  function hide() {
    serial++
    media = null
    mediaControl = null
    paintedImageAnchor = null
    selectedUrl = null
    host.style.display = 'none'
    notice.hidden = true
    clearTimeout(statusTimer)
    clearTimeout(selectionTimer)
    clearTimeout(idleTimer)
  }
  function place(element, audio = element.tagName === 'AUDIO') {
    // A modal dialog makes unrelated document elements inert. Keep the entry
    // with the selected media's modal, and move it back for ordinary pages.
    const container =
      element.closest('dialog[open]') || document.documentElement
    if (host.parentElement !== container) container.append(host)
    const rect = element.getBoundingClientRect()
    if (
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= innerWidth ||
      rect.top >= innerHeight
    ) {
      hide()
      return
    }
    const right = Math.min(rect.right, innerWidth) - 8
    const above = audio && rect.top >= 44
    const top = above ? rect.top - 44 : Math.max(rect.top, 0) + (audio ? 0 : 8)
    if (
      right - 36 < Math.max(rect.left, 0) ||
      top + 36 > (audio ? innerHeight : Math.min(rect.bottom, innerHeight))
    ) {
      hide()
      return
    }
    host.style.left = `${Math.round(right - 36)}px`
    host.style.top = `${Math.round(top)}px`
    host.style.display = 'block'
  }
  async function hasTarget(fresh = false) {
    // Right-click is infrequent and must see a target just set in another tab.
    // Session-storage change events are not exposed to every content script.
    if (fresh && stateRequest) await stateRequest
    if (!fresh && Date.now() - targetCheckedAt < 1000) return entryAvailable
    if (!stateRequest) {
      stateRequest = chrome.runtime
        .sendMessage({ kind: 'HOVER_MEDIA_STATE' })
        .then((value) => {
          if (value?.ok === true && value.enabled === false) {
            stop()
            return false
          }
          targetAvailable = value?.ok === true && value.hasTarget === true
          entryAvailable =
            value?.ok === true && (value.canShow ?? value.hasTarget) === true
          targetCheckedAt = Date.now()
          return entryAvailable
        })
        .catch(() => {
          targetAvailable = false
          entryAvailable = false
          targetCheckedAt = Date.now()
          return false
        })
        .finally(() => {
          stateRequest = null
        })
    }
    return stateRequest
  }
  async function contextmenu(event) {
    if (stopped || busy || !event.isTrusted) return
    if ((event.composedPath?.() || []).includes(host)) return
    lastPointer = { x: event.clientX, y: event.clientY }
    const hit = findMedia(event)
    if (!hit?.element) {
      hide()
      return
    }
    const { element: candidate, control = null } = hit
    const candidateUrl = candidate.currentSrc || candidate.src
    const generation = ++serial
    const allowed = await hasTarget(true)
    if (generation !== serial || stopped) return
    if (!allowed) return hide()
    media = candidate
    mediaControl = control
    paintedImageAnchor = candidate.tagName === 'IMG' ? hit.anchor ?? null : null
    selectedUrl = candidateUrl
    const anchor = selectionAnchor()
    const audio = candidate.tagName === 'AUDIO'
    if (!visibleAt(anchor, event.clientX, event.clientY, audio)) return hide()
    button.disabled = false
    button.title = t(targetAvailable ? '发送到画布' : '打开 Forge')
    button.setAttribute('aria-label', t(sendLabel(candidate)))
    place(anchor, audio)
    watchSelection()
    clearTimeout(idleTimer)
    idleTimer = setTimeout(hide, 8000)
  }
  function selectionAnchor() {
    if (!media?.isConnected || (media.currentSrc || media.src) !== selectedUrl)
      return null
    if (paintedImageAnchor) {
      const { x, y } = lastPointer
      const painted = fallback.paintedImage(media, x, y, visibleAt, host)
      return painted?.anchor === paintedImageAnchor ? paintedImageAnchor : null
    }
    if (!mediaControl) return media
    const player = globalThis.__inkloomMediaFallback.audioPlayer(mediaControl)
    return player?.element === media ? player.anchor : null
  }
  function updatePosition() {
    // Keep the in-flight feedback anchored even when playback swaps its source.
    if (busy) return
    if (!media) return
    const anchor = selectionAnchor()
    const audio = media.tagName === 'AUDIO'
    if (!lastPointer || !visibleAt(anchor, lastPointer.x, lastPointer.y, audio))
      hide()
    else place(anchor, audio)
  }
  function watchSelection() {
    clearTimeout(selectionTimer)
    if (!media || stopped) return
    selectionTimer = setTimeout(() => {
      updatePosition()
      watchSelection()
    }, 250)
  }
  function outside(event) {
    if ((event.composedPath?.() || []).includes(host)) return
    hide()
  }
  function keydown(event) {
    if (event.key === 'Escape') hide()
  }
  function say(value, pending = false) {
    if (stopped) return
    clearTimeout(idleTimer)
    if (
      !host.isConnected ||
      (host.parentElement?.tagName === 'DIALOG' && !host.parentElement.open)
    )
      document.documentElement.append(host)
    const text =
      typeof value === 'string' &&
      value.length <= 100 &&
      !/https?:\/\/|\btoken\b/i.test(value)
        ? value
        : '发送失败，请重试'
    noticeMessage = text
    notice.textContent = t(text)
    notice.hidden = false
    host.style.display = 'block'
    // Feedback must stay inside the visible viewport, including after a scroll.
    const left = parseFloat(host.style.left) || 8
    const top = parseFloat(host.style.top) || 8
    host.style.left = `${Math.max(8, Math.min(left, innerWidth - 44))}px`
    host.style.top = `${Math.max(8, Math.min(top, innerHeight - 100))}px`
    clearTimeout(statusTimer)
    if (!pending) statusTimer = setTimeout(hide, 6000)
  }
  function changedSelection() {
    media = null
    mediaControl = null
    paintedImageAnchor = null
    selectedUrl = null
    clearTimeout(selectionTimer)
    clearTimeout(idleTimer)
    button.disabled = true
    say('素材已变化，请重新右键')
  }
  button.addEventListener('pointerdown', (event) => {
    if (event.isTrusted) event.stopPropagation()
  })
  async function sendSelectedMedia(event) {
    if (!event.isTrusted || busy) return
    event.preventDefault()
    event.stopPropagation()
    if (!targetAvailable) {
      busy = true
      button.disabled = true
      try {
        const result = await chrome.runtime.sendMessage({ kind: 'OPEN_FORGE' })
        if (!result?.ok) throw new Error()
        hide()
      } catch {
        say('操作失败，请重试')
      } finally {
        busy = false
        button.disabled = false
      }
      return
    }
    const selected = media
    if (!selectionAnchor()) return changedSelection()
    const url = selected.currentSrc || selected.src
    if (url !== selectedUrl) return changedSelection()
    const isData = typeof url === 'string' && /^data:/i.test(url)
    if (
      typeof url !== 'string' ||
      (!isData && url.length > 4096) ||
      !/^(https?:|blob:|data:)/i.test(url)
    ) {
      say('无法读取素材')
      return
    }
    const mediaKind =
      selected.tagName === 'AUDIO'
        ? 'audio'
        : selected instanceof HTMLImageElement
        ? 'image'
        : 'video'
    clearTimeout(idleTimer)
    clearTimeout(selectionTimer)
    busy = true
    button.disabled = true
    button.textContent = '…'
    button.setAttribute('aria-busy', 'true')
    say('正在准备…', true)
    pendingTimer = setTimeout(() => say('仍在处理中，请稍候', true), 10000)
    let temporaryUrl
    try {
      let transferUrl = url
      if (isData) {
        // Decode an inline resource locally. Never send its potentially huge
        // data URL through runtime messaging or request an external origin.
        const blob = await (await fetch(url)).blob()
        if (!blob.size || blob.size > 200 * 1024 * 1024)
          throw new Error('无法读取素材')
        temporaryUrl = URL.createObjectURL(blob)
        transferUrl = temporaryUrl
      }
      if (!selectionAnchor() || media !== selected || selectedUrl !== url)
        return changedSelection()
      if (mediaKind === 'image') globalThis.__inkloomSelectedImage = selected
      if (mediaKind === 'video') globalThis.__inkloomSelectedVideo = selected
      const source =
        mediaKind === 'image'
          ? { displayUrl: transferUrl }
          : mediaKind === 'video'
          ? {
              videoCandidates:
                globalThis.__inkloomVideoCandidates?.videoCandidates(
                  selected
                ) || [],
            }
          : {}
      const result = await chrome.runtime.sendMessage({
        kind: 'HOVER_MEDIA_SEND',
        url: transferUrl,
        mediaKind,
        ...source,
      })
      if (result?.openedForge) return hide()
      say(
        result?.ok
          ? result.message || '已交给画布'
          : result?.error || '发送失败，请重试'
      )
    } catch {
      say('发送失败，请重试')
    } finally {
      clearTimeout(pendingTimer)
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl)
      busy = false
      button.disabled = !selectionAnchor()
      button.setAttribute('aria-busy', 'false')
      button.textContent = iconFailed ? 'FA' : ''
      if (!iconFailed) button.append(icon)
    }
  }
  button.addEventListener('click', sendSelectedMedia)

  function captureButtonEvent(event) {
    if (
      stopped ||
      !event.isTrusted ||
      (typeof event.button === 'number' && event.button !== 0) ||
      !(event.composedPath?.() || []).includes(host)
    )
      return
    // Closed-shadow events are retargeted to the host. Limit interception to
    // the actual button rectangle; notice text and all webpage clicks pass on.
    const rect = button.getBoundingClientRect()
    const hit =
      event.clientX >= rect.left &&
      event.clientX < rect.right &&
      event.clientY >= rect.top &&
      event.clientY < rect.bottom
    const keyboard =
      event.type === 'click' &&
      event.detail === 0 &&
      shadow.activeElement === button
    if (!hit && !keyboard) return
    // Handle our control before document-level site handlers can consume the
    // first click to dismiss a custom context menu. A press alone never sends.
    event.stopImmediatePropagation()
    if (event.type === 'click') return sendSelectedMedia(event)
  }
  const buttonEvents = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
  ]
  for (const type of buttonEvents)
    window.addEventListener(type, captureButtonEvent, true)
  const unsubscribeLanguage = globalThis.ForgeI18n?.subscribe(() => {
    button.title = t(targetAvailable ? '发送到画布' : '打开 Forge')
    button.setAttribute('aria-label', t(sendLabel(media)))
    notice.textContent = t(noticeMessage)
  })
  function stop() {
    if (stopped) return
    stopped = true
    unsubscribeLanguage?.()
    hide()
    clearTimeout(pendingTimer)
    document.removeEventListener('contextmenu', contextmenu, true)
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('click', outside, true)
    document.removeEventListener('keydown', keydown, true)
    window.removeEventListener('scroll', updatePosition, true)
    window.removeEventListener('resize', updatePosition)
    window.removeEventListener('pagehide', stop)
    for (const type of buttonEvents)
      window.removeEventListener(type, captureButtonEvent, true)
    chrome.runtime.onMessage.removeListener(onMessage)
    chrome.storage?.onChanged?.removeListener(onStorageChanged)
    host.remove()
    delete globalThis.__forgeHoverVideoCleanup
  }
  function onMessage(message, sender, reply) {
    if (
      !['HOVER_MEDIA_STOP', 'HOVER_VIDEO_STOP'].includes(message?.kind) ||
      sender?.id !== chrome.runtime.id
    )
      return
    stop()
    reply({ ok: true })
  }
  function onStorageChanged(changes, area) {
    if (area !== 'session' || !changes.target) return
    targetCheckedAt = 0
    if (!changes.target.newValue) hide()
  }
  chrome.runtime.onMessage.addListener(onMessage)
  chrome.storage?.onChanged?.addListener(onStorageChanged)
  document.addEventListener('contextmenu', contextmenu, true)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('click', outside, true)
  document.addEventListener('keydown', keydown, true)
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('pagehide', stop, { once: true })
  globalThis.__forgeHoverVideoCleanup = stop
  // A registration may run after its webpage permission has been revoked.
  void hasTarget()
})()
