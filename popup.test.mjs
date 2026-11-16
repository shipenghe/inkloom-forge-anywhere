import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('./popup.js', import.meta.url), 'utf8')
const ids = [
  'panel',
  'target-actions',
  'target-card',
  'target',
  'target-detail',
  'target-state',
  'target-state-text',
  'selection',
  'selection-detail',
  'selection-panel',
  'selection-preview',
  'selection-icon',
  'selection-title',
  'image-icon',
  'video-icon',
  'media-card',
  'media-status',
  'media-feedback',
  'set-target',
  'clear-target',
  'view-target',
  'select-media',
  'import-media',
  'authorize-video',
  'capture-hint',
  'auto-video-toggle',
  'guide',
  'installed-version',
  'open-settings',
]
function fixture(
  initial = {},
  tab = { id: 123, url: 'https://example.test/watch' },
  release = null
) {
  const elements = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        dataset: {},
        hidden: false,
        disabled: false,
        textContent: '',
        title: '',
        events: {},
        attributes: {},
        addEventListener(type, handler) {
          this.events[type] = handler
        },
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        removeAttribute(name) {
          delete this.attributes[name]
          delete this[name]
        },
      },
    ])
  )
  const state = { target: null, selection: null, busy: false, ...initial }
  const events = []
  let onChanged
  let permission = true
  let missingVideoPermission = false
  let missingImagePermission = false
  let importMessage = '上传完成'
  let autoCaptureError = null
  let targetError = null
  let previewHandler = async () => ({ ok: true, selection: null })
  let stateHandler = null
  const requested = []
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.2.3' }),
      async openOptionsPage() {
        events.push('OPEN_OPTIONS')
      },
      async sendMessage(message) {
        events.push(message.kind)
        if (message.kind === 'CHECK_EXTENSION_UPDATE')
          return { ok: true, release }
        if (message.kind === 'GET_STATE')
          return stateHandler ? stateHandler() : { ok: true, ...state }
        if (message.kind === 'GET_SELECTION_PREVIEW')
          return previewHandler(message)
        if (message.kind === 'SET_TARGET') {
          if (targetError) return { ok: false, error: targetError }
          state.target = {
            canvasName: '产品画布',
            title: 'Forge',
            tabId: message.tabId,
          }
          return { ok: true }
        }
        if (message.kind === 'CLEAR_TARGET') {
          state.target = null
          return { ok: true }
        }
        if (message.kind === 'VIEW_TARGET') return { ok: true }
        if (message.kind === 'SET_AUTO_CAPTURE') {
          if (autoCaptureError) return { ok: false, error: autoCaptureError }
          state.autoCaptureEnabled = message.enabled
          return { ok: true }
        }
        if (message.kind === 'IMPORT') {
          if (missingImagePermission) {
            missingImagePermission = false
            return {
              ok: false,
              code: 'IMAGE_SOURCE_PERMISSION',
              error: '请授权素材来源',
            }
          }
          if (missingVideoPermission) {
            missingVideoPermission = false
            return {
              ok: false,
              code: 'VIDEO_SOURCE_PERMISSION',
              error: '视频备用来源尚未授权',
            }
          }
          state.selection = null
          return { ok: true, message: importMessage }
        }
        if (message.kind === 'START_PICKER') return { ok: true }
        if (message.kind === 'PREPARE_MSE') {
          state.mseCapture = { tabId: message.tabId }
          return { ok: true }
        }
        if (message.kind === 'STOP_MSE') {
          state.mseCapture = null
          return { ok: true }
        }
        return { ok: false, error: '未知请求' }
      },
    },
    tabs: {
      async query() {
        return [tab]
      },
    },
    permissions: {
      async request(value) {
        events.push('PERMISSION')
        requested.push(value)
        return permission
      },
    },
    storage: {
      onChanged: {
        addListener(fn) {
          onChanged = fn
        },
      },
    },
  }
  vm.runInNewContext(source, {
    chrome,
    URL,
    setTimeout,
    clearTimeout,
    document: {
      getElementById(id) {
        return elements[id]
      },
    },
    window: {
      close() {
        events.push('CLOSE')
      },
    },
  })
  return {
    elements,
    state,
    events,
    requested,
    setPreviewHandler(handler) {
      previewHandler = handler
    },
    setStateHandler(handler) {
      stateHandler = handler
    },
    setImportMessage(message) {
      importMessage = message
    },
    failTarget(message) {
      targetError = message
    },
    failAutoCapture(message) {
      autoCaptureError = message
    },
    needVideoPermission() {
      missingVideoPermission = true
    },
    needImagePermission() {
      missingImagePermission = true
    },
    deny() {
      permission = false
    },
    change(changes) {
      onChanged(changes, 'session')
    },
    async ready() {
      await new Promise((resolve) => setImmediate(resolve))
    },
    async click(id) {
      await elements[id].events.click()
    },
  }
}

