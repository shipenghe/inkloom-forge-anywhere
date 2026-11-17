const CHANNEL = 'inkloom-media-import-v1'
const CHUNK_SIZE = 192 * 1024
const MAX_TRANSFER_SIZE = 200 * 1024 * 1024
const CONTEXT_MENU_ID = 'send-media-to-canvas'
const FORGE_HOME_URL = 'https://forge.art/'
const MEDIA_KINDS = ['image', 'video', 'audio']
const SOURCE_PERMISSION_CODES = [
  'VIDEO_SOURCE_PERMISSION',
  'IMAGE_SOURCE_PERMISSION',
  'AUDIO_SOURCE_PERMISSION',
]
const WEIBO_ORIGIN = 'https://weibo.com'
const WEIBO_MEDIA_RULE_ID = 1
if (typeof importScripts === 'function')
  importScripts(
    'i18n-data.js',
    'i18n.js',
    'imagePreflight.js',
    'mseCaptureController.js',
    'hoverMediaController.js',
    'mseRemux.bundle.js',
    'releaseUpdates.js',
    'videoPlayback.js'
  )
const t = (value) => globalThis.ForgeI18n?.text(value) ?? value
void globalThis.inkloomMseController?.recover().catch(() => {})
void globalThis.forgeMediaEntryController?.recover().catch(() => {})
let transfer = null
let targetGeneration = 0
let videoPlaybackWrite = Promise.resolve()
const weiboMediaRuleCleanup = chrome.declarativeNetRequest
  ?.updateSessionRules({ removeRuleIds: [WEIBO_MEDIA_RULE_ID] })
  .catch(() => {})

async function state() {
  return chrome.storage.session.get([
    'target',
    'selection',
    'pickerTabId',
    'lastStatus',
    'lastStatusTabId',
    'lastStatusAt',
    'mseCapture',
    'lastDelivery',
    'mediaActivity',
    'playableVideoId',
  ])
}
async function save(value) {
  return chrome.storage.session.set(value)
}
function storeVideoPlayback(id, file) {
  if (!globalThis.ForgeVideoPlayback) return
  videoPlaybackWrite = videoPlaybackWrite
    .then(async () => {
      let playableVideoId = null
      try {
        await globalThis.ForgeVideoPlayback.replace(id, file)
        if (file) playableVideoId = id
      } catch {
        // A local storage error must never change a successful delivery.
      }
      await save({ playableVideoId })
    })
    .catch(() => {})
}
function safePreview(value) {
  return (
    typeof value === 'string' &&
    value.length <= 100_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}
function activityRecord(selection, status, extra = {}) {
  selection.mediaId ||= crypto.randomUUID()
  return {
    id: selection.mediaId,
    mediaKind: selection.mediaKind,
    status,
    title:
      typeof selection.title === 'string' ? selection.title.slice(0, 160) : '',
    isClip: !!selection.mse,
    updatedAt: Date.now(),
    ...extra,
  }
}
async function updateActivity(id, extra) {
  const { mediaActivity } = await state()
  if (mediaActivity?.id !== id) return
  await save({
    mediaActivity: { ...mediaActivity, ...extra, updatedAt: Date.now() },
  })
}
async function stageSelection(selection) {
  const mediaActivity = activityRecord(selection, 'selected')
  await save({ selection, mediaActivity })
}
async function sourceMetadata(selection) {
  let timer
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(
        selection.tabId,
        {
          kind: 'READ_MEDIA_PREVIEW',
          url: selection.url,
          displayUrl: selection.displayUrl,
          mediaKind: selection.mediaKind,
        },
        selection.documentId
          ? { documentId: selection.documentId }
          : { frameId: selection.frameId ?? 0 }
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 500)
      }),
    ])
    if (!reply?.ok) return {}
    return {
      ...(typeof reply.title === 'string'
        ? { title: reply.title.slice(0, 160) }
        : {}),
      ...(safePreview(reply.previewDataUrl)
        ? { previewDataUrl: reply.previewDataUrl }
        : {}),
      ...(Number.isFinite(reply.duration) && reply.duration > 0
        ? { sourceDuration: reply.duration }
        : {}),
      ...(selection.mediaKind === 'audio' && reply.audioScope === 'preview'
        ? { audioScope: 'preview' }
        : {}),
      ...(selection.mediaKind === 'audio' &&
      Number.isFinite(reply.audioTrackDuration) &&
      reply.audioTrackDuration > 0
        ? { audioTrackDuration: reply.audioTrackDuration }
        : {}),
    }
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}
function extensionPage(sender) {
  return (
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url?.startsWith(chrome.runtime.getURL(''))
  )
}
function userErrorMessage(error) {
  const text =
    typeof error === 'string' ? error : error?.message || String(error)
  if (/https?:\/\/|\btoken\b/i.test(text)) return '发送失败，请重试'
  if (/^Failed to fetch$|^NetworkError\b|^无法获取媒体，可能需要/.test(text))
    return '无法获取素材，请重试'
  if (/^未捕获视频片段|^缺少初始化数据或可用的视频片段/.test(text))
    return '视频尚未准备好'
  if (/^暂不支持此视频分段格式|^暂不支持此音视频编码/.test(text))
    return '不支持该视频格式'
  if (/^视频备用来源尚未授权/.test(text)) return '请打开插件授权'
  return text
}
function resultError(error) {
  return {
    ok: false,
    error: userErrorMessage(error),
    ...(SOURCE_PERMISSION_CODES.includes(error?.code)
      ? { code: error.code }
      : {}),
  }
}
function normalizeVideoCandidates(values, selected) {
  if (!Array.isArray(values)) return []
  const seen = new Set([selected])
  const result = []
  for (const raw of values.slice(0, 10)) {
    if (typeof raw !== 'string' || raw.length > 4096) continue
    try {
      const url = new URL(raw)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        /\.(m4s|m3u8|mpd|ts)$/i.test(url.pathname) ||
        seen.has(url.href)
      )
        continue
      seen.add(url.href)
      result.push(url.href)
      if (result.length === 5) break
    } catch {}
  }
  return result
}

function sameSelection(left, right) {
  return (
    !!left &&
    !!right &&
    left.tabId === right.tabId &&
    left.url === right.url &&
    (left.frameId ?? 0) === (right.frameId ?? 0) &&
    left.documentId === right.documentId
  )
}

async function selectionPreview(expected) {
  const { selection } = await state()
  if (!sameSelection(selection, expected)) return { ok: true, selection: null }
  const result = { ...selection }
  try {
    // The popup loads immediately. Read a thumbnail separately from the exact
    // source document, without requesting URL access or fetching media bytes.
    await chrome.scripting.executeScript({
      target: {
        tabId: selection.tabId,
        ...(selection.documentId
          ? { documentIds: [selection.documentId] }
          : { frameIds: [selection.frameId ?? 0] }),
      },
      files: ['source.js'],
    })
    const preview = await chrome.tabs.sendMessage(
      selection.tabId,
      {
        kind: 'READ_MEDIA_PREVIEW',
        url: selection.url,
        displayUrl: selection.displayUrl,
        mediaKind: selection.mediaKind,
      },
      selection.documentId
        ? { documentId: selection.documentId }
        : { frameId: selection.frameId ?? 0 }
    )
    if (preview?.ok) {
      if (typeof preview.title === 'string')
        result.title = preview.title.slice(0, 160)
      if (
        typeof preview.previewDataUrl === 'string' &&
        preview.previewDataUrl.length <= 100_000 &&
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          preview.previewDataUrl
        )
      )
        result.previewDataUrl = preview.previewDataUrl
    }
  } catch {
    // A closed page or unreadable pixels must not block selecting or sending.
  }
  if (!sameSelection((await state()).selection, selection))
    return { ok: true, selection: null }
  if (selection.mediaId)
    await updateActivity(selection.mediaId, {
      ...(result.title ? { title: result.title } : {}),
      ...(safePreview(result.previewDataUrl)
        ? { previewDataUrl: result.previewDataUrl }
        : {}),
    }).catch(() => {})
  return { ok: true, selection: result }
}

