// Injected only into the canvas tab selected by the user. Communication stays
// inside the extension's isolated world; the page receives only a normal drop.
;(async () => {
  if (globalThis.ForgeI18n) await globalThis.ForgeI18n.ready
  const bridgeVersion = chrome.runtime.getManifest().version
  if (globalThis.__forgeDropBridge?.version === bridgeVersion) return
  globalThis.__forgeDropBridge?.stop()
  // Legacy bridges expose only a boolean and cannot remove their listener.
  // A new request kind keeps those listeners from answering new transfers.
  const REQUEST_KIND = 'FORGE_DROP_REQUEST_V2'
  const CHANNEL = 'inkloom-media-import-v1'
  const MAX_SIZE = 200 * 1024 * 1024
  const MAX_ENCODED_CHUNK_LENGTH = 1024 * 1024
  const TIMEOUT = 120_000
  const GRID_COLUMNS = 10
  const MEDIA_CONTENT_AREA = 129_600
  const MEDIA_MAX_SIDE = 560
  const NODE_HEADER_HEIGHT = 28
  const GRID_GAP = 80
  let sessionId = null
  let transfer = null
  let pendingWatcher = null
  let grid = null
  let stopped = false

  function currentCanvasId() {
    const match = location.pathname.match(/^\/detail\/([^/]+)\/?$/)
    if (!match) return null
    try {
      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }

  function clearTransfer() {
    if (!transfer) return
    clearTimeout(transfer.timer)
    transfer.chunks = []
    transfer = null
  }

  function renewTimer(current) {
    clearTimeout(current.timer)
    current.timer = setTimeout(() => {
      if (transfer === current) clearTransfer()
    }, TIMEOUT)
  }

  function canvasName(root, canvasId) {
    // In the existing canvas shell, the name follows the header menu button.
    // Treat this DOM lookup as optional; never mistake the site title for the
    // user's chosen canvas when the shell changes or has not rendered yet.
    const section = root.closest('main')?.parentElement
    const header = root.closest('main')?.nextElementSibling
    if (section && header?.parentElement === section) {
      const button = header.querySelector(':scope > div > button')
      const name = button?.nextElementSibling
      if (name?.matches('span, input')) {
        const value = name.matches('input') ? name.value : name.textContent
        if (typeof value === 'string' && value.trim())
          return value.trim().slice(0, 160)
      }
    }
    return `${globalThis.ForgeI18n?.text('画布') || '画布'} ${canvasId}`
  }

  function getCanvas() {
    const roots = document.querySelectorAll('[data-node-canvas="true"]')
    if (roots.length !== 1) return null
    const root = roots[0]
    const flows = root.querySelectorAll('.react-flow')
    if (flows.length !== 1) return null
    const flow = flows[0]
    const rect = flow.getBoundingClientRect()
    if (rect.width < 20 || rect.height < 20) return null
    const style = getComputedStyle(flow)
    if (style.display === 'none' || style.visibility !== 'visible') return null
    const viewport = flow.querySelector('.react-flow__viewport')
    if (!viewport) return null
    let transform
    try {
      transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
      if (
        !transform.is2D ||
        ![transform.a, transform.d, transform.e, transform.f].every(
          Number.isFinite
        ) ||
        transform.a <= 0 ||
        transform.a !== transform.d ||
        transform.b !== 0 ||
        transform.c !== 0
      )
        return null
    } catch {
      return null
    }
    // Probe readiness, not empty space: the drop targets the canvas root even
    // when a node occupies this point. Keep modal/toolbar checks independent of
    // the sequential rows, which can continue outside the visible viewport.
    for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8]) {
      for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) {
        const x = rect.left + rect.width * fx
        const y = rect.top + rect.height * fy
        const hit = document.elementFromPoint(x, y)
        if (!hit || !flow.contains(hit)) continue
        if (
          hit.closest(
            '.react-flow__panel, button, input, textarea, select, [contenteditable="true"], [role="dialog"]'
          )
        )
          continue
        return { root, flow, rect, transform }
      }
    }
    return null
  }

  function nextPlacement(canvas) {
    const { rect, transform } = canvas
    const layout = grid || {
      x: (rect.width / 2 - transform.e) / transform.a,
      y: (rect.height / 2 - transform.f) / transform.a,
      count: 0,
      rowWidths: [],
      rowHeights: [],
    }
    const row = Math.floor(layout.count / GRID_COLUMNS)
    const previousRowsHeight = layout.rowHeights
      .slice(0, row)
      .reduce((sum, height) => sum + height + GRID_GAP, 0)
    return {
      layout,
      row,
      x: Math.round(
        rect.left +
          transform.e +
          (layout.x + (layout.rowWidths[row] || 0)) * transform.a
      ),
      y: Math.round(
        rect.top + transform.f + (layout.y + previousRowsHeight) * transform.a
      ),
    }
  }

  function reservePlacement(placement) {
    grid = placement.layout
    grid.count++
    grid.rowWidths[placement.row] ||= 0
    grid.rowHeights[placement.row] ||= 0
  }

  function mediaNodeBounds(width, height) {
    // Canvas previews have a constant content area, capped on the long side.
    // Intrinsic pixels and the former 320-wide estimate are not node bounds.
    if (!width || !height)
      return {
        width: MEDIA_MAX_SIDE,
        height: MEDIA_MAX_SIDE + NODE_HEADER_HEIGHT,
      }
    const scale = Math.min(
      Math.sqrt(MEDIA_CONTENT_AREA / (width * height)),
      MEDIA_MAX_SIDE / Math.max(width, height)
    )
    return {
      width: Math.ceil(width * scale),
      height: Math.ceil(height * scale) + NODE_HEADER_HEIGHT,
    }
  }

  function reply(ok, error, extra) {
    return { ok, bridgeVersion, ...(error ? { error } : {}), ...extra }
  }

  function encodePreview(width, height, draw) {
    const scale = Math.min(1, 144 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    draw(context, canvas.width, canvas.height)
    const value = canvas.toDataURL('image/webp', 0.7)
    return value.length <= 100_000 &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
      ? value
      : null
  }

  async function inspectFile(file) {
    let video
    if (file.type.startsWith('video/')) {
      try {
        video = await globalThis.__forgeInspectVideo?.(file, encodePreview)
        if (video?.previewDataUrl) return video
      } catch {
        // The browser's native decoder can still be available.
      }
    }
    return { ...video, ...(await previewFile(file)) }
  }

  // A small, local-only preview of the file already being handed off. This is
  // best effort: decoding a large or unsupported file must never turn a drop
  // that was accepted by the canvas into a failed delivery.
  function previewFile(file) {
    return new Promise((resolve) => {
      let objectUrl
      let media
      let timer
      let done = false
      let dimensions = {}
      const readDimensions = () => {
        const width =
          media.tagName === 'VIDEO' ? media.videoWidth : media.naturalWidth
        const height =
          media.tagName === 'VIDEO' ? media.videoHeight : media.naturalHeight
        if (
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0
        )
          dimensions = { width, height }
      }
      const finish = (preview) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          if (media) {
            media.onload = null
            media.onloadedmetadata = null
            media.onloadeddata = null
            media.onerror = null
            if (media.tagName === 'VIDEO') {
              media.removeAttribute('src')
              media.load()
            }
          }
        } catch {}
        try {
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        } catch {}
        resolve({
          ...dimensions,
          ...(preview ? { previewDataUrl: preview } : {}),
        })
      }
      try {
        const isVideo = file.type.startsWith('video/')
        media = document.createElement(isVideo ? 'video' : 'img')
        if (isVideo) {
          media.preload = 'auto'
          media.muted = true
          media.onloadedmetadata = readDimensions
        }
        const loaded = () => {
          try {
            readDimensions()
            const { width, height } = dimensions
            if (!width || !height) return finish(null)
            finish(
              encodePreview(width, height, (context, w, h) =>
                context.drawImage(media, 0, 0, w, h)
              )
            )
          } catch {
            finish(null)
          }
        }
        media.onerror = () => finish(null)
        if (isVideo) media.onloadeddata = loaded
        else media.onload = loaded
        timer = setTimeout(() => finish(null), 1_000)
        objectUrl = URL.createObjectURL(file)
        media.src = objectUrl
      } catch {
        finish(null)
      }
    })
  }

  // Existing Inkloom upload UI renders the original filename in its toast and
  // then in the new node. Observe only newly added matching elements inside
  // this canvas. Seeing a filename indicates handling started, not success.
  function watchCanvasHandling(root, filename, expectedCanvasId) {
    const matching = () =>
      Array.from(root.querySelectorAll('*')).filter((element) => {
        if (element.matches('input')) return element.value === filename
        return element.children.length === 0 && element.textContent === filename
      })
    const before = new Set(matching())
    let done = false
    let finish
    const promise = new Promise((resolve) => {
      finish = (result) => {
        if (done) return
        done = true
        observer.disconnect()
        clearTimeout(timer)
        resolve(result)
      }
    })
    const check = () => {
      if (currentCanvasId() !== expectedCanvasId || !root.isConnected) {
        finish(false)
        return
      }
      if (matching().some((element) => !before.has(element))) finish(true)
    }
    const observer = new MutationObserver(check)
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['value'],
    })
    const timer = setTimeout(() => finish(false), 5_000)
    return { promise, check, cancel: () => finish(false) }
  }

  function handle(message) {
    const canvasId = currentCanvasId()
    if (!canvasId || message.canvasId !== canvasId) {
      clearTransfer()
      pendingWatcher?.cancel()
      pendingWatcher = null
      sessionId = null
      grid = null
      return reply(false, 'CANVAS_CHANGED')
    }
    if (message.type === 'PING') {
      const canvas = getCanvas()
      return canvas
        ? reply(true, null, {
            canvasId,
            canvasName: canvasName(canvas.root, canvasId),
          })
        : reply(false, 'CANVAS_NOT_READY')
    }
    if (message.type === 'ARM') {
      if (
        typeof message.sessionId !== 'string' ||
        message.sessionId.length < 16 ||
        message.sessionId.length > 128
      )
        return reply(false, 'INVALID_SESSION')
      clearTransfer()
      pendingWatcher?.cancel()
      pendingWatcher = null
      sessionId = message.sessionId
      grid = null
      return reply(true, null, { canvasId })
    }
    if (!sessionId || message.sessionId !== sessionId)
      return reply(false, 'NOT_ARMED')
    if (message.type === 'DISARM') {
      clearTransfer()
      pendingWatcher?.cancel()
      pendingWatcher = null
      sessionId = null
      grid = null
      return reply(true, null, { canvasId })
    }
    if (message.type === 'BEGIN') {
      if (transfer || pendingWatcher) return reply(false, 'BUSY')
      if (
        typeof message.filename !== 'string' ||
        !message.filename ||
        message.filename.length > 255 ||
        typeof message.mime !== 'string' ||
        !/^(image|video)\/[a-z0-9.+-]+$/i.test(message.mime) ||
        !Number.isSafeInteger(message.size) ||
        message.size <= 0 ||
        message.size > MAX_SIZE
      )
        return reply(false, 'INVALID_FILE')
      transfer = {
        id: message.requestId,
        filename: message.filename,
        mime: message.mime,
        size: message.size,
        chunks: [],
        received: 0,
        sequence: 0,
        timer: null,
      }
      renewTimer(transfer)
      return reply(true, null, { canvasId })
    }
    const current = transfer
    if (!current || current.id !== message.requestId)
      return reply(false, 'TRANSFER_NOT_FOUND')
    if (message.type === 'ABORT') {
      clearTransfer()
      return reply(true, null, { canvasId })
    }
    if (message.type === 'CHUNK') {
      if (
        message.sequence !== current.sequence ||
        typeof message.data !== 'string' ||
        !message.data ||
        message.data.length > MAX_ENCODED_CHUNK_LENGTH
      ) {
        clearTransfer()
        return reply(false, 'INVALID_CHUNK')
      }
      try {
        const decoded = atob(message.data)
        if (!decoded.length || current.received + decoded.length > current.size)
          throw new Error('Invalid chunk size')
        const bytes = Uint8Array.from(decoded, (character) =>
          character.charCodeAt(0)
        )
        current.chunks.push(bytes)
        current.received += bytes.length
        current.sequence++
        renewTimer(current)
        return reply(true, null, { canvasId })
      } catch {
        clearTransfer()
        return reply(false, 'INVALID_CHUNK')
      }
    }
    if (message.type === 'END') {
      if (current.received !== current.size) {
        clearTransfer()
        return reply(false, 'INCOMPLETE_FILE')
      }
      const canvas = getCanvas()
      if (!canvas) {
        clearTransfer()
        return reply(false, 'CANVAS_NOT_READY')
      }
      let watcher
      try {
        const file = new File(current.chunks, current.filename, {
          type: current.mime,
        })
        clearTransfer()
        watcher = watchCanvasHandling(canvas.root, file.name, canvasId)
        pendingWatcher = watcher
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(file)
        const placement = nextPlacement(canvas)
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: placement.x,
          clientY: placement.y,
          dataTransfer,
        }
        const dragOver = new DragEvent('dragover', init)
        canvas.flow.dispatchEvent(dragOver)
        if (!dragOver.defaultPrevented) {
          watcher.cancel()
          pendingWatcher = null
          return reply(false, 'DROP_UNAVAILABLE')
        }
        const drop = new DragEvent('drop', init)
        canvas.flow.dispatchEvent(drop)
        if (!drop.defaultPrevented) {
          watcher.cancel()
          pendingWatcher = null
          return reply(false, 'DROP_UNAVAILABLE')
        }
        // Reserve immediately, including when handling cannot be confirmed.
        // A delayed upload must not share its position with the next file.
        reservePlacement(placement)
        const inspection = inspectFile(file)
        watcher.check()
        return watcher.promise
          .then(async (handled) => {
            const { width, height, previewDataUrl } = await inspection
            const bounds = mediaNodeBounds(width, height)
            placement.layout.rowWidths[placement.row] += bounds.width + GRID_GAP
            placement.layout.rowHeights[placement.row] = Math.max(
              placement.layout.rowHeights[placement.row],
              bounds.height
            )
            if (!handled) return reply(false, 'UNKNOWN_DELIVERY')
            return reply(true, null, {
              canvasId,
              delivered: true,
              ...(previewDataUrl ? { previewDataUrl } : {}),
            })
          })
          .finally(() => {
            if (pendingWatcher === watcher) pendingWatcher = null
          })
      } catch {
        watcher?.cancel()
        if (pendingWatcher === watcher) pendingWatcher = null
        clearTransfer()
        return reply(false, 'DROP_UNAVAILABLE')
      }
    }
    return reply(false, 'UNKNOWN_MESSAGE')
  }

  function onMessage(request, sender, sendResponse) {
    if (stopped || request?.kind !== REQUEST_KIND) return
    const payload = request.payload
    if (
      sender?.id !== chrome.runtime.id ||
      !payload ||
      payload.channel !== CHANNEL ||
      payload.from !== 'extension' ||
      typeof payload.requestId !== 'string' ||
      !payload.requestId ||
      payload.requestId.length > 128
    ) {
      sendResponse(reply(false, 'INVALID_REQUEST'))
      return
    }
    try {
      const result = handle(payload)
      if (result && typeof result.then === 'function') {
        result.then(sendResponse, () =>
          sendResponse(reply(false, 'UNKNOWN_DELIVERY'))
        )
        return true
      }
      sendResponse(result)
    } catch {
      clearTransfer()
      sendResponse(reply(false, 'CANVAS_NOT_READY'))
    }
  }
  function stop() {
    stopped = true
    clearTransfer()
    pendingWatcher?.cancel()
    pendingWatcher = null
    sessionId = null
    grid = null
    chrome.runtime.onMessage.removeListener(onMessage)
    if (globalThis.__forgeDropBridge?.stop === stop)
      delete globalThis.__forgeDropBridge
  }
  chrome.runtime.onMessage.addListener(onMessage)
  globalThis.__forgeDropBridge = { version: bridgeVersion, stop }
})()