test('the popup shows the loaded extension version rather than the release version', async () => {
  const f = fixture({}, undefined, { available: true, version: '1.2.4' })
  await f.ready()
  assert.equal(f.elements['installed-version'].textContent, 'v1.2.3')
  assert.equal(f.elements['installed-version'].title, 'Forge Anywhere v1.2.3')
})

test('a new release marks the settings gear and the gear still opens settings', async () => {
  const current = fixture()
  const next = fixture({}, undefined, { available: true, version: '1.0.15' })
  await Promise.all([current.ready(), next.ready()])
  assert.equal(
    current.elements['open-settings'].dataset.updateAvailable,
    undefined
  )
  const button = next.elements['open-settings']
  assert.equal(button.dataset.updateAvailable, 'true')
  assert.equal(button.attributes['aria-describedby'], 'settings-update-status')
  await next.click('open-settings')
  assert.ok(next.events.includes('OPEN_OPTIONS'))
})

test('canvas target setup is available on the canvas only', async () => {
  const canvas = fixture({}, { id: 123, url: 'https://forge.art/detail/abc' })
  await canvas.ready()
  assert.equal(canvas.elements.target.textContent, '还没有接收画布')
  assert.equal(canvas.elements['target-card'].dataset.connected, 'false')
  assert.equal(canvas.elements['set-target'].hidden, false)
  assert.equal(canvas.elements['select-media'].disabled, true)
  await canvas.click('set-target')
  assert.equal(canvas.elements.target.textContent, '产品画布')
  assert.equal(canvas.elements['target-state-text'].textContent, '已连接')
  assert.equal(canvas.elements['target-card'].dataset.connected, 'true')
  assert.equal(canvas.elements['media-feedback'].textContent, '')
  assert.equal(canvas.elements['set-target'].hidden, true)
  assert.equal(canvas.elements['set-target'].disabled, true)
  assert.match(canvas.elements['capture-hint'].textContent, /切换到素材网页/)
  await canvas.click('clear-target')
  assert.equal(canvas.elements['target-state-text'].textContent, '未设置')
  assert.equal(canvas.elements['target-card'].dataset.connected, 'false')

  const source = fixture({ target: { title: '画布 A', tabId: 999 } })
  await source.ready()
  assert.equal(source.elements['set-target'].hidden, true)
  assert.equal(source.elements['clear-target'].hidden, false)
  assert.equal(source.elements['select-media'].disabled, false)
  assert.equal(source.elements.target.textContent, '画布 A')

  const noTarget = fixture()
  await noTarget.ready()
  assert.equal(noTarget.elements['target-actions'].hidden, true)
  assert.equal(noTarget.elements['target-detail'].textContent, '打开画布后设置')
  assert.equal(noTarget.elements['select-media'].disabled, true)
})

test('a target connection failure stays inside the receiving card', async () => {
  const f = fixture({}, { id: 123, url: 'https://forge.art/detail/abc' })
  f.failTarget('画布未就绪')
  await f.ready()
  await f.click('set-target')
  assert.equal(f.elements['target-detail'].textContent, '画布未就绪')
  assert.equal(f.elements['target-detail'].dataset.kind, 'error')
  assert.equal(f.elements['media-feedback'].textContent, '')
  assert.equal(f.elements['target-card'].dataset.connected, 'false')
  assert.equal(f.elements['set-target'].disabled, false)
})