async function refreshContextMenu() {
  await globalThis.ForgeI18n?.ready
  const generation = targetGeneration
  const { target } = await state()
  if (generation !== targetGeneration) return
  try {
    await chrome.contextMenus.update(CONTEXT_MENU_ID, {
      enabled: true,
      visible: true,
      title: t(target ? '发送到画布' : '打开 Forge'),
      contexts: [...MEDIA_KINDS, 'link'],
    })
  } catch {
    // The menu may not yet exist while the extension is being installed.
  }
}

async function invalidateTarget(tabId, changeInfo, expectedSessionId) {
  const generation = targetGeneration
  const { target } = await state()
  if (
    generation !== targetGeneration ||
    !target ||
    target.tabId !== tabId ||
    (expectedSessionId && target.sessionId !== expectedSessionId)
  )
    return
  if (
    changeInfo &&
    changeInfo.status !== 'loading' &&
    (!changeInfo.url || targetUrl(changeInfo.url) === target.canvasId)
  )
    return
  targetGeneration++
  await save({ target: null })
  await refreshContextMenu()
}

async function contextStatus(tabId, message, failed) {
  await globalThis.ForgeI18n?.ready
  const text = (failed ? userErrorMessage(message) : String(message)).slice(
    0,
    240
  )
  const { selection } = await state()
  await Promise.allSettled([
    save({
      lastStatus: text,
      lastStatusTabId: tabId,
      lastStatusAt: Date.now(),
    }),
    chrome.action.setBadgeText({ text: failed ? '!' : selection ? '1' : '' }),
    chrome.action.setBadgeBackgroundColor({
      color: failed ? '#d93025' : '#1a73e8',
    }),
    chrome.scripting.executeScript({
      target: { tabId },
      func: (value, isError) => {
        const id = '__inkloom_context_status'
        document.getElementById(id)?.remove()
        const node = document.createElement('div')
        node.id = id
        node.setAttribute('role', 'status')
        node.textContent = value
        node.style.cssText = `position:fixed;right:20px;top:20px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:8px;box-shadow:0 4px 20px #0003;font:14px/1.5 system-ui,sans-serif;color:white;background:${
          isError ? '#9b1c1c' : '#303945'
        }`
        document.documentElement.appendChild(node)
        setTimeout(
          () => node.remove(),
          isError || value.length > 35 ? 10000 : 5000
        )
      },
      args: [t(text), failed],
    }),
  ])
}

function targetUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  const host = url.hostname
  const allowed = ['tusi.cn', 'tusiart.cn', 'tensor.art', 'forge.art'].some(
    (domain) => host === domain || host.endsWith('.' + domain)
  )
  if (!allowed && !local) return null
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (!local && url.protocol !== 'https:')
  )
    return null
  const match = url.pathname.match(/^\/detail\/([^/]+)\/?$/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
async function sendTarget(target, type, requestId, extra = {}) {
  if (!target) throw new Error('请先设置接收画布')
  if (!target.documentId) throw new Error('接收画布已断开，请重新设置')
  let response
  try {
    response = await chrome.tabs.sendMessage(
      target.tabId,
      {
        kind: 'FORGE_DROP_REQUEST_V2',
        payload: {
          channel: CHANNEL,
          from: 'extension',
          type,
          requestId,
          canvasId: target.canvasId,
          sessionId: target.sessionId,
          ...extra,
        },
      },
      { documentId: target.documentId }
    )
  } catch {
    throw new Error(
      type === 'END'
        ? '结果未知，先检查画布'
        : '接收画布已关闭或发生变化，请重新设置'
    )
  }
  if (
    response &&
    response.bridgeVersion !== chrome.runtime.getManifest().version
  )
    throw new Error(
      type === 'END'
        ? '结果未知，先检查画布'
        : '无法连接画布，请刷新画布后重新设置'
    )
  if (!response?.ok) {
    const messages = {
      CANVAS_CHANGED: '接收画布已切换，请重新设置',
      CANVAS_NOT_READY: '接收画布尚未就绪，请重新设置',
      NOT_ARMED: '接收画布已断开，请重新设置',
      INVALID_FILE: '媒体大小或格式不受支持',
      BUSY: '画布正在处理其他导入，请稍后重试',
      TRANSFER_NOT_FOUND: '媒体传输已中断，请重试',
      INCOMPLETE_FILE: '媒体传输不完整，请重试',
      INVALID_CHUNK: '媒体传输数据无效，请重试',
      DROP_UNAVAILABLE: '画布当前不能接收拖放，请退出引用选择或关闭遮挡后重试',
      UNKNOWN_DELIVERY: '结果未知，先检查画布',
    }
    throw new Error(
      messages[response?.error] ||
        (type === 'END'
          ? '结果未知，先检查画布'
          : '接收画布未响应，请检查画布后重试')
    )
  }
  if (response.canvasId !== target.canvasId)
    throw new Error(
      type === 'END' ? '结果未知，先检查画布' : '接收画布已切换，请重新设置'
    )
  if (type === 'END' && response.delivered !== true)
    throw new Error('结果未知，先检查画布')
  if (type === 'END' && transfer?.id === requestId && transfer.filename) {
    const preview = response.previewDataUrl
    const lastDelivery = {
      mediaKind: transfer.selection.mediaKind,
      filename: transfer.filename,
      canvasName: target.title || '画布',
      timestamp: Date.now(),
      ...(typeof preview === 'string' &&
      preview.length <= 100_000 &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        preview
      )
        ? { previewDataUrl: preview }
        : {}),
    }
    // A history write must never turn a completed handoff into a failure.
    transfer.previewDataUrl = lastDelivery.previewDataUrl
    await save({ lastDelivery }).catch(() => {})
  }
  return response
}
async function currentTarget() {
  const { target } = await state()
  if (!target) throw new Error('请先设置接收画布')
  try {
    await sendTarget(target, 'PING', crypto.randomUUID())
  } catch (error) {
    await invalidateTarget(target.tabId, undefined, target.sessionId)
    throw error
  }
  return target
}
function inferMime(blobType, url, mediaKind) {
  if (mediaKind === 'audio') return 'audio/x-unknown'
  if (/^(image|video)\//i.test(blobType || '')) return blobType.toLowerCase()
  let path = ''
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {}
  const suffix = path.match(/\.([a-z0-9]+)$/)?.[1]
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
  }
  const mime = types[suffix]
  if (mime && mime.startsWith(mediaKind + '/')) return mime
  throw new Error('无法识别媒体文件类型，请尝试其他素材')
}
function fileName(mime) {
  const type = mime.split('/', 1)[0]
  const mediaType = type[0].toUpperCase() + type.slice(1)
  return `FA ${mediaType} ${Date.now()}`
}
function encode(bytes) {
  let value = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    value += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(value)
}
async function beginTransfer(t, size, mime) {
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error('媒体文件为空或大小无效')
  t.mime = inferMime(mime, t.selection.url, t.selection.mediaKind)
  if (!t.mime.startsWith(t.selection.mediaKind + '/'))
    throw new Error('获取到的文件类型与所选素材不符')
  t.filename = fileName(t.mime)
  const response = await sendTarget(t.target, 'BEGIN', t.id, {
    filename: t.filename,
    mime: t.mime,
    size,
  })
  t.begun = true
  return response
}
async function abortTransfer(t) {
  if (t?.begun) await sendTarget(t.target, 'ABORT', t.id).catch(() => {})
}
async function deliverBlob(t, blob, mime = blob.type) {
  if (t.selection.mediaKind === 'audio') blob = await prepareAudio(t, blob)
  await beginTransfer(t, blob.size, mime)
  let sequence = 0
  for (let start = 0; start < blob.size; start += CHUNK_SIZE) {
    const bytes = new Uint8Array(
      await blob.slice(start, start + CHUNK_SIZE).arrayBuffer()
    )
    await sendTarget(t.target, 'CHUNK', t.id, {
      sequence: sequence++,
      data: encode(bytes),
    })
  }
  const result = await finishDelivery(t)
  if (t.selection.mediaKind !== 'image') t.playbackFile = blob
  return result
}
async function prepareAudio(t, blob) {
  const audio = await globalThis.__forgeInspectAudio(blob)
  if (!audio) throw new Error('不支持该音频格式或音频不完整')
  t.audio = audio
  return blob.slice(0, blob.size, audio.mime)
}
function finishDelivery(t) {
  return sendTarget(
    t.target,
    'END',
    t.id,
    t.audio ? { mime: t.audio.mime } : {}
  )
}
async function boundedBlob(response, mediaKind) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_TRANSFER_SIZE) throw new Error('媒体文件过大，无法导入')
  if (!response.body) throw new Error('无法读取媒体数据')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  const header = new Uint8Array(32)
  let headerSize = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_TRANSFER_SIZE) {
        await reader.cancel()
        throw new Error('媒体文件过大，无法导入')
      }
      if (mediaKind === 'image' && headerSize < header.length) {
        const part = value.subarray(0, header.length - headerSize)
        header.set(part, headerSize)
        headerSize += part.length
        if (headerSize === header.length) {
          const format = globalThis.__inkloomImagePreflight.formatOf(header)
          if (!['jpeg', 'png', 'webp'].includes(format)) {
            await reader.cancel().catch(() => {})
            await globalThis.__inkloomImagePreflight.validate(
              new Blob([header])
            )
          }
        }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new Blob(chunks, {
    type: response.headers.get('content-type')?.split(';')[0] || '',
  })
}
async function completeMp4(blob) {
  let offset = 0
  let moov = false
  let mdat = false
  while (offset < blob.size) {
    const bytes = new Uint8Array(
      await blob.slice(offset, offset + 16).arrayBuffer()
    )
    if (bytes.length < 8) return false
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let size = view.getUint32(0)
    const type = String.fromCharCode(...bytes.slice(4, 8))
    // A standalone MSE fragment can contain initialization boxes and mdat;
    // do not misrepresent such fragments as a complete video.
    if (type === 'moof') return false
    let header = 8
    if (size === 1) {
      if (bytes.length < 16) return false
      size = view.getUint32(8) * 0x100000000 + view.getUint32(12)
      header = 16
    } else if (size === 0) size = blob.size - offset
    if (
      !Number.isSafeInteger(size) ||
      size < header ||
      size > blob.size - offset
    )
      return false
    if (type === 'moov') moov = true
    if (type === 'mdat' && size > header) mdat = true
    offset += size
  }
  return moov && mdat
}
async function ebmlElement(blob, offset, end) {
  const data = new Uint8Array(
    await blob.slice(offset, Math.min(offset + 12, end)).arrayBuffer()
  )
  if (data.length < 2) return null
  const width = (byte) => {
    for (let i = 1; i <= 8; i++) if (byte & (0x80 >> (i - 1))) return i
    return 0
  }
  const idWidth = width(data[0])
  if (!idWidth || idWidth > 4 || data.length <= idWidth) return null
  const sizeWidth = width(data[idWidth])
  if (!sizeWidth || data.length < idWidth + sizeWidth) return null
  let id = 0
  for (let i = 0; i < idWidth; i++) id = id * 256 + data[i]
  let size = data[idWidth] & (0xff >> sizeWidth)
  let unknown = size === 0xff >> sizeWidth
  for (let i = 1; i < sizeWidth; i++) {
    size = size * 256 + data[idWidth + i]
    unknown = unknown && data[idWidth + i] === 0xff
  }
  const start = offset + idWidth + sizeWidth
  if (unknown || !Number.isSafeInteger(size) || start + size > end) return null
  return { id, start, end: start + size }
}
async function completeWebm(blob) {
  const header = await ebmlElement(blob, 0, blob.size)
  if (!header || header.id !== 0x1a45dfa3) return false
  const segment = await ebmlElement(blob, header.end, blob.size)
  if (!segment || segment.id !== 0x18538067 || segment.end !== blob.size)
    return false
  let offset = segment.start
  let tracks = false
  let cluster = false
  while (offset < segment.end) {
    const element = await ebmlElement(blob, offset, segment.end)
    if (!element) return false
    if (element.id === 0x1654ae6b && element.end > element.start) tracks = true
    if (element.id === 0x1f43b675 && element.end > element.start) cluster = true
    offset = element.end
  }
  return tracks && cluster
}
async function checkedVideoResponse(response) {
  if (!response.ok) throw new Error(`无法获取媒体（HTTP ${response.status}）`)
  if (response.status === 206 || response.headers.get('content-range'))
    throw new Error('获取到的视频不完整')
  const type = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (
    type &&
    ![
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'application/octet-stream',
    ].includes(type)
  )
    throw new Error('获取到的内容不是受支持的视频')
  const blob = await boundedBlob(response)
  const encoding = response.headers.get('content-encoding')
  const length = response.headers.get('content-length')
  if (
    (!encoding || encoding === 'identity') &&
    length !== null &&
    Number(length) !== blob.size
  )
    throw new Error('获取到的视频不完整')
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const mp4 =
    head.length >= 12 && String.fromCharCode(...head.slice(4, 8)) === 'ftyp'
  const webm =
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  if (
    (mp4 && (await completeMp4(blob))) ||
    (webm && (await completeWebm(blob)))
  )
    return new Blob([blob], {
      type: webm
        ? 'video/webm'
        : type === 'video/quicktime'
        ? type
        : 'video/mp4',
    })
  throw new Error('视频格式不受支持或数据不完整')
}
function isWeiboPage(raw) {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.origin === WEIBO_ORIGIN || url.origin === 'https://www.weibo.com')
    )
  } catch {
    return false
  }
}
async function fetchSelectedMedia(url, selection) {
  const options = { credentials: 'include' }
  const rules = chrome.declarativeNetRequest
  const weiboCdn =
    selection.mediaKind === 'image'
      ? /(?:^|\.)sinaimg\.cn$/.test(url.hostname)
      : /(?:^|\.)video\.weibocdn\.com$/.test(url.hostname)
  if (
    !rules ||
    !selection.weiboPage ||
    selection.mediaKind === 'audio' ||
    !weiboCdn ||
    url.protocol !== 'https:' ||
    url.port
  )
    return fetch(url.href, options)

  await weiboMediaRuleCleanup
  const removeRuleIds = [WEIBO_MEDIA_RULE_ID]
  // Weibo's media servers expect the site's origin on requests for a selected
  // file. Apply it only to this extension's request for that exact URL.
  const requestUrl = url.href.split('#', 1)[0]
  const regexFilter =
    '^' + requestUrl.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '$'
  try {
    await rules.updateSessionRules({
      removeRuleIds,
      addRules: [
        {
          id: WEIBO_MEDIA_RULE_ID,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'Referer',
                operation: 'set',
                value: WEIBO_ORIGIN + '/',
              },
            ],
          },
          condition: {
            regexFilter,
            isUrlFilterCaseSensitive: true,
            initiatorDomains: [chrome.runtime.id],
            requestMethods: ['get'],
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    })
  } catch {
    return fetch(url.href, options)
  }
  try {
    return await fetch(requestUrl, {
      ...options,
      redirect: 'error',
    })
  } finally {
    await rules.updateSessionRules({ removeRuleIds }).catch(() => {})
  }
}
async function alternateVideo(selection) {
  let missingPermission = false
  for (const raw of normalizeVideoCandidates(
    selection.videoCandidates,
    selection.url
  )) {
    const url = new URL(raw)
    const origins = [`${url.protocol}//${url.hostname}/*`]
    if (!(await chrome.permissions.contains({ origins }))) {
      missingPermission = true
      continue
    }
    try {
      const response = await fetchSelectedMedia(url, selection)
      return await checkedVideoResponse(response)
    } catch {
      // Try the next source only before a transfer is started.
    }
  }
  if (missingPermission) {
    const error = new Error(
      '视频备用来源尚未授权，请在插件中选取视频并授权后重试'
    )
    error.code = 'VIDEO_SOURCE_PERMISSION'
    throw error
  }
  throw new Error('无法获取完整视频，网站可能使用分段播放或限制访问')
}
function lockTransfer() {
  if (transfer) throw new Error('正在导入素材，请稍后重试')
  const t = {
    id: crypto.randomUUID(),
    target: null,
    selection: null,
    begun: false,
  }
  transfer = t
  return t
}

async function captureRequest(capture, kind, extra = {}) {
  let response
  try {
    response = await chrome.tabs.sendMessage(
      capture.tabId,
      { kind, ...extra },
      { documentId: capture.documentId }
    )
  } catch {
    throw new Error('分段采集页面已关闭或刷新，请重新开启采集')
  }
  if (!response?.ok) {
    const error =
      typeof response?.error === 'string' &&
      response.error.length <= 160 &&
      !/https?:\/\/|\btoken\b/i.test(response.error)
        ? response.error
        : '分段采集失败'
    throw new Error(error)
  }
  return response.value
}

