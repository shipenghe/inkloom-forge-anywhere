const t = (value) => globalThis.ForgeI18n?.text(value) ?? value
const localeReady = Promise.resolve(globalThis.ForgeI18n?.ready).then(() =>
  globalThis.ForgeI18n?.applyDOM()
)
const targetActions = document.getElementById('target-actions')
const targetCard = document.getElementById('target-card')
const targetNode = document.getElementById('target')
const targetDetailNode = document.getElementById('target-detail')
const targetStateNode = document.getElementById('target-state')
const targetStateTextNode = document.getElementById('target-state-text')
const selectionNode = document.getElementById('selection')
const selectionDetailNode = document.getElementById('selection-detail')
const selectionPanel = document.getElementById('selection-panel')
const panel = document.getElementById('panel')
const mediaCard = document.getElementById('media-card')
const mediaStatus = document.getElementById('media-status')
const mediaFeedback = document.getElementById('media-feedback')
const selectionPreview = document.getElementById('selection-preview')
const selectionIcon = document.getElementById('selection-icon')
const selectionTitle = document.getElementById('selection-title')
const imageIcon = document.getElementById('image-icon')
const videoIcon = document.getElementById('video-icon')
const audioIcon = document.getElementById('audio-icon')
const toggleVideoPreview = document.getElementById('toggle-video-preview')
const videoPreview = document.getElementById('video-preview')
const audioPreview = document.getElementById('audio-preview')
const setButton = document.getElementById('set-target')
const clearButton = document.getElementById('clear-target')
const viewButton = document.getElementById('view-target')
const selectButton = document.getElementById('select-media')
const importButton = document.getElementById('import-media')
const authorizeVideoButton = document.getElementById('authorize-video')
const captureHint = document.getElementById('capture-hint')
const guide = document.getElementById('guide')
const autoVideoToggle = document.getElementById('auto-video-toggle')
const popupShell = document.getElementById('popup-shell')
const panelStyles = document.getElementById('panel-styles')
// The inline shell can paint while the full stylesheet and saved state load.
const stylesReady = panelStyles
  ? new Promise((resolve, reject) => {
      const failed = () => {
        clearTimeout(timeout)
        reject(new Error('面板加载失败，请重新打开'))
      }
      const timeout = setTimeout(failed, 8000)
      const loaded = () => {
        clearTimeout(timeout)
        panelStyles.media = 'all'
        resolve()
      }
      if (panelStyles.sheet) loaded()
      else {
        panelStyles.addEventListener('load', loaded, { once: true })
        panelStyles.addEventListener('error', failed, { once: true })
      }
    })
  : Promise.resolve()
let currentState = null
let currentTab = null
let mediaEntryTabId = null
let permissionNeededFor = null
let permissionNeededKind = null
let busy = false
let remoteBusy = false
let pollTimer = null
let feedback = { text: '', kind: 'info' }
let targetFeedback = null
let busyScope = null
let hydrated = false
let activityRevision = null
let refreshGeneration = 0
let viewingTarget = false
let playableVideoId = null
let playableKind = null
let openVideo = null
const selectionPreviews = new Map()