test('automatic video preparation can restore access on explicit enable and can be disabled', async () => {
  const f = fixture({ autoCaptureEnabled: false })
  await f.ready()
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
  assert.equal(f.events.includes('PERMISSION'), false)
  assert.equal(f.events.includes('SET_AUTO_CAPTURE'), false)
  await f.click('auto-video-toggle')
  await f.ready()
  assert.deepEqual(Array.from(f.requested[0].origins), [
    'http://*/*',
    'https://*/*',
  ])
  assert.deepEqual(
    f.events.filter((event) =>
      ['PERMISSION', 'SET_AUTO_CAPTURE'].includes(event)
    ),
    ['PERMISSION', 'SET_AUTO_CAPTURE']
  )
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'true'
  )
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'true'
  )
  assert.match(f.elements['media-feedback'].textContent, /请刷新/)
  await f.click('auto-video-toggle')
  await f.ready()
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
  assert.equal(f.events.filter((event) => event === 'PERMISSION').length, 1)
  assert.equal(
    f.events.filter((event) => event === 'SET_AUTO_CAPTURE').length,
    2
  )
})

test('automatic video preparation stays off if permission is denied or registration fails', async () => {
  const denied = fixture({ autoCaptureEnabled: false })
  denied.deny()
  await denied.ready()
  await denied.click('auto-video-toggle')
  await denied.ready()
  assert.equal(denied.events.includes('SET_AUTO_CAPTURE'), false)
  assert.equal(
    denied.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
  assert.match(denied.elements['media-feedback'].textContent, /未授权/)

  const failed = fixture({ autoCaptureEnabled: false })
  failed.failAutoCapture('启用失败')
  await failed.ready()
  await failed.click('auto-video-toggle')
  await failed.ready()
  assert.equal(
    failed.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
  assert.equal(failed.elements['media-feedback'].textContent, '启用失败')
})

test('another canvas offers to switch the target; ordinary detail pages do not', async () => {
  const otherCanvas = fixture(
    { target: { title: '画布 A', tabId: 999 } },
    { id: 123, url: 'https://canvas.tusi.cn/detail/abc' }
  )
  await otherCanvas.ready()
  assert.equal(otherCanvas.elements['set-target'].hidden, false)
  assert.equal(otherCanvas.elements['set-target'].textContent, '切换')
  assert.equal(otherCanvas.elements['select-media'].disabled, true)

  const ordinaryPage = fixture(
    { target: { title: '画布 A', tabId: 999 } },
    { id: 123, url: 'https://example.test/detail/abc' }
  )
  await ordinaryPage.ready()
  assert.equal(ordinaryPage.elements['set-target'].hidden, true)
  assert.equal(ordinaryPage.elements['select-media'].disabled, false)
})

test('segmented capture makes the next step clear and keeps selection visible', async () => {
  const refreshing = fixture({
    target: { title: '画布 A', tabId: 999 },
    mseCapture: { tabId: 123, phase: 'preparing' },
  })
  await refreshing.ready()
  assert.equal(refreshing.elements['select-media'].disabled, true)
  assert.match(refreshing.elements['capture-hint'].textContent, /刷新/)

  const capturing = fixture({
    target: { title: '画布 A', tabId: 999 },
    mseCapture: { tabId: 123, phase: 'active' },
  })
  await capturing.ready()
  assert.equal(capturing.elements['capture-hint'].textContent, '选取视频后播放')
  assert.equal(capturing.elements['select-media'].textContent, '选取视频')
  assert.equal(capturing.elements['select-media'].disabled, false)

  const selected = fixture({
    target: { title: '画布 A', tabId: 999 },
    mseCapture: { tabId: 123, phase: 'active' },
    selection: {
      mediaKind: 'video',
      url: 'blob:https://example.test/id',
      mse: true,
      tabId: 123,
    },
  })
  await selected.ready()
  assert.equal(selected.elements['selection-panel'].hidden, false)
  assert.equal(selected.elements['import-media'].disabled, false)
  assert.equal(selected.elements['import-media'].textContent, '发送到画布')
})

test('selection from another tab is identified and video capture stays visible', async () => {
  const f = fixture({
    target: { title: '画布 A', tabId: 999 },
    selection: {
      mediaKind: 'video',
      url: 'blob:https://example.test/v',
      mse: true,
      tabId: 456,
    },
    mseCapture: { tabId: 123 },
  })
  await f.ready()
  assert.match(f.elements['selection-detail'].textContent, /其他标签页/)
  assert.match(f.elements['selection-detail'].textContent, /视频片段/)
})

test('video alternate permission requires a separate explicit click, then retries', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: {
      mediaKind: 'video',
      url: 'blob:https://example.test/id',
      videoCandidates: [
        'https://cdn.example.test/video.mp4?token=secret',
        'https://cdn.example.test/another.mp4',
      ],
    },
  })
  f.needVideoPermission()
  await f.ready()
  await f.click('import-media')
  await f.ready()
  assert.equal(f.events.filter((item) => item === 'PERMISSION').length, 0)
  assert.equal(f.elements['authorize-video'].hidden, false)
  await f.click('authorize-video')
  await f.ready()
  assert.equal(f.events.filter((item) => item === 'PERMISSION').length, 1)
  assert.deepEqual(Array.from(f.requested[0].origins), [
    'https://cdn.example.test/*',
  ])
  assert.equal(f.events.filter((item) => item === 'IMPORT').length, 2)
  assert.equal(f.elements['media-feedback'].textContent, '上传完成')
})