async function automaticCaptureFor(selection) {
  if (selection.mediaKind !== 'video' || selection.frameId > 0) return null
  const controller = globalThis.inkloomMseController
  if (!(await controller?.autoEnabled?.())) return null
  let capture = await controller.getAutoCapture(selection.tabId)
  if (!capture) {
    // Give a just-created player a chance to complete its authorization.
    try {
      await chrome.tabs.sendMessage(
        selection.tabId,
        { kind: 'MSE_STATUS' },
        { frameId: 0 }
      )
    } catch {}
    capture = await controller.getAutoCapture(selection.tabId)
  }
  return capture?.auto &&
    capture.phase === 'active' &&
    (!selection.documentId || capture.documentId === selection.documentId)
    ? capture
    : null
}

async function importCapturedVideo(t, capture) {
  const snapshot = await captureRequest(capture, 'MSE_SNAPSHOT')
  t.mseFrozen = true
  const limit = 64 * 1024 * 1024
  if (
    !snapshot ||
    !Array.isArray(snapshot.tracks) ||
    snapshot.tracks.length < 1 ||
    snapshot.tracks.length > 2 ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size <= 0 ||
    snapshot.size > limit
  )
    throw new Error('采集的视频数据无效或过大，请重新采集')
  let size = 0
  let parts = 0
  const streams = []
  for (let trackIndex = 0; trackIndex < snapshot.tracks.length; trackIndex++) {
    const track = snapshot.tracks[trackIndex]
    if (
      typeof track?.mime !== 'string' ||
      !/^(video|audio)\/mp4(?:;|$)/i.test(track.mime) ||
      !Number.isFinite(track.timestampOffset) ||
      Math.abs(track.timestampOffset) > 31536000 ||
      !Number.isFinite(track.appendWindowStart) ||
      track.appendWindowStart < 0 ||
      track.appendWindowStart > 31536000 ||
      (track.appendWindowEnd !== null &&
        (!Number.isFinite(track.appendWindowEnd) ||
          track.appendWindowEnd <= track.appendWindowStart ||
          track.appendWindowEnd > 31536000)) ||
      !Array.isArray(track.parts) ||
      !track.parts.length
    )
      throw new Error('暂不支持此视频分段格式')
    const chunks = []
    for (let partIndex = 0; partIndex < track.parts.length; partIndex++) {
      const length = track.parts[partIndex]
      if (
        !Number.isSafeInteger(length) ||
        length <= 0 ||
        (size += length) > limit ||
        ++parts > 4096
      )
        throw new Error('采集的视频数据无效或过大，请重新采集')
      for (let offset = 0; offset < length; offset += CHUNK_SIZE) {
        const expected = Math.min(CHUNK_SIZE, length - offset)
        const data = await captureRequest(capture, 'MSE_READ', {
          track: trackIndex,
          part: partIndex,
          offset,
          length: expected,
        })
        if (
          typeof data !== 'string' ||
          data.length > Math.ceil(expected / 3) * 4 + 4
        )
          throw new Error('采集的视频片段数据无效')
        let decoded
        try {
          decoded = atob(data)
        } catch {
          throw new Error('采集的视频片段数据无效')
        }
        if (decoded.length !== expected)
          throw new Error('采集的视频片段数据不完整')
        const bytes = new Uint8Array(expected)
        for (let i = 0; i < expected; i++) bytes[i] = decoded.charCodeAt(i)
        chunks.push(bytes)
      }
    }
    streams.push({
      mime: track.mime,
      chunks,
      timestampOffset: track.timestampOffset,
      appendWindowStart: track.appendWindowStart,
      appendWindowEnd: track.appendWindowEnd,
    })
  }
  if (size !== snapshot.size) throw new Error('采集的视频片段数据不完整')
  if (!globalThis.__inkloomMseRemux)
    throw new Error('视频组装模块未加载，请重新加载插件')
  const clip = await globalThis.__inkloomMseRemux.remuxCapturedVideo(streams, {
    requireAudio: streams.some((stream) => /^audio\//i.test(stream.mime)),
  })
  if (!(clip.blob instanceof Blob) || !clip.blob.size || clip.blob.size > limit)
    throw new Error('组装的视频片段无效或过大')
  t.clipRange = {
    isClip: true,
    hasAudio: clip.hasAudio,
    ...(Number.isFinite(clip.sourceStart) &&
    Number.isFinite(clip.sourceEnd) &&
    clip.sourceEnd > clip.sourceStart
      ? { sourceStart: clip.sourceStart, sourceEnd: clip.sourceEnd }
      : {}),
  }
  await updateActivity(t.selection.mediaId, t.clipRange).catch(() => {})
  await deliverBlob(t, clip.blob, 'video/mp4')
  return clip.hasAudio
}
async function tryPageMedia(selection, t) {
  if (selection.mediaKind === 'video' || !/^https?:/i.test(selection.url))
    return false
  const audio = selection.mediaKind === 'audio'
  let response
  try {
    response = await chrome.tabs.sendMessage(
      selection.tabId,
      {
        kind: audio ? 'READ_CACHED_AUDIO' : 'READ_DISPLAYED_IMAGE',
        url: selection.url,
        displayUrl: selection.displayUrl,
        transferId: t.id,
        mediaKind: selection.mediaKind,
      },
      selection.documentId
        ? { documentId: selection.documentId }
        : selection.frameId === undefined
        ? undefined
        : { frameId: selection.frameId }
    )
  } catch {
    if (t.begun) throw new Error('结果未知，先检查画布')
    return false
  }
  if (response?.ok) return true
  if (
    response?.code ===
    (audio ? 'CACHED_AUDIO_UNAVAILABLE' : 'DISPLAYED_IMAGE_UNAVAILABLE')
  )
    return false
  throw new Error(response?.error || (audio ? '读取音频失败' : '读取图片失败'))
}
async function runImport(contextSelection, existingTransfer) {
  const t = existingTransfer || lockTransfer()
  try {
    let selection = contextSelection || (await state()).selection
    if (!selection) throw new Error('请先在网页选择素材')
    t.selection = selection
    const mediaActivity = activityRecord(selection, 'sending')
    const prior = (await state()).mediaActivity
    if (prior?.id === mediaActivity.id) {
      if (safePreview(prior.previewDataUrl))
        mediaActivity.previewDataUrl = prior.previewDataUrl
      mediaActivity.title ||= prior.title || ''
    }
    await save({ mediaActivity, ...(!contextSelection ? { selection } : {}) })
    const { audioTrackDuration, ...metadata } = await sourceMetadata(selection)
    await updateActivity(selection.mediaId, metadata).catch(() => {})
    const target = await currentTarget()
    t.target = target
    t.selection = selection
    let clipHasAudio
    if (selection.mse) {
      const capture = (await state()).mseCapture
      if (
        !capture ||
        capture.phase !== 'active' ||
        capture.tabId !== selection.tabId ||
        capture.documentId !== selection.documentId
      )
        throw new Error('分段采集已断开，请重新开启并选择视频')
      clipHasAudio = await importCapturedVideo(t, capture)
      await globalThis.inkloomMseController.stop().catch(() => {})
    } else if (await tryPageMedia(selection, t)) {
      // The source page already delivered the image or cached audio.
    } else if (selection.url.startsWith('blob:')) {
      let result
      try {
        result = await chrome.tabs.sendMessage(
          selection.tabId,
          {
            kind: 'READ_BLOB',
            url: selection.url,
            transferId: t.id,
            mediaKind: selection.mediaKind,
          },
          selection.documentId
            ? { documentId: selection.documentId }
            : selection.frameId === undefined
            ? undefined
            : { frameId: selection.frameId }
        )
      } catch {
        throw new Error('来源网页已关闭或素材不可读取，请重新选择')
      }
      if (!result?.ok) {
        if (
          result?.code !== 'VIDEO_BLOB_UNAVAILABLE' ||
          selection.mediaKind !== 'video' ||
          t.begun
        )
          throw new Error(result?.error || '网页媒体不可读取')
        let blob
        let completeError
        try {
          blob = await alternateVideo(selection)
        } catch (error) {
          completeError = error
        }
        if (blob) {
          await deliverBlob(t, blob)
        } else {
          const capture = await automaticCaptureFor(selection)
          if (!capture) {
            const controller = globalThis.inkloomMseController
            const denied = await controller?.getAutoDenial?.(selection.tabId)
            if (denied?.reason === 'CAPTURE_LIMIT')
              throw new Error('视频页过多，请关闭其他视频页后刷新')
            if (
              completeError?.code !== 'VIDEO_SOURCE_PERMISSION' &&
              (await controller?.autoEnabled?.())
            )
              throw new Error('未捕获视频片段，请刷新网页后重试')
            throw completeError
          }
          t.autoCapture = capture
          await captureRequest(capture, 'MSE_SELECT', { url: selection.url })
          selection = {
            ...selection,
            mse: true,
            documentId: capture.documentId,
          }
          t.selection = selection
          clipHasAudio = await importCapturedVideo(t, capture)
        }
      }
    } else {
      const url = new URL(selection.url)
      if (!['http:', 'https:', 'data:'].includes(url.protocol))
        throw new Error('不支持该素材的地址类型')
      if (
        selection.mediaKind !== 'video' &&
        ['http:', 'https:'].includes(url.protocol) &&
        !(await chrome.permissions.contains({
          origins: [`${url.protocol}//${url.hostname}/*`],
        }))
      ) {
        const error = new Error('请授权素材来源')
        error.code =
          selection.mediaKind === 'audio'
            ? 'AUDIO_SOURCE_PERMISSION'
            : 'IMAGE_SOURCE_PERMISSION'
        throw error
      }
      let blob
      try {
        let response
        try {
          response = await fetchSelectedMedia(url, selection)
        } catch {
          throw new Error(
            '无法获取媒体，可能需要网站权限、登录或该网站禁止访问'
          )
        }
        if (selection.mediaKind === 'video')
          blob = await checkedVideoResponse(response)
        else {
          if (!response.ok)
            throw new Error(`无法获取媒体（HTTP ${response.status}）`)
          const audio = selection.mediaKind === 'audio'
          if (
            audio &&
            (response.status === 206 || response.headers.get('content-range'))
          )
            throw new Error('获取到的音频不完整')
          blob = await boundedBlob(response, selection.mediaKind)
          const length = response.headers.get('content-length')
          if (
            audio &&
            length !== null &&
            !response.headers.get('content-encoding') &&
            Number(length) !== blob.size
          )
            throw new Error('获取到的音频不完整')
        }
      } catch (error) {
        if (
          selection.mediaKind !== 'video' ||
          !selection.videoCandidates?.length
        )
          throw error
        blob = await alternateVideo(selection)
      }
      if (selection.mediaKind === 'image')
        await globalThis.__inkloomImagePreflight.validate(blob)
      await deliverBlob(t, blob)
    }
    if (!contextSelection || (selection.mse && !t.autoCapture))
      await save({
        selection: null,
        lastStatus: '',
        lastStatusTabId: null,
        lastStatusAt: null,
      })
    const remainingSelection = (await state()).selection
    await chrome.action.setBadgeText({ text: remainingSelection ? '1' : '' })
    if (remainingSelection)
      await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' })
    const type =
      selection.mediaKind === 'image'
        ? '图片'
        : selection.mediaKind === 'audio'
        ? '音频'
        : selection.mse
        ? '视频片段'
        : '视频'
    const fullTrack =
      Number.isFinite(t.audio?.duration) &&
      Number.isFinite(audioTrackDuration) &&
      Math.abs(t.audio.duration - audioTrackDuration) <= 1
    await updateActivity(selection.mediaId, {
      status: 'sent',
      filename: t.filename,
      canvasName: target.title,
      ...(t.previewDataUrl ? { previewDataUrl: t.previewDataUrl } : {}),
      ...(t.audio && {
        duration:
          Number.isFinite(t.audio.duration) && t.audio.duration > 0
            ? t.audio.duration
            : metadata.sourceDuration,
        ...(fullTrack && !metadata.audioScope ? { audioScope: 'full' } : {}),
      }),
      ...(t.clipRange || {
        isClip: false,
        ...(metadata.sourceDuration
          ? { sourceStart: 0, sourceEnd: metadata.sourceDuration }
          : {}),
      }),
      message: '已交给画布',
    }).catch(() => {})
    storeVideoPlayback(selection.mediaId, t.playbackFile)
    return {
      ok: true,
      message: `${type}已交给画布${
        selection.mse && !clipHasAudio ? '（无声）' : ''
      }`,
    }
  } catch (error) {
    if (t.selection?.mediaId)
      await updateActivity(t.selection.mediaId, {
        status: 'failed',
        message: userErrorMessage(error).slice(0, 160),
      }).catch(() => {})
    await abortTransfer(t)
    if (t.mseFrozen && !t.autoCapture) {
      await globalThis.inkloomMseController.stop().catch(() => {})
      await save({ selection: null }).catch(() => {})
      if (!t.begun)
        throw new Error(
          `${error?.message || '视频片段组装失败'}，请重新启用采集并选择视频`
        )
    }
    throw error
  } finally {
    if (t.autoCapture)
      await captureRequest(t.autoCapture, 'MSE_RELEASE').catch(() => {})
    if (transfer === t) transfer = null
  }
}

async function contextSelection(info, tab) {
  if (!tab?.id) throw new Error('无法识别选中的媒体')
  const linked = !MEDIA_KINDS.includes(info.mediaType)
  if (
    linked &&
    (typeof info.linkUrl !== 'string' || !/^https?:/i.test(info.linkUrl))
  )
    throw new Error('无法识别链接中的素材，请在插件中选取')
  if (
    !linked &&
    (typeof info.srcUrl !== 'string' ||
      !/^(https?:|blob:|data:)/i.test(info.srcUrl))
  )
    throw new Error('无法读取该媒体，请选择其他素材')
  const frameId = info.frameId ?? 0
  const target = { tabId: tab.id, frameIds: [frameId] }
  const pageUrl =
    info.frameUrl || (frameId === 0 ? info.pageUrl || tab.url : '')
  const weiboPage = isWeiboPage(pageUrl)
  try {
    await chrome.scripting.executeScript({
      target,
      files: [
        'imagePreflight.js',
        'source.js',
        'mediaFallback.js',
        'videoCandidates.js',
        ...(linked ? ['linkCandidate.js'] : []),
      ],
    })
  } catch {
    throw new Error('无法访问媒体所在页面或嵌入区域')
  }
  // A previous picker selection may point at a different element with the
  // same URL. Context menus provide no clicked element identity, so discard it
  // when resolving the native menu selection by URL.
  try {
    await chrome.scripting.executeScript({
      target,
      func: () => {
        delete globalThis.__inkloomSelectedImage
        delete globalThis.__inkloomSelectedVideo
      },
    })
  } catch {}
  if (linked) {
    let candidate
    try {
      const results = await chrome.scripting.executeScript({
        target,
        func: (linkUrl) =>
          globalThis.__inkloomLinkedMedia?.linkedMedia(linkUrl) || null,
        args: [info.linkUrl],
      })
      candidate = results[0]?.result
    } catch {}
    if (
      !candidate ||
      !MEDIA_KINDS.includes(candidate.mediaKind) ||
      typeof candidate.url !== 'string' ||
      !/^(https?:|blob:|data:)/i.test(candidate.url)
    )
      throw new Error('无法唯一确定链接里的素材，请在插件中选取')
    return {
      tabId: tab.id,
      title: (tab.title || '').slice(0, 160),
      frameId,
      ...(weiboPage ? { weiboPage } : {}),
      url: candidate.url,
      mediaKind: candidate.mediaKind,
      ...(candidate.mediaKind === 'image' && candidate.displayUrl
        ? { displayUrl: candidate.displayUrl }
        : {}),
      linkedImage: candidate.mediaKind === 'image',
      videoCandidates:
        candidate.mediaKind === 'video'
          ? normalizeVideoCandidates(candidate.videoCandidates, candidate.url)
          : [],
    }
  }
  let url = info.srcUrl
  let videoCandidates = []
  if (info.mediaType === 'image') {
    try {
      const results = await chrome.scripting.executeScript({
        target,
        func: (srcUrl) => {
          const matches = [...document.querySelectorAll('img')].filter(
            (image) => image.currentSrc === srcUrl || image.src === srcUrl
          )
          if (matches.length !== 1) return srcUrl
          return (
            globalThis.__inkloomMediaFallback?.imageUrl(matches[0]) || srcUrl
          )
        },
        args: [url],
      })
      const fallback = results[0]?.result
      // The original right-click gesture only authorized the selected source's
      // origin. Never fetch an alternate CDN without its own permission.
      if (typeof fallback === 'string' && fallback !== url) {
        const original = new URL(url)
        const alternate = new URL(fallback)
        if (original.origin === alternate.origin) url = fallback
      }
    } catch {
      // The exact browser-selected resource remains the safe fallback.
    }
  } else if (info.mediaType === 'video') {
    try {
      const results = await chrome.scripting.executeScript({
        target,
        func: (srcUrl) => {
          const matches = [...document.querySelectorAll('video')].filter(
            (video) => video.currentSrc === srcUrl || video.src === srcUrl
          )
          if (matches.length !== 1) return []
          return (
            globalThis.__inkloomVideoCandidates?.videoCandidates(matches[0]) ||
            []
          )
        },
        args: [url],
      })
      videoCandidates = normalizeVideoCandidates(results[0]?.result, url)
    } catch {
      // If the clicked video cannot be identified, use only its original source.
    }
  }
  return {
    tabId: tab.id,
    title: (tab.title || '').slice(0, 160),
    frameId,
    ...(weiboPage ? { weiboPage } : {}),
    url,
    mediaKind: info.mediaType,
    ...(info.mediaType === 'image' ? { displayUrl: info.srcUrl } : {}),
    linkedImage: info.mediaType === 'image' && typeof info.linkUrl === 'string',
    videoCandidates,
  }
}

async function sendFromContextMenu(info, tab) {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return
  try {
    if (!(await state()).target) {
      await openForge()
      return
    }
  } catch {
    await contextStatus(tab.id, '操作失败，请重试', true)
    return
  }
  let t
  try {
    t = lockTransfer()
  } catch (error) {
    void contextStatus(tab.id, error.message, true)
    return
  }
  let permission
  const linked =
    !MEDIA_KINDS.includes(info.mediaType) && typeof info.linkUrl === 'string'
  try {
    if (linked) {
      // The selected media's origin is not known until after DOM inspection;
      // never ask for unrelated link-site access on the user's behalf.
      permission = Promise.resolve({ allowed: true })
    } else if (
      typeof info.srcUrl !== 'string' ||
      !/^(https?:|blob:|data:)/i.test(info.srcUrl)
    ) {
      throw new Error('无法读取该媒体，请选择其他素材')
    } else if (info.mediaType !== 'video') {
      // Export first; if that fails, request origin access from the popup.
      permission = Promise.resolve({ allowed: true })
    } else {
      const source = new URL(info.srcUrl)
      if (source.protocol === 'http:' || source.protocol === 'https:') {
        // Request from the menu action before reading or fetching any media.
        const requested = {
          origins: [`${source.protocol}//${source.hostname}/*`],
        }
        permission = chrome.permissions
          .request({
            origins: requested.origins,
          })
          .then(
            (allowed) => ({ allowed }),
            async () => {
              // A synthetic or unavailable gesture may reject request() even when
              // the site was already granted in a previous operation.
              try {
                if (await chrome.permissions.contains(requested))
                  return { allowed: true }
              } catch {}
              return {
                error: '浏览器未允许请求素材权限，请在插件中重新选择素材并授权',
              }
            }
          )
      } else {
        permission = Promise.resolve({ allowed: true })
      }
    }
  } catch (error) {
    permission = Promise.resolve({
      error:
        error?.message === '无法读取该媒体，请选择其他素材'
          ? error.message
          : '无法获取素材来源权限',
    })
  }
  void (async () => {
    let selection
    try {
      await contextStatus(tab.id, '正在准备素材…', false)
      const permissionResult = await permission
      if (permissionResult.error) throw new Error(permissionResult.error)
      if (!permissionResult.allowed)
        throw new Error('未授权访问素材来源，无法获取该文件')
      await currentTarget()
      selection = await contextSelection(info, tab)
      if (
        linked &&
        selection.mediaKind === 'video' &&
        /^https?:/i.test(selection.url)
      ) {
        const source = new URL(selection.url)
        const origins = [`${source.protocol}//${source.hostname}/*`]
        if (!(await chrome.permissions.contains({ origins }))) {
          const existing = await state()
          await stageSelection(selection)
          if (
            existing.selection?.mse &&
            existing.mseCapture?.phase === 'active' &&
            existing.selection.tabId === existing.mseCapture.tabId &&
            existing.selection.documentId === existing.mseCapture.documentId
          )
            await globalThis.inkloomMseController?.stop().catch(() => {})
          await chrome.action.setBadgeText({ text: '1' })
          await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' })
          await contextStatus(tab.id, '请打开插件授权', false)
          return
        }
      }
      const current = await state()
      const capture = current.mseCapture
      if (
        selection.mediaKind === 'video' &&
        selection.url.startsWith('blob:') &&
        capture?.phase === 'active' &&
        capture.tabId === tab.id &&
        selection.frameId === 0
      ) {
        if (
          current.selection?.mse &&
          current.selection.url === selection.url &&
          current.selection.documentId === capture.documentId
        ) {
          const result = await runImport(current.selection, t)
          await contextStatus(tab.id, result.message, false)
          return
        }
        await captureRequest(capture, 'MSE_SELECT', { url: selection.url })
        await stageSelection({
          ...selection,
          mse: true,
          documentId: capture.documentId,
        })
        await contextStatus(
          tab.id,
          '已选中视频，请继续播放一会儿，再右键发送片段或在插件中发送',
          false
        )
        return
      }
      const result = await runImport(selection, t)
      if (
        linked &&
        current.selection?.mse &&
        current.mseCapture?.phase === 'active' &&
        current.selection.tabId === current.mseCapture.tabId &&
        current.selection.documentId === current.mseCapture.documentId
      ) {
        await globalThis.inkloomMseController?.stop().catch(() => {})
        const remaining = (await state()).selection
        if (
          remaining?.mse &&
          remaining.tabId === current.selection.tabId &&
          remaining.documentId === current.selection.documentId
        ) {
          await save({ selection: null })
          await chrome.action.setBadgeText({ text: '' })
        }
      }
      await contextStatus(tab.id, result.message, false)
    } catch (error) {
      if (
        ['IMAGE_SOURCE_PERMISSION', 'AUDIO_SOURCE_PERMISSION'].includes(
          error?.code
        ) &&
        selection
      ) {
        const existing = await state()
        const flag =
          selection.mediaKind === 'audio'
            ? 'needsAudioPermission'
            : 'needsImagePermission'
        await save({ selection: { ...selection, [flag]: true } })
        if (
          existing.selection?.mse &&
          existing.mseCapture?.phase === 'active' &&
          existing.selection.tabId === existing.mseCapture.tabId &&
          existing.selection.documentId === existing.mseCapture.documentId
        )
          await globalThis.inkloomMseController?.stop().catch(() => {})
        await chrome.action.setBadgeText({ text: '1' })
        await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' })
        await contextStatus(tab.id, '请打开插件授权', false)
        return
      }
      let message =
        typeof error?.message === 'string' &&
        !/https?:\/\/|\btoken\b/i.test(error.message)
          ? error.message
          : '发送失败，请重试'
      await contextStatus(tab.id, message, true)
    } finally {
      if (transfer === t) transfer = null
    }
  })()
}
async function openForge() {
  await chrome.tabs.create({ url: FORGE_HOME_URL })
  return { ok: true, openedForge: true }
}
async function handle(message, sender) {
  if (message.kind === 'OPEN_FORGE') {
    if (
      !extensionPage(sender) &&
      !(
        sender.id === chrome.runtime.id &&
        Number.isInteger(sender.tab?.id) &&
        sender.frameId === 0 &&
        typeof sender.documentId === 'string' &&
        sender.documentId
      )
    )
      throw new Error('无效的插件请求来源')
    return openForge()
  }
  if (
    message.kind === 'HOVER_VIDEO_STATE' ||
    message.kind === 'HOVER_VIDEO_SEND' ||
    message.kind === 'HOVER_MEDIA_STATE' ||
    message.kind === 'HOVER_MEDIA_SEND'
  ) {
    if (
      sender.id !== chrome.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0 ||
      typeof sender.documentId !== 'string' ||
      !sender.documentId
    )
      throw new Error('来源页面已失效')
    const legacy = message.kind.startsWith('HOVER_VIDEO_')
    const enabled =
      !legacy || !!(await globalThis.inkloomMseController?.autoEnabled?.())
    if (message.kind.endsWith('_STATE')) {
      const target = (await state()).target
      return {
        ok: true,
        enabled,
        hasTarget: enabled && !!target && target.tabId !== sender.tab.id,
        canShow: enabled && target?.tabId !== sender.tab.id,
      }
    }
    if (!enabled) throw new Error('自动准备已关闭')
    if (!(await state()).target) return openForge()
    const mediaKind = legacy ? 'video' : message.mediaKind
    if (
      !MEDIA_KINDS.includes(mediaKind) ||
      typeof message.url !== 'string' ||
      message.url.length > 4096 ||
      !/^(https?:|blob:|data:)/i.test(message.url)
    )
      throw new Error('无法读取素材')
    const target = await currentTarget()
    if (target.tabId === sender.tab.id) throw new Error('请在素材网页发送')
    try {
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
        files: ['imagePreflight.js', 'source.js'],
      })
    } catch {
      throw new Error('来源页面已关闭或刷新')
    }
    const selection = {
      tabId: sender.tab.id,
      title: (sender.tab.title || '').slice(0, 160),
      frameId: 0,
      documentId: sender.documentId,
      ...(isWeiboPage(sender.url) ? { weiboPage: true } : {}),
      url: message.url,
      mediaKind,
      ...(mediaKind === 'image' ? { displayUrl: message.url } : {}),
      videoCandidates:
        mediaKind === 'video'
          ? normalizeVideoCandidates(message.videoCandidates, message.url)
          : [],
    }
    const current = await state()
    const capture = current.mseCapture
    if (
      !legacy &&
      mediaKind === 'video' &&
      selection.url.startsWith('blob:') &&
      capture?.phase === 'active' &&
      capture.tabId === selection.tabId &&
      capture.documentId === selection.documentId
    ) {
      if (current.selection?.mse && sameSelection(current.selection, selection))
        return runImport(current.selection)
      await captureRequest(capture, 'MSE_SELECT', { url: selection.url })
      await stageSelection({ ...selection, mse: true })
      await save({
        lastStatus: '已选视频，播放后再发送',
        lastStatusTabId: sender.tab.id,
        lastStatusAt: Date.now(),
      })
      await chrome.action.setBadgeText({ text: '1' })
      return { ok: true, message: '已选视频，播放后再发送' }
    }
    try {
      return await runImport(selection)
    } catch (error) {
      if (
        !legacy &&
        mediaKind === 'video' &&
        !error?.code &&
        /无法获取媒体/.test(error?.message || '') &&
        /^https?:/i.test(selection.url)
      ) {
        const url = new URL(selection.url)
        if (
          !(await chrome.permissions.contains({
            origins: [`${url.protocol}//${url.hostname}/*`],
          }))
        )
          error.code = 'VIDEO_SOURCE_PERMISSION'
      }
      if (!legacy && SOURCE_PERMISSION_CODES.includes(error?.code)) {
        await save({
          selection: {
            ...selection,
            ...(mediaKind === 'image'
              ? { needsImagePermission: true }
              : mediaKind === 'audio'
              ? { needsAudioPermission: true }
              : { needsVideoPermission: true }),
          },
          lastStatus: '请打开插件授权',
          lastStatusTabId: sender.tab.id,
          lastStatusAt: Date.now(),
        })
        if (
          current.selection?.mse &&
          capture?.phase === 'active' &&
          current.selection.tabId === capture.tabId &&
          current.selection.documentId === capture.documentId
        )
          await globalThis.inkloomMseController?.stop().catch(() => {})
        await chrome.action.setBadgeText({ text: '1' })
        await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' })
        return { ok: false, error: '请打开插件授权', code: error.code }
      }
      throw error
    }
  }
  if (message.kind === 'MSE_AUTHORIZE') {
    const controller = globalThis.inkloomMseController
    const allowed =
      message.auto === true
        ? await controller?.authorizeAuto?.(sender, message.nonce)
        : await controller?.authorize(sender, message.nonce)
    if (!allowed) throw new Error('分段采集页面已失效')
    return { ok: true }
  }
  if (message.kind === 'MEDIA_SELECTED' || message.kind === 'PICKER_CANCEL') {
    const { pickerTabId } = await state()
    if (!sender.tab || sender.tab.id !== pickerTabId)
      throw new Error('来源页面已失效')
    if (message.kind === 'MEDIA_SELECTED') {
      if (
        !MEDIA_KINDS.includes(message.mediaKind) ||
        typeof message.url !== 'string' ||
        !/^(https?:|blob:|data:)/i.test(message.url)
      )
        throw new Error('不支持该媒体')
      const existing = await state()
      const capture = existing.mseCapture
      let mse = false
      if (
        message.mediaKind === 'video' &&
        message.url.startsWith('blob:') &&
        capture?.phase === 'active' &&
        capture.tabId === sender.tab.id &&
        capture.documentId === sender.documentId &&
        sender.frameId === 0
      ) {
        await captureRequest(capture, 'MSE_SELECT', { url: message.url })
        mse = true
      }
      const selected = {
        tabId: sender.tab.id,
        frameId: sender.frameId ?? 0,
        ...(sender.documentId ? { documentId: sender.documentId } : {}),
        ...(isWeiboPage(sender.url) ? { weiboPage: true } : {}),
        ...(mse ? { mse: true, documentId: capture.documentId } : {}),
        url: message.url,
        mediaKind: message.mediaKind,
        ...(message.mediaKind === 'image' &&
        typeof message.displayUrl === 'string'
          ? { displayUrl: message.displayUrl }
          : {}),
        videoCandidates:
          message.mediaKind === 'video'
            ? normalizeVideoCandidates(message.videoCandidates, message.url)
            : [],
      }
      selected.title =
        typeof sender.tab.title === 'string'
          ? sender.tab.title.slice(0, 160)
          : ''
      await save({
        selection: selected,
        mediaActivity: activityRecord(selected, 'selected'),
        pickerTabId: null,
        lastStatus: mse
          ? '已选中视频，请继续播放一会儿，再打开插件发送片段'
          : '',
        lastStatusTabId: mse ? sender.tab.id : null,
        lastStatusAt: mse ? Date.now() : null,
      })
      if (
        existing.selection?.mse &&
        !mse &&
        capture?.phase === 'active' &&
        existing.selection.tabId === capture.tabId &&
        existing.selection.documentId === capture.documentId
      )
        await globalThis.inkloomMseController?.stop().catch(() => {})
      await chrome.action.setBadgeText({ text: '1' })
      await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' })
      if (mse)
        await contextStatus(
          sender.tab.id,
          '已选中视频，请继续播放一会儿，再打开插件发送片段',
          false
        )
    } else await save({ pickerTabId: null })
    return { ok: true }
  }
  if (message.kind?.startsWith('BLOB_')) {
    const t = transfer
    if (
      !t ||
      !t.selection ||
      sender.tab?.id !== t.selection.tabId ||
      (t.selection.documentId &&
        sender.documentId !== t.selection.documentId) ||
      (t.selection.frameId !== undefined &&
        sender.frameId !== t.selection.frameId) ||
      message.transferId !== t.id
    )
      throw new Error('来源页面已失效')
    if (message.kind === 'BLOB_META') {
      await beginTransfer(t, message.size, message.mime)
      if (
        t.selection.mediaKind === 'audio' ||
        (t.selection.mediaKind === 'video' && globalThis.ForgeVideoPlayback)
      )
        t.playbackChunks = []
      return { ok: true }
    }
    if (message.kind === 'BLOB_CHUNK') {
      await sendTarget(t.target, 'CHUNK', t.id, {
        sequence: message.sequence,
        data: message.data,
      })
      if (t.playbackChunks) {
        try {
          const decoded = atob(message.data)
          const chunk = new Uint8Array(decoded.length)
          for (let i = 0; i < chunk.length; i++)
            chunk[i] = decoded.charCodeAt(i)
          t.playbackChunks.push(chunk)
        } catch {
          t.playbackChunks = null
        }
      }
      return { ok: true }
    }
    if (message.kind === 'BLOB_END') {
      if (t.selection.mediaKind === 'audio') {
        if (!t.playbackChunks) throw new Error('获取到的音频不完整')
        t.playbackFile = await prepareAudio(t, new Blob(t.playbackChunks))
      }
      const result = await finishDelivery(t)
      if (t.playbackChunks && t.selection.mediaKind === 'video') {
        try {
          t.playbackFile = new Blob(t.playbackChunks, { type: t.mime })
        } catch {}
      }
      t.playbackChunks = null
      return result
    }
    if (message.kind === 'BLOB_FAIL') {
      await abortTransfer(t)
      t.playbackChunks = null
      t.begun = false
      return { ok: true }
    }
    throw new Error('无效的媒体数据')
  }
  if (message.kind === 'CHECK_EXTENSION_UPDATE') {
    const url = sender.url?.split(/[?#]/, 1)[0]
    const isSettings = url === chrome.runtime.getURL('options.html')
    if (
      sender.id !== chrome.runtime.id ||
      (!isSettings && url !== chrome.runtime.getURL('popup.html'))
    )
      throw new Error('无效的插件请求来源')
    return { ok: true, release: await globalThis.checkForgeRelease(isSettings) }
  }
  if (!extensionPage(sender)) throw new Error('无效的插件请求来源')
  if (message.kind === 'ENSURE_MEDIA_ENTRY') {
    await globalThis.forgeMediaEntryController?.injectTab(message.tabId)
    return { ok: true }
  }
  if (message.kind === 'GET_SELECTION_PREVIEW') return selectionPreview(message)
  if (message.kind === 'GET_STATE')
    return {
      ok: true,
      ...(await state()),
      autoCaptureEnabled:
        !!(await globalThis.inkloomMseController?.autoEnabled?.()),
      busy: !!transfer,
    }
  if (message.kind === 'SET_AUTO_CAPTURE') {
    if (typeof message.enabled !== 'boolean') throw new Error('设置无效')
    if (transfer) throw new Error('正在导入素材，请稍后重试')
    await globalThis.inkloomMseController.setAutoEnabled(message.enabled)
    return { ok: true }
  }
  if (message.kind === 'PREPARE_MSE') {
    if (transfer) throw new Error('正在导入素材，请稍后重试')
    const target = await currentTarget()
    if (target.tabId === message.tabId)
      throw new Error('请切换到视频网页后开启分段采集')
    await globalThis.inkloomMseController.prepare(message.tabId)
    return { ok: true }
  }
  if (message.kind === 'STOP_MSE') {
    if (transfer) throw new Error('正在导入素材，请稍后重试')
    await globalThis.inkloomMseController.stop()
    return { ok: true }
  }
  if (message.kind === 'SET_TARGET') {
    if (transfer) throw new Error('正在导入素材，不能切换画布')
    targetGeneration++
    const tab = await chrome.tabs.get(message.tabId)
    const canvasId = targetUrl(tab.url)
    if (!canvasId)
      throw new Error('请先打开 Inkloom 的画布页面，再设置接收目标')
    let injected
    try {
      injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: [
          'i18n-data.js',
          'i18n.js',
          'mseRemux.bundle.js',
          'dropBridge.js',
        ],
      })
    } catch {
      throw new Error('无法连接画布，请刷新画布后重新设置')
    }
    const documentId = injected?.find(
      (result) => result.frameId === 0
    )?.documentId
    if (!documentId) throw new Error('无法识别画布页面，请刷新后重新设置')
    const currentTab = await chrome.tabs.get(tab.id)
    if (
      targetUrl(currentTab?.url) !== canvasId ||
      new URL(currentTab.url).origin !== new URL(tab.url).origin
    )
      throw new Error('画布已切换，请重新设置')
    const prior = (await state()).target
    if (prior)
      await sendTarget(prior, 'DISARM', crypto.randomUUID()).catch(() => {})
    await save({ target: null })
    const target = {
      tabId: tab.id,
      canvasId,
      documentId,
      sessionId: crypto.randomUUID(),
      title: (tab.title || '画布').slice(0, 160),
    }
    const ping = await sendTarget(target, 'PING', crypto.randomUUID())
    if (typeof ping.canvasName === 'string' && ping.canvasName.trim())
      target.title = ping.canvasName.trim().slice(0, 160)
    await sendTarget(target, 'ARM', crypto.randomUUID())
    await save({
      target,
      lastStatus: '',
      lastStatusTabId: null,
      lastStatusAt: null,
    })
    await refreshContextMenu()
    void globalThis.forgeMediaEntryController?.recover().catch(() => {})
    return { ok: true, target }
  }
  if (message.kind === 'VIEW_TARGET') {
    const target = await currentTarget()
    const tab = await chrome.tabs.get(target.tabId)
    await chrome.tabs.update(target.tabId, { active: true })
    if (Number.isInteger(tab?.windowId) && chrome.windows?.update)
      await chrome.windows.update(tab.windowId, { focused: true })
    return { ok: true }
  }
  if (message.kind === 'CLEAR_TARGET') {
    if (transfer) throw new Error('正在导入素材，不能切换画布')
    targetGeneration++
    const { target } = await state()
    if (target)
      await sendTarget(target, 'DISARM', crypto.randomUUID()).catch(() => {})
    await save({
      target: null,
      lastStatus: '',
      lastStatusTabId: null,
      lastStatusAt: null,
    })
    await refreshContextMenu()
    return { ok: true }
  }
  if (message.kind === 'START_PICKER') {
    if (transfer) throw new Error('正在导入素材，请稍后重试')
    await currentTarget()
    const tab = await chrome.tabs.get(message.tabId)
    // Keep the current selection until a replacement succeeds. In particular,
    // canceling a picker must not orphan an in-progress MSE capture.
    await save({ pickerTabId: tab.id })
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'i18n-data.js',
          'i18n.js',
          'imagePreflight.js',
          'source.js',
          'mediaFallback.js',
          'videoCandidates.js',
          'picker.js',
        ],
      })
    } catch {
      await save({ pickerTabId: null })
      throw new Error('无法在此页面选择素材，请切换到普通网页')
    }
    void globalThis.forgeMediaEntryController?.injectTab(tab.id).catch(() => {})
    return { ok: true }
  }
  if (message.kind === 'IMPORT') return runImport()
  throw new Error('不支持的操作')
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message || {}, sender).then(sendResponse, (error) =>
    sendResponse(resultError(error))
  )
  return true
})