function revealPanel() {
  if (hydrated) return
  hydrated = true
  panel.setAttribute('aria-busy', 'false')
  panel.dataset.ready = 'true'
  if (popupShell) {
    popupShell.hidden = true
    popupShell.setAttribute('aria-busy', 'false')
  }
  // The initial checked state must be painted before enabling interactions'
  // transitions; otherwise a saved "on" state animates from the HTML default.
  if (globalThis.requestAnimationFrame) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        panel.dataset.motion = 'ready'
      })
    )
  } else panel.dataset.motion = 'ready'
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message)
  if (!result?.ok) {
    const error = new Error(result?.error || '操作失败，请重试')
    error.code = result?.code
    throw error
  }
  return result
}
function showStatus(text, kind = 'info', scope = 'media') {
  if (scope === 'target') {
    targetFeedback = text ? { text, kind } : null
    renderTargetFeedback()
    return
  }
  feedback = { text: text || '', kind }
  renderMediaFeedback()
}
function renderTargetFeedback() {
  const target = currentState?.target
  targetDetailNode.textContent = t(
    targetFeedback?.text || (target ? '请保持画布打开' : '打开画布后设置')
  )
  targetDetailNode.dataset.kind = targetFeedback?.kind || 'info'
  targetDetailNode.title = t(targetDetailNode.textContent)
}
function renderMediaFeedback() {
  mediaFeedback.textContent = t(feedback.text)
  mediaFeedback.title = mediaFeedback.textContent
  captureHint.hidden = !!feedback.text
  mediaFeedback.hidden = !feedback.text
  mediaStatus.dataset.kind = feedback.text ? feedback.kind : 'info'
}
function statusKind(text) {
  if (
    /失败|无法|未授权|断开|请先|拒绝|超出|超时|不支持|未知|failed|couldn’t|can’t|not granted|disconnected|unsupported|unknown/i.test(
      text
    )
  )
    return 'error'
  if (/可能不支持|请确认格式/.test(text)) return 'warning'
  if (/成功|已设置|已连接|sent|connected/i.test(text)) return 'success'
  return 'info'
}
function showRecentPageStatus() {
  if (currentState?.mediaActivity?.updatedAt > currentState?.lastStatusAt)
    return
  const age = Date.now() - currentState?.lastStatusAt
  if (
    currentState?.lastStatus &&
    currentState.lastStatusTabId === currentTab?.id &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < 60_000
  ) {
    showStatus(currentState.lastStatus, statusKind(currentState.lastStatus))
  }
}
// Keep the allowed canvas URLs aligned with background.js targetUrl().
function isCanvasPage(raw) {
  try {
    const url = new URL(raw)
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    const allowed = ['tusi.cn', 'tusiart.cn', 'tensor.art', 'forge.art'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith('.' + domain)
    )
    const match = url.pathname.match(/^\/detail\/([^/]+)\/?$/)
    if (!match || (!local && !allowed)) return false
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (!local && url.protocol !== 'https:') return false
    decodeURIComponent(match[1])
    return true
  } catch {
    return false
  }
}
function isWebPage(raw) {
  try {
    return ['http:', 'https:'].includes(new URL(raw).protocol)
  } catch {
    return false
  }
}
function selectionKey(selection) {
  if (!Number.isInteger(selection?.tabId) || typeof selection?.url !== 'string')
    return null
  return JSON.stringify([
    selection.tabId,
    selection.url,
    selection.documentId ?? null,
    selection.frameId ?? 0,
    selection.mediaId ?? null,
  ])
}
function loadSelectionPreview(selection) {
  const key = selectionKey(selection)
  if (!key) return
  if (selectionPreviews.has(key)) {
    const cached = selectionPreviews.get(key)
    if (cached && selectionKey(currentState?.selection) === key) {
      Object.assign(currentState.selection, cached)
      renderMediaCard()
    }
    return
  }
  // Thumbnail preparation must never delay the first render or an action.
  // Cache pending/failed requests too, so status polling does not re-read media.
  selectionPreviews.set(key, null)
  void send({
    kind: 'GET_SELECTION_PREVIEW',
    tabId: selection.tabId,
    url: selection.url,
    documentId: selection.documentId,
    frameId: selection.frameId,
    mediaId: selection.mediaId,
  })
    .then((result) => {
      if (selectionKey(result.selection) !== key) return
      const metadata = {}
      if (typeof result.selection.title === 'string')
        metadata.title = t(result.selection.title.slice(0, 240))
      if (
        typeof result.selection.previewDataUrl === 'string' &&
        result.selection.previewDataUrl.length <= 100_000
      )
        metadata.previewDataUrl = result.selection.previewDataUrl
      selectionPreviews.set(key, metadata)
      if (selectionKey(currentState?.selection) !== key) return
      Object.assign(currentState.selection, metadata)
      renderMediaCard()
    })
    .catch(() => {})
}
function renderSelection(selection) {
  const preview = selection?.previewDataUrl
  const safePreview =
    typeof preview === 'string' &&
    preview.length <= 100_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(preview)
  selectionPreview.hidden = !safePreview
  selectionIcon.hidden = safePreview
  if (safePreview) selectionPreview.src = preview
  else selectionPreview.removeAttribute('src')
  const isVideo = selection?.mediaKind === 'video'
  const isAudio = selection?.mediaKind === 'audio'
  imageIcon.toggleAttribute('hidden', isVideo || isAudio)
  videoIcon.toggleAttribute('hidden', !isVideo)
  audioIcon.hidden = !isAudio
  const title =
    typeof selection?.title === 'string' && selection.title.trim()
      ? selection.title.trim()
      : selection?.filename || ''
  selectionTitle.textContent = title
  selectionTitle.title = title
  selectionTitle.hidden = !title
}
function renderVideoPreview() {
  toggleVideoPreview.hidden = !playableVideoId
  toggleVideoPreview.setAttribute('aria-expanded', String(!!openVideo))
  const audio = playableKind === 'audio'
  toggleVideoPreview.setAttribute(
    'aria-controls',
    audio ? 'audio-preview' : 'video-preview'
  )
  const label = t(
    audio
      ? openVideo
        ? '收起音频'
        : '播放音频'
      : openVideo
      ? '收起视频'
      : '播放视频'
  )
  toggleVideoPreview.setAttribute('aria-label', label)
  toggleVideoPreview.title = label
}
function closeVideoPreview() {
  const playback = openVideo
  openVideo = null
  if (playback?.url) {
    playback.player.hidden = true
    playback.player.pause()
    playback.player.removeAttribute('src')
    playback.player.load()
    URL.revokeObjectURL(playback.url)
  }
}
toggleVideoPreview.addEventListener('click', async () => {
  if (openVideo) {
    closeVideoPreview()
    renderVideoPreview()
    return
  }
  if (!playableVideoId) return
  const audio = playableKind === 'audio'
  const player = audio ? audioPreview : videoPreview
  const opening = { id: playableVideoId, player }
  openVideo = opening
  renderVideoPreview()
  try {
    const file = await globalThis.ForgeVideoPlayback.read(opening.id)
    if (openVideo !== opening) return
    if (!file) throw new Error()
    opening.url = URL.createObjectURL(file)
    player.src = opening.url
    player.setAttribute('aria-label', t(audio ? '音频预览' : '视频预览'))
    player.hidden = false
    void player.play().catch(() => {})
  } catch {
    if (openVideo !== opening) return
    closeVideoPreview()
    renderVideoPreview()
    showStatus(
      audio
        ? '音频预览不可用，请在画布中播放'
        : '视频预览不可用，请在画布中播放',
      'error'
    )
  }
})
for (const player of [videoPreview, audioPreview]) {
  player.addEventListener('error', () => {
    if (!openVideo?.url || openVideo.player !== player) return
    closeVideoPreview()
    renderVideoPreview()
    showStatus(
      player === audioPreview
        ? '音频预览不可用，请在画布中播放'
        : '视频预览不可用，请在画布中播放',
      'error'
    )
  })
}
function displayedSelection() {
  const selection = currentState?.selection
  const activity = currentState?.mediaActivity
  return selection && (!activity || activity.id === selection.mediaId)
    ? selection
    : null
}
function formatMediaTime(seconds) {
  const whole = Math.floor(seconds)
  const time = (
    whole >= 3600
      ? [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
      : [Math.floor(whole / 60), whole % 60]
  )
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
  return time
}
function renderMediaCard() {
  const selection = displayedSelection()
  const legacy =
    !selection &&
    Number.isFinite(currentState?.lastDelivery?.timestamp) &&
    currentState.lastDelivery.filename
      ? { ...currentState.lastDelivery, status: 'sent' }
      : null
  const activity = currentState?.mediaActivity
  const item = activity
    ? {
        ...selection,
        ...activity,
        title: activity.title || selection?.title,
        previewDataUrl: activity.previewDataUrl || selection?.previewDataUrl,
      }
    : selection || legacy
  const hasMedia = ['image', 'video', 'audio'].includes(item?.mediaKind)
  guide.hidden = hasMedia
  selectionPanel.hidden = !hasMedia
  renderSelection(item)
  playableVideoId =
    (item?.mediaKind === 'video' || item?.mediaKind === 'audio') &&
    activity?.status === 'sent' &&
    activity.id === currentState?.playableVideoId
      ? activity.id
      : null
  playableKind = playableVideoId ? item.mediaKind : null
  if (openVideo && openVideo.id !== playableVideoId) closeVideoPreview()
  renderVideoPreview()
  if (!hasMedia) return
  const isClip = item.isClip || item.mse
  const kind =
    item.mediaKind === 'image'
      ? '图片'
      : item.mediaKind === 'audio'
      ? '音频'
      : isClip
      ? '视频片段'
      : '视频'
  const status = activity?.status || item.status || 'selected'
  selectionPanel.dataset.status = status
  selectionNode.textContent = t(
    ({
      selected: '已选中',
      sending: '正在发送',
      sent: '发送完成',
      failed: '发送失败',
    }[status] || '已选中') +
      ' · ' +
      kind
  )
  const range =
    Number.isFinite(item.sourceStart) &&
    Number.isFinite(item.sourceEnd) &&
    item.sourceStart >= 0 &&
    item.sourceEnd > item.sourceStart
  selectionDetailNode.textContent = t(
    [
      status === 'selected' &&
      selection?.tabId &&
      selection.tabId !== currentTab?.id
        ? '来自其他标签页'
        : '',
      item.mediaKind === 'video'
        ? range
          ? `${isClip ? '片段' : '全片'} ${formatMediaTime(
              item.sourceStart
            )}–${formatMediaTime(item.sourceEnd)}`
          : isClip
          ? '视频片段'
          : ''
        : '',
      item.hasAudio === false ? '无声' : '',
      item.mediaKind === 'audio' &&
      Number.isFinite(item.duration ?? item.sourceDuration)
        ? formatMediaTime(item.duration ?? item.sourceDuration)
        : '',
      status === 'sent' && (item.mediaKind !== 'video' || !range)
        ? '已交给画布'
        : '',
    ]
      .filter(Boolean)
      .join(' · ')
  )
  selectionDetailNode.title = t(selectionDetailNode.textContent)
  selectionDetailNode.hidden = !selectionDetailNode.textContent
  if (activity?.status === 'failed' && activity.message && !feedback.text)
    showStatus(activity.message, 'error')
}
selectionPreview.addEventListener('error', () => {
  selectionPreview.hidden = true
  selectionIcon.hidden = false
})
function render() {
  const target = currentState?.target
  const disabled = busy || remoteBusy
  const autoCaptureEnabled = currentState?.autoCaptureEnabled !== false
  document.documentElement?.style?.setProperty('--popup-height', '394px')
  autoVideoToggle.setAttribute('aria-checked', String(autoCaptureEnabled))
  autoVideoToggle.title = t(
    autoCaptureEnabled ? '关闭自动准备视频' : '开启自动准备视频'
  )
  autoVideoToggle.disabled = disabled
  const onTarget = !!target && target.tabId === currentTab?.id
  const canvasPage = isCanvasPage(currentTab?.url)
  const webPage = isWebPage(currentTab?.url)
  const capturingHere =
    !!currentState?.mseCapture &&
    currentState.mseCapture.tabId === currentTab?.id
  const preparingHere =
    capturingHere && currentState.mseCapture.phase === 'preparing'
  const selection = displayedSelection()
  const selectedVideoHere =
    !!selection?.mse && selection.tabId === currentTab?.id
  targetNode.textContent =
    target?.canvasName || target?.title || t('还没有接收画布')
  targetNode.title = target ? targetNode.textContent : ''
  renderTargetFeedback()
  targetCard.dataset.connected = target ? 'true' : 'false'
  targetStateNode.dataset.connected = target ? 'true' : 'false'
  targetStateTextNode.textContent = t(target ? '已连接' : '未设置')
  setButton.textContent = t(
    busyScope === 'target' ? '连接中…' : target ? '切换' : '设为接收'
  )
  setButton.hidden = !canvasPage || onTarget
  clearButton.hidden = !target
  targetActions.hidden = !canvasPage && !target
  setButton.disabled = disabled || onTarget
  clearButton.disabled = disabled || !target
  if (viewButton) {
    viewButton.hidden = !target
    viewButton.disabled = viewingTarget || !target
  }
  captureHint.textContent = t(
    !target
      ? '先设置接收画布'
      : canvasPage
      ? onTarget
        ? '切换到素材网页'
        : '设为接收画布'
      : !webPage
      ? '打开素材网页'
      : preparingHere
      ? '正在刷新网页…'
      : capturingHere && !selectedVideoHere
      ? '选取视频后播放'
      : ''
  )
  captureHint.hidden = !captureHint.textContent
  selectButton.disabled =
    disabled || !target || canvasPage || !webPage || preparingHere
  selectButton.textContent = t(
    selection ? '重新选取' : capturingHere ? '选取视频' : '选取素材'
  )
  renderMediaCard()
  loadSelectionPreview(selection)
  importButton.textContent = t(busyScope === 'media' ? '准备中…' : '发送到画布')
  importButton.hidden = !selection
  importButton.disabled = disabled || !target || !selection
  authorizeVideoButton.hidden =
    !selection ||
    (permissionNeededFor !== currentState.selection.url &&
      !currentState.selection.needsImagePermission &&
      !currentState.selection.needsAudioPermission &&
      !currentState.selection.needsVideoPermission)
  authorizeVideoButton.disabled = disabled || !target
  if (!authorizeVideoButton.hidden) importButton.hidden = true
  mediaCard.setAttribute(
    'aria-busy',
    String(remoteBusy || busyScope === 'media')
  )
  renderMediaFeedback()
  revealPanel()
}
async function refresh() {
  const generation = ++refreshGeneration
  const [, state, tabs] = await Promise.all([
    Promise.all([stylesReady, localeReady]),
    send({ kind: 'GET_STATE' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ])
  if (generation !== refreshGeneration) return
  currentState = state
  const revision = state.mediaActivity
    ? state.mediaActivity.id + ':' + state.mediaActivity.status
    : null
  if (revision !== activityRevision) {
    activityRevision = revision
    feedback = {
      text:
        state.mediaActivity?.status === 'failed'
          ? state.mediaActivity.message || '发送失败'
          : '',
      kind: state.mediaActivity?.status === 'failed' ? 'error' : 'info',
    }
  }
  ;[currentTab] = tabs
  remoteBusy = !!currentState.busy
  render()
  if (Number.isInteger(currentTab?.id) && mediaEntryTabId !== currentTab.id) {
    mediaEntryTabId = currentTab.id
    // Opening the popup grants activeTab for this document. Install the quiet
    // right-click entry without requesting persistent access to other websites.
    void send({ kind: 'ENSURE_MEDIA_ENTRY', tabId: currentTab.id }).catch(
      () => {}
    )
  }
  if (pollTimer) clearTimeout(pollTimer)
  if (remoteBusy) {
    pollTimer = setTimeout(() => {
      refresh()
        .then(() => {
          showRecentPageStatus()
        })
        .catch(() => {})
    }, 1000)
  }
}
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('找不到当前标签页')
  return tab.id
}
async function action(fn, scope = 'media') {
  if (busy || remoteBusy) return
  busy = true
  busyScope = scope
  render()
  try {
    await fn()
    permissionNeededFor = null
    permissionNeededKind = null
  } catch (error) {
    if (
      [
        'VIDEO_SOURCE_PERMISSION',
        'IMAGE_SOURCE_PERMISSION',
        'AUDIO_SOURCE_PERMISSION',
      ].includes(error?.code)
    ) {
      permissionNeededFor = currentState?.selection?.url || null
      permissionNeededKind =
        error.code === 'VIDEO_SOURCE_PERMISSION'
          ? 'video'
          : error.code === 'AUDIO_SOURCE_PERMISSION'
          ? 'audio'
          : 'image'
    }
    showStatus(error?.message || '操作失败，请重试', 'error', scope)
  } finally {
    busy = false
    busyScope = null
    await refresh().catch(() => render())
  }
}
setButton.addEventListener('click', () =>
  action(async () => {
    showStatus('正在连接…', 'info', 'target')
    await send({ kind: 'SET_TARGET', tabId: await activeTabId() })
    showStatus('', 'info', 'target')
  }, 'target')
)
clearButton.addEventListener('click', () =>
  action(async () => {
    await send({ kind: 'CLEAR_TARGET' })
    showStatus('', 'info', 'target')
  }, 'target')
)
viewButton?.addEventListener('click', async () => {
  if (viewingTarget || !currentState?.target) return
  viewingTarget = true
  viewButton.disabled = true
  try {
    await send({ kind: 'VIEW_TARGET' })
    window.close()
  } catch (error) {
    showStatus(error?.message || '无法查看画布', 'error', 'target')
  } finally {
    viewingTarget = false
    await refresh().catch(() => render())
  }
})
selectButton.addEventListener('click', () =>
  action(async () => {
    await send({ kind: 'START_PICKER', tabId: await activeTabId() })
    window.close()
  })
)
autoVideoToggle.addEventListener('click', () => {
  action(async () => {
    const enabled = currentState?.autoCaptureEnabled === false
    if (enabled) {
      // This must be called directly during the user's button gesture.
      const allowed = await chrome.permissions.request({
        origins: ['http://*/*', 'https://*/*'],
      })
      if (!allowed) throw new Error('未授权访问网页')
    }
    await send({ kind: 'SET_AUTO_CAPTURE', enabled })
    showStatus(enabled ? '已开启，请刷新素材网页' : '已关闭自动准备')
  }, 'auto')
})
importButton.addEventListener('click', () => {
  // The permission request must remain in the button's user gesture.
  action(async () => {
    const selection = currentState?.selection
    if (!selection) throw new Error('请先选择素材')
    const url = new URL(selection.url)
    if (
      selection.mediaKind === 'video' &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    ) {
      const originPattern = `${url.protocol}//${url.hostname}/*`
      const allowed = await chrome.permissions.request({
        origins: [originPattern],
      })
      if (!allowed) throw new Error('未授权访问素材来源，无法获取该文件')
    }
    showStatus('正在准备素材…')
    const result = await send({ kind: 'IMPORT' })
    const message = result.message || '已交给画布，请查看结果'
    showStatus(message, statusKind(message))
  })
})
authorizeVideoButton.addEventListener('click', () => {
  action(async () => {
    const selection = currentState?.selection
    const candidates =
      selection?.mediaKind !== 'video' ||
      permissionNeededKind === 'image' ||
      selection?.needsImagePermission
        ? [selection?.url]
        : [selection?.url, ...(selection?.videoCandidates || [])]
    const origins = [
      ...new Set(
        candidates
          .map((raw) => {
            try {
              const url = new URL(raw)
              return ['http:', 'https:'].includes(url.protocol)
                ? `${url.protocol}//${url.hostname}/*`
                : null
            } catch {
              return null
            }
          })
          .filter(Boolean)
      ),
    ]
    if (!origins.length) throw new Error('没有可授权的素材来源，请重新选择')
    // Called synchronously within the explicit button gesture.
    const allowed = await chrome.permissions.request({ origins })
    if (!allowed) throw new Error('未授权素材来源')
    showStatus('正在准备素材…')
    const result = await send({ kind: 'IMPORT' })
    const message = result.message || '已交给画布，请查看结果'
    showStatus(message, statusKind(message))
  })
})
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      !(
        area === 'session' &&
        (changes.lastStatus ||
          changes.mediaActivity ||
          changes.lastDelivery ||
          changes.playableVideoId ||
          changes.selection ||
          changes.target ||
          changes.mseCapture)
      ) &&
      !(area === 'local' && changes.autoCaptureEnabled)
    )
      return
    void refresh()
      .then(showRecentPageStatus)
      .catch(() => {})
  })
}
const versionBadge = document.getElementById('installed-version')
const versionLabel = `v${chrome.runtime.getManifest().version}`
versionBadge.textContent = versionLabel
versionBadge.title = `Forge Anywhere ${versionLabel}`

const settingsButton = document.getElementById('open-settings')
if (settingsButton) {
  settingsButton.addEventListener('click', () => {
    void chrome.runtime
      .openOptionsPage()
      .catch((error) =>
        showStatus(error?.message || '操作失败，请重试', 'error')
      )
  })
  void send({ kind: 'CHECK_EXTENSION_UPDATE' })
    .then(({ release }) => {
      if (!release?.available) return
      settingsButton.dataset.updateAvailable = 'true'
      settingsButton.setAttribute('aria-describedby', 'settings-update-status')
    })
    .catch(() => {})
}
globalThis.ForgeI18n?.subscribe(() => {
  globalThis.ForgeI18n.applyDOM()
  if (currentState) render()
})
refresh()
  .then(showRecentPageStatus)
  .catch(async (error) => {
    try {
      await stylesReady
    } catch {
      if (popupShell) {
        popupShell.textContent = t('面板加载失败，请重新打开')
        popupShell.setAttribute('aria-busy', 'false')
      }
      return
    }
    showStatus(error?.message || '插件初始化失败', 'error')
    revealPanel()
  })