test('right-click direct video authorization requests its selected source on explicit retry', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: {
      mediaKind: 'video',
      url: 'https://cdn.example.test/movie.mp4',
      needsVideoPermission: true,
    },
  })
  await f.ready()
  assert.equal(f.elements['authorize-video'].hidden, false)
  assert.equal(f.elements['import-media'].hidden, true)
  assert.equal(f.requested.length, 0)
  await f.click('authorize-video')
  await f.ready()
  assert.deepEqual(Array.from(f.requested[0].origins), [
    'https://cdn.example.test/*',
  ])
  assert.equal(f.events.includes('IMPORT'), true)
})

test('selected image tries import before requesting access', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: {
      mediaKind: 'image',
      url: 'https://cdn.example.test/image.png',
    },
  })
  await f.ready()
  assert.equal(f.elements['selection-panel'].hidden, false)
  await f.click('import-media')
  await f.ready()
  assert.deepEqual(
    f.events.filter((item) => item === 'PERMISSION' || item === 'IMPORT'),
    ['IMPORT']
  )
  assert.equal(f.elements['media-feedback'].textContent, '上传完成')
  assert.equal(f.elements['selection-panel'].hidden, true)
})

test('image source permission is requested only after direct reading fails', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: { mediaKind: 'image', url: 'https://cdn.example.test/pic.png' },
  })
  f.needImagePermission()
  await f.ready()
  await f.click('import-media')
  await f.ready()
  assert.deepEqual(
    f.events.filter((x) => x === 'IMPORT' || x === 'PERMISSION'),
    ['IMPORT']
  )
  assert.equal(f.elements['authorize-video'].hidden, false)
  await f.click('authorize-video')
  await f.ready()
  assert.deepEqual(Array.from(f.requested[0].origins), [
    'https://cdn.example.test/*',
  ])
  assert.deepEqual(
    f.events.filter((x) => x === 'IMPORT' || x === 'PERMISSION'),
    ['IMPORT', 'PERMISSION', 'IMPORT']
  )
})

test('image selected from the context menu exposes authorization directly', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: {
      mediaKind: 'image',
      url: 'https://cdn.example.test/pic.png',
      needsImagePermission: true,
    },
  })
  await f.ready()
  assert.equal(f.elements['authorize-video'].hidden, false)
  await f.click('authorize-video')
  await f.ready()
  assert.deepEqual(Array.from(f.requested[0].origins), [
    'https://cdn.example.test/*',
  ])
  assert.deepEqual(
    f.events.filter((x) => x === 'IMPORT' || x === 'PERMISSION'),
    ['PERMISSION', 'IMPORT']
  )
})