chrome.runtime.onInstalled.addListener(() => {
  void globalThis.forgeMediaEntryController?.recover().catch(() => {})
  storeVideoPlayback()
  // Chrome groups multiple registered items even if only one is visible.
  // Remove the previous version's entries, then keep one changing action.
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: t('打开 Forge'),
        contexts: [...MEDIA_KINDS, 'link'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => {
        void chrome.runtime.lastError
        void refreshContextMenu()
      }
    )
  })
})
chrome.runtime.onStartup.addListener(() => {
  void globalThis.forgeMediaEntryController?.recover().catch(() => {})
  storeVideoPlayback()
  targetGeneration++
  void save({ target: null }).then(refreshContextMenu)
})
chrome.contextMenus.onClicked.addListener(sendFromContextMenu)
chrome.tabs.onRemoved.addListener((tabId) => {
  void invalidateTarget(tabId)
  void globalThis.inkloomMseController?.onTabRemoved(tabId)
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url)
    void invalidateTarget(tabId, changeInfo)
  void globalThis.inkloomMseController?.onTabUpdated(tabId, changeInfo)
  void globalThis.forgeMediaEntryController
    ?.onTabUpdated(tabId, changeInfo)
    .catch(() => {})
})

globalThis.ForgeI18n?.subscribe(() => {
  void refreshContextMenu()
})