test('the preview belongs to the selected media and accepts only embedded safe images', async () => {
  const f = fixture({
    selection: {
      mediaKind: 'video',
      url: 'blob:https://example.test/video',
      title: '风景视频',
      previewDataUrl: 'data:image/png;base64,AAAA',
    },
    lastDelivery: {
      mediaKind: 'image',
      previewDataUrl: 'data:image/png;base64,BBBB',
    },
  })
  await f.ready()
  assert.equal(
    f.elements['selection-preview'].src,
    'data:image/png;base64,AAAA'
  )
  assert.equal(f.elements['selection-preview'].hidden, false)
  assert.equal(f.elements['selection-title'].textContent, '风景视频')
  assert.equal(f.elements['selection-icon'].hidden, true)
  assert.equal(f.elements['select-media'].textContent, '重新选取')
  assert.equal(f.elements['image-icon'].hidden, true)
  assert.equal(f.elements['video-icon'].hidden, false)
  f.state.selection = {
    mediaKind: 'image',
    url: 'https://example.test/image',
    previewDataUrl: 'https://example.test/tracking',
  }
  f.change({ lastStatus: {} })
  await f.ready()
  assert.equal(f.elements['selection-preview'].hidden, true)
  assert.equal(f.elements['selection-preview'].src, undefined)
  assert.equal(f.elements['selection-icon'].hidden, false)
  assert.equal(f.elements['selection-title'].hidden, true)
  f.state.selection = null
  f.change({ lastStatus: {} })
  await f.ready()
  assert.equal(f.elements['selection-panel'].hidden, true)
  assert.equal(f.elements['import-media'].hidden, true)
  assert.equal(f.elements['select-media'].textContent, '选取素材')
})

test('preview loads after first render and ignores a stale response from another document', async () => {
  const selection = {
    tabId: 123,
    url: 'blob:https://example.test/video',
    frameId: 0,
    documentId: 'first',
    mediaKind: 'video',
  }
  const f = fixture({ selection })
  const replies = new Map()
  f.setPreviewHandler(
    (message) =>
      new Promise((resolve) => replies.set(message.documentId, resolve))
  )
  await f.ready()
  assert.equal(f.elements.panel.dataset.ready, 'true')
  assert.equal(f.elements['selection-preview'].hidden, true)
  assert.equal(f.elements.selection.textContent, '已选中 · 视频')
  f.state.selection = { ...selection, documentId: 'second' }
  f.change({ selection: { newValue: f.state.selection } })
  await f.ready()
  replies.get('first')({
    ok: true,
    selection: {
      ...selection,
      title: '旧视频',
      previewDataUrl: 'data:image/png;base64,AAAA',
    },
  })
  await f.ready()
  assert.equal(f.elements['selection-title'].textContent, '')
  assert.equal(f.elements['selection-preview'].hidden, true)
  replies.get('second')({
    ok: true,
    selection: {
      ...f.state.selection,
      title: '新视频',
      previewDataUrl: 'data:image/png;base64,BBBB',
    },
  })
  await f.ready()
  assert.equal(f.elements['selection-title'].textContent, '新视频')
  assert.equal(
    f.elements['selection-preview'].src,
    'data:image/png;base64,BBBB'
  )
  f.change({ lastStatus: {} })
  await f.ready()
  assert.equal(
    f.events.filter((event) => event === 'GET_SELECTION_PREVIEW').length,
    2
  )
  assert.equal(f.elements['selection-title'].textContent, '新视频')
})

test('a late preview cannot restore a selection that was already sent or cleared', async () => {
  const selection = {
    tabId: 123,
    url: 'https://example.test/image.png',
    frameId: 0,
    mediaKind: 'image',
  }
  const f = fixture({ selection })
  let reply
  f.setPreviewHandler(
    () =>
      new Promise((resolve) => {
        reply = resolve
      })
  )
  await f.ready()
  f.state.selection = null
  f.change({ selection: { newValue: null } })
  await f.ready()
  reply({
    ok: true,
    selection: {
      ...selection,
      title: '过期图片',
      previewDataUrl: 'data:image/png;base64,AAAA',
    },
  })
  await f.ready()
  assert.equal(f.elements['selection-panel'].hidden, true)
  assert.equal(f.elements['selection-preview'].hidden, true)
  assert.equal(f.elements['selection-preview'].src, undefined)
  assert.equal(f.elements['selection-title'].textContent, '')
})

test('the popup has no header tip, recent-send module or separate auto-video card', async () => {
  const html = await readFile(new URL('./popup.html', import.meta.url), 'utf8')
  assert.doesNotMatch(
    html,
    /id="status"|id="recent-delivery"|id="auto-video-options"/
  )
  assert.match(html, /role="switch"/)
  assert.match(html, /role="tooltip"/)
})

test('a handoff is informational and an unsupported format is an error', async () => {
  for (const [message, kind] of [
    ['图片已交给画布', 'info'],
    ['不支持 AVIF', 'error'],
  ]) {
    const f = fixture({
      target: { title: 'Forge' },
      selection: { mediaKind: 'image', url: 'https://cdn.example.test/pic' },
    })
    f.setImportMessage(message)
    await f.ready()
    await f.click('import-media')
    await f.ready()
    assert.equal(f.elements['media-feedback'].textContent, message)
    assert.equal(f.elements['media-status'].dataset.kind, kind)
  }
})

test('permission denial leaves selection available and shows a readable error', async () => {
  const f = fixture({
    target: { title: 'Forge' },
    selection: {
      mediaKind: 'video',
      url: 'https://cdn.example.test/video.mp4',
    },
  })
  await f.ready()
  f.deny()
  await f.click('import-media')
  await f.ready()
  assert.equal(f.elements.selection.textContent, '已选中 · 视频')
  assert.match(f.elements['media-feedback'].textContent, /未授权/)
  assert.equal(f.elements['media-status'].dataset.kind, 'error')
  assert.equal(f.elements['selection-panel'].hidden, false)
  assert.equal(f.events.includes('IMPORT'), false)
})

test('right-click result updates the open popup and clears its busy state', async () => {
  const f = fixture({ target: { title: 'Forge' }, busy: true })
  await f.ready()
  assert.equal(f.elements['select-media'].disabled, true)
  f.state.busy = false
  f.state.lastStatus = '图片已交给画布'
  f.state.lastStatusTabId = 123
  f.state.lastStatusAt = Date.now()
  f.change({ lastStatus: { newValue: '图片已交给画布' } })
  await f.ready()
  assert.equal(f.elements['media-feedback'].textContent, '图片已交给画布')
  assert.equal(f.elements['media-status'].dataset.kind, 'info')
  assert.equal(f.elements['select-media'].disabled, false)
})

test('old or other-tab page notifications are not shown in the popup', async () => {
  for (const status of [
    {
      lastStatus: '素材已发送到画布',
      lastStatusTabId: 124,
      lastStatusAt: Date.now(),
    },
    {
      lastStatus: '素材已发送到画布',
      lastStatusTabId: 123,
      lastStatusAt: Date.now() - 61_000,
    },
  ]) {
    const f = fixture(status)
    await f.ready()
    assert.equal(f.elements['media-feedback'].textContent, '')
  }
})

test('the existing card retains the latest sent clip and its original video timestamps', async () => {
  const f = fixture({
    target: { tabId: 99, title: '测试画布' },
    mediaActivity: {
      id: 'clip',
      mediaKind: 'video',
      status: 'sent',
      title: '演示视频',
      isClip: true,
      sourceStart: 20.1,
      sourceEnd: 30.25,
      hasAudio: false,
      previewDataUrl: 'data:image/png;base64,AQID',
    },
  })
  await f.ready()
  assert.equal(f.elements['guide'].hidden, true)
  assert.equal(f.elements['selection-panel'].hidden, false)
  assert.equal(f.elements['selection'].textContent, '发送完成 · 视频片段')
  assert.equal(f.elements['selection-title'].textContent, '演示视频')
  assert.equal(
    f.elements['selection-detail'].textContent,
    '片段 00:20–00:30 · 无声'
  )
  assert.equal(f.elements['import-media'].hidden, true)
  assert.equal(f.elements['selection-preview'].hidden, false)
  assert.equal(f.elements['view-target'].hidden, false)
  await f.click('view-target')
  await f.ready()
  assert.ok(f.events.includes('VIEW_TARGET'))
  assert.ok(f.events.includes('CLOSE'))
})

test('new activity statuses replace previous feedback without reviving a stale selection', async () => {
  const f = fixture({
    target: { tabId: 99, title: '测试画布' },
    selection: {
      tabId: 1,
      mediaId: 'old',
      mediaKind: 'image',
      url: 'https://example.test/old.png',
    },
    mediaActivity: {
      id: 'new',
      mediaKind: 'video',
      status: 'sending',
      title: '新视频',
      updatedAt: Date.now(),
    },
  })
  await f.ready()
  assert.equal(f.elements['selection'].textContent, '正在发送 · 视频')
  assert.equal(f.elements['import-media'].hidden, true)
  f.state.mediaActivity = {
    ...f.state.mediaActivity,
    status: 'failed',
    message: '不支持这种格式',
  }
  f.change({ mediaActivity: {} })
  await f.ready()
  assert.equal(f.elements['selection'].textContent, '发送失败 · 视频')
  assert.equal(f.elements['media-feedback'].textContent, '不支持这种格式')
  f.state.mediaActivity = { id: 'next', mediaKind: 'image', status: 'selected' }
  f.state.selection = {
    tabId: 1,
    mediaId: 'next',
    mediaKind: 'image',
    url: 'https://example.test/next.png',
  }
  f.change({ mediaActivity: {} })
  await f.ready()
  assert.equal(f.elements['selection'].textContent, '已选中 · 图片')
  assert.equal(f.elements['media-feedback'].textContent, '')
  assert.equal(f.elements['import-media'].hidden, false)
})

test('view remains available during sending and does not start another upload', async () => {
  const f = fixture({
    target: { tabId: 99, title: '接收画布' },
    busy: true,
    mediaActivity: { id: 'busy', mediaKind: 'video', status: 'sending' },
  })
  await f.ready()
  assert.equal(f.elements['view-target'].disabled, false)
  await f.click('view-target')
  assert.ok(f.events.includes('VIEW_TARGET'))
  assert.ok(f.events.includes('CLOSE'))
  assert.equal(f.events.includes('IMPORT'), false)
  f.state.busy = false
  f.change({ lastStatus: {} })
  await f.ready()
})

test('an older pending refresh cannot replace a newer completed media status', async () => {
  const f = fixture({
    target: { title: '画布' },
    mediaActivity: { id: 'clip', mediaKind: 'video', status: 'selected' },
  })
  await f.ready()
  const pending = []
  f.setStateHandler(() => new Promise((resolve) => pending.push(resolve)))
  f.change({ mediaActivity: {} })
  f.change({ mediaActivity: {} })
  assert.equal(pending.length, 2)
  pending[1]({
    ok: true,
    target: { title: '画布' },
    mediaActivity: { id: 'clip', mediaKind: 'video', status: 'sent' },
  })
  await f.ready()
  pending[0]({
    ok: true,
    target: { title: '画布' },
    mediaActivity: { id: 'clip', mediaKind: 'video', status: 'sending' },
  })
  await f.ready()
  assert.equal(f.elements['selection'].textContent, '发送完成 · 视频')
})

test('a fresh panel defaults to automatic preparation and never includes manual capture controls', async () => {
  const f = fixture()
  await f.ready()
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'true'
  )
  assert.equal(f.events.includes('PERMISSION'), false)
  const html = await readFile(new URL('./popup.html', import.meta.url), 'utf8')
  assert.doesNotMatch(
    html,
    /id="(?:video-options|prepare-video|stop-video|video-description)"/
  )
  await f.click('auto-video-toggle')
  await f.ready()
  assert.equal(
    f.elements['auto-video-toggle'].attributes['aria-checked'],
    'false'
  )
})
