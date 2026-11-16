import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(
  new URL('./background.js', import.meta.url),
  'utf8'
)
const imagePreflight = await readFile(
  new URL('./imagePreflight.js', import.meta.url),
  'utf8'
)
function fixture(mime = 'image/png', controller) {
  let listener
  let installedListener
  let startupListener
  let contextListener
  let removedListener
  let updatedListener
  let menu = null
  const menus = new Map()
  const openedTabs = []
  let grantPermission = true
  let rejectPermissionRequest = false
  let previouslyGranted = false
  let displayedImageAvailable = false
  let contextAlternative = null
  let linkedCandidate = null
  let blobFailure = null
  let responseOverride = null
  let canvasName = null
  let bridgeVersion = '1.0.11'
  let previewResponse = { ok: true }
  const previewCalls = []
  const activityStates = []
  const focusCalls = []
  const scriptCalls = []
  const fetchUrls = []
  const sessionRules = new Map()
  const permissionsRequested = []
  const badges = []
  const storage = {}
  const calls = []
  const captureCalls = []
  const tabs = new Map([
    [
      1,
      { id: 1, url: 'http://localhost:3000/detail/canvas-a', title: '画布 A' },
    ],
    [2, { id: 2, url: 'https://example.com/page', title: '素材网页' }],
  ])
  let targetCanvas = 'canvas-a'
  let activeSession = null
  let uploadBytes = Buffer.from([])
  let dropFailure = null
  let missingAcknowledgement = false
  let endResponseFailure = null
  let documentId = 'document-a'
  let mseClipAudio = null
  const chrome = {
    runtime: {
      id: 'test-id',
      getManifest: () => ({ version: '1.0.11' }),
      getURL: (path) => `chrome-extension://test-id/${path}`,
      onMessage: {
        addListener(fn) {
          listener = fn
        },
      },
      onInstalled: {
        addListener(fn) {
          installedListener = fn
        },
      },
      onStartup: {
        addListener(fn) {
          startupListener = fn
        },
      },
    },
    permissions: {
      request(value) {
        permissionsRequested.push(value)
        if (rejectPermissionRequest)
          return Promise.reject(new Error('No gesture'))
        return Promise.resolve(grantPermission)
      },
      async contains() {
        return previouslyGranted
      },
    },
    declarativeNetRequest: {
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) sessionRules.delete(id)
        for (const rule of addRules) sessionRules.set(rule.id, rule)
      },
    },
    contextMenus: {
      removeAll(done) {
        menus.clear()
        menu = null
        done?.()
      },
      create(value, done) {
        menus.set(value.id, value)
        if (value.id === 'send-media-to-canvas') menu = value
        done?.()
      },
      async update(_id, value) {
        menus.set(_id, { ...menus.get(_id), ...value })
        if (_id === 'send-media-to-canvas') menu = menus.get(_id)
      },
      onClicked: {
        addListener(fn) {
          contextListener = fn
        },
      },
    },
    storage: {
      session: {
        async get() {
          return { ...storage }
        },
        async set(value) {
          if (value.mediaActivity)
            activityStates.push({ ...value.mediaActivity })
          Object.assign(storage, value)
        },
      },
    },
    tabs: {
      async create(options) {
        openedTabs.push(options)
        return { id: 3, ...options }
      },
      onRemoved: {
        addListener(fn) {
          removedListener = fn
        },
      },
      onUpdated: {
        addListener(fn) {
          updatedListener = fn
        },
      },
      async get(id) {
        return tabs.get(id)
      },
      async update(id, options) {
        focusCalls.push({ id, ...options })
        return tabs.get(id)
      },
      async sendMessage(tabId, message, options) {
        if (message.kind === 'READ_MEDIA_PREVIEW') {
          previewCalls.push({ tabId, message, options })
          return typeof previewResponse === 'function'
            ? previewResponse()
            : previewResponse
        }
        if (tabId === 1 && message.kind === 'FORGE_DROP_REQUEST_V2') {
          if (options?.documentId !== documentId)
            throw new Error('document changed')
          const p = message.payload
          calls.push(p)
          if (p.type === 'END' && endResponseFailure === 'disconnect')
            throw new Error('message port closed')
          if (p.type === 'END' && endResponseFailure === 'empty') return null
          if (p.type === 'END' && endResponseFailure === 'wrong-canvas')
            return {
              ok: true,
              bridgeVersion,
              delivered: true,
              canvasId: 'another-canvas',
            }
          if (p.type === 'END' && endResponseFailure === 'old-bridge')
            return {
              ok: true,
              bridgeVersion: '1.0.8',
              delivered: true,
              canvasId: targetCanvas,
            }
          if (p.type === 'ARM') activeSession = p.sessionId
          if (p.type === 'DISARM') activeSession = null
          if (p.type === 'CHUNK')
            uploadBytes = Buffer.concat([
              uploadBytes,
              Buffer.from(p.data, 'base64'),
            ])
          return p.type === 'END' && dropFailure
            ? {
                canvasId: targetCanvas,
                bridgeVersion,
                ok: false,
                error: dropFailure,
              }
            : {
                canvasId: targetCanvas,
                bridgeVersion,
                ...(p.type === 'PING' && canvasName ? { canvasName } : {}),
                ...(p.type === 'END' && !missingAcknowledgement
                  ? { delivered: true }
                  : {}),
                ok:
                  p.type === 'PING' ||
                  p.type === 'ARM' ||
                  p.sessionId === activeSession,
              }
        }
        if (tabId === 2 && mseClipAudio !== null) {
          if (message.kind === 'MSE_SELECT' || message.kind === 'MSE_RELEASE') {
            captureCalls.push({ kind: message.kind, url: message.url, options })
            return {
              ok: true,
              value: message.kind === 'MSE_SELECT' ? { tracks: 1 } : null,
            }
          }
          if (message.kind === 'MSE_SNAPSHOT')
            return {
              ok: true,
              value: {
                size: 3,
                tracks: [
                  {
                    mime: 'video/mp4',
                    timestampOffset: 0,
                    appendWindowStart: 0,
                    appendWindowEnd: null,
                    parts: [3],
                  },
                ],
              },
            }
          if (message.kind === 'MSE_READ')
            return {
              ok: true,
              value: Buffer.from([1, 2, 3]).toString('base64'),
            }
        }
        if (tabId === 2 && message.kind === 'READ_DISPLAYED_IMAGE') {
          if (!displayedImageAvailable)
            return { ok: false, code: 'DISPLAYED_IMAGE_UNAVAILABLE' }
          const sender = {
            id: 'test-id',
            tab: { id: 2 },
            frameId: options?.frameId ?? 0,
            documentId: options?.documentId,
          }
          const meta = await send(
            {
              kind: 'BLOB_META',
              transferId: message.transferId,
              size: 3,
              mime: 'image/png',
            },
            sender
          )
          if (!meta.ok) return meta
          const chunk = await send(
            {
              kind: 'BLOB_CHUNK',
              transferId: message.transferId,
              sequence: 0,
              data: Buffer.from([1, 2, 3]).toString('base64'),
            },
            sender
          )
          if (!chunk.ok) return chunk
          return send(
            { kind: 'BLOB_END', transferId: message.transferId },
            sender
          )
        }
        if (tabId === 2 && message.kind === 'READ_BLOB') {
          assert.equal(
            message.mediaKind,
            mime.startsWith('image/') ? 'image' : 'video'
          )
          if (blobFailure) return blobFailure
          const sender = {
            id: 'test-id',
            tab: { id: 2 },
            frameId: options?.frameId ?? 0,
            documentId: options?.documentId,
          }
          const meta = await send(
            {
              kind: 'BLOB_META',
              transferId: message.transferId,
              size: 3,
              mime,
            },
            sender
          )
          if (!meta.ok) return meta
          const chunk = await send(
            {
              kind: 'BLOB_CHUNK',
              transferId: message.transferId,
              sequence: 0,
              data: Buffer.from([1, 2, 3]).toString('base64'),
            },
            sender
          )
          if (!chunk.ok) return chunk
          return send(
            { kind: 'BLOB_END', transferId: message.transferId },
            sender
          )
        }
        throw new Error(`unexpected tab message: ${tabId} ${message.kind}`)
      },
    },
    scripting: {
      async executeScript(options) {
        scriptCalls.push(options)
        if (options.files?.includes('dropBridge.js'))
          return [{ frameId: 0, documentId }]
        if (options.func?.toString().includes('__inkloomLinkedMedia'))
          return [{ result: linkedCandidate }]
        return options.args?.length === 1
          ? [{ result: contextAlternative || options.args[0] }]
          : []
      },
    },
    action: {
      async setBadgeText(value) {
        badges.push({ ...value })
      },
      async setBadgeBackgroundColor() {},
    },
  }
  const imageBytes = Buffer.alloc(400000)
  if (mime === 'image/avif') {
    Buffer.from([0, 0, 0, 24]).copy(imageBytes)
    imageBytes.write('ftypavif', 4, 'ascii')
  } else if (mime === 'image/webp') {
    imageBytes.write('RIFF', 0, 'ascii')
    imageBytes.writeUInt32LE(imageBytes.length - 8, 4)
    imageBytes.write('WEBPVP8 ', 8, 'ascii')
    imageBytes.writeUInt32LE(imageBytes.length - 20, 16)
  } else {
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBytes)
  }
  const bytes = mime.startsWith('video/')
    ? Buffer.concat([
        Buffer.from([0, 0, 0, 12]),
        Buffer.from('ftypmp42'),
        Buffer.from([0, 0, 0, 8]),
        Buffer.from('moov'),
        Buffer.from([0, 0, 0, 9]),
        Buffer.from('mdatx'),
      ])
    : imageBytes
  vm.runInNewContext(`${imagePreflight}\n${source}`, {
    chrome,
    URL,
    Blob,
    Response,
    Uint8Array,
    checkForgeRelease: async (recheck) => ({
      version: '1.0.15',
      available: true,
      recheck,
    }),
    inkloomMseController: controller,
    __inkloomMseRemux: {
      async remuxCapturedVideo() {
        return {
          blob: new Blob([Buffer.from([1, 2, 3])], { type: 'video/mp4' }),
          hasAudio: mseClipAudio,
        }
      },
    },
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    fetch: async (url) => {
      fetchUrls.push(url)
      if (responseOverride)
        return responseOverride(url, [...sessionRules.values()])
      return new Response(bytes, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.length),
        },
      })
    },
  })
  function send(
    message,
    sender = { id: 'test-id', url: 'chrome-extension://test-id/popup.html' }
  ) {
    return new Promise((resolve) => listener(message, sender, resolve))
  }
  return {
    send,
    calls,
    captureCalls,
    storage,
    bytes,
    uploadBytes: () => uploadBytes,
    changeCanvas: (id) => {
      targetCanvas = id
    },
    failDrop: (error) => {
      dropFailure = error
    },
    omitAcknowledgement: () => {
      missingAcknowledgement = true
    },
    failEndResponse: (failure) => {
      endResponseFailure = failure
    },
    changeDocument: (id) => {
      documentId = id
    },
    install: () => installedListener(),
    startup: () => startupListener(),
    menu: () => menu,
    menus,
    openedTabs,
    context: (info, tab = tabs.get(2)) => contextListener(info, tab),
    removeTab: (id) => removedListener(id),
    updateTab: (id, change) => updatedListener(id, change),
    permissionsRequested,
    badges,
    scriptCalls,
    fetchUrls,
    sessionRules,
    previewCalls,
    activityStates,
    focusCalls,
    setPreviewResponse: (value) => {
      previewResponse = value
    },
    setContextAlternative: (url) => {
      contextAlternative = url
    },
    setLinkedCandidate: (value) => {
      linkedCandidate = value
    },
    setBlobFailure: (value) => {
      blobFailure = value
    },
    setResponse: (value) => {
      responseOverride = value
    },
    setCanvasName: (value) => {
      canvasName = value
    },
    setBridgeVersion: (value) => {
      bridgeVersion = value
    },
    setMseClipAudio: (value) => {
      mseClipAudio = value
    },
    grantExisting: () => {
      previouslyGranted = true
    },
    displayedImage: () => {
      displayedImageAvailable = true
    },
    denyPermission: () => {
      grantPermission = false
    },
    rejectRequest: (granted) => {
      rejectPermissionRequest = true
      previouslyGranted = granted
    },
  }
}

async function selectBlobVideo(f, candidates) {
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'blob:https://example.com/id',
      mediaKind: 'video',
      videoCandidates: candidates,
    },
    { id: 'test-id', tab: { id: 2 } }
  )
}

test('release checks are available to the popup and settings, including settings opened in a tab', async () => {
  const f = fixture()
  const message = { kind: 'CHECK_EXTENSION_UPDATE' }
  const popup = await f.send(message)
  assert.equal(popup.release.version, '1.0.15')
  assert.equal(popup.release.recheck, false)
  const options = await f.send(message, {
    id: 'test-id',
    url: 'chrome-extension://test-id/options.html',
    tab: { id: 3 },
  })
  assert.equal(options.release.available, true)
  assert.equal(options.release.recheck, true)
  const webpage = await f.send(message, {
    id: 'test-id',
    url: 'https://example.com/options.html',
    tab: { id: 2 },
  })
  assert.equal(webpage.ok, false)
})

test('opening, cancelling or failing a picker preserves an existing MSE selection', async () => {
  const f = fixture('video/mp4')
  assert.equal((await f.send({ kind: 'SET_TARGET', tabId: 1 })).ok, true)
  const selected = {
    tabId: 2,
    documentId: 'document-a',
    mse: true,
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  f.storage.selection = selected
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'document-a',
  }
  assert.equal((await f.send({ kind: 'START_PICKER', tabId: 2 })).ok, true)
  assert.equal(f.storage.selection, selected)
  assert.equal((await f.send({ kind: 'PICKER_CANCEL' }, sender)).ok, true)
  assert.equal(f.storage.selection, selected)
  assert.equal((await f.send({ kind: 'START_PICKER', tabId: 2 })).ok, true)
  assert.equal(
    (
      await f.send(
        { kind: 'MEDIA_SELECTED', mediaKind: 'video', url: 'invalid:' },
        sender
      )
    ).ok,
    false
  )
  assert.equal(f.storage.selection, selected)
})

test('switching from an MSE video to an image stops capture only after the replacement is saved', async () => {
  let f
  let stopCalls = 0
  const controller = {
    async recover() {},
    async stop() {
      stopCalls++
      assert.equal(f.storage.selection.mediaKind, 'image')
    },
  }
  f = fixture('image/png', controller)
  assert.equal((await f.send({ kind: 'SET_TARGET', tabId: 1 })).ok, true)
  f.storage.mseCapture = { phase: 'active', tabId: 2, documentId: 'document-a' }
  f.storage.selection = {
    mse: true,
    tabId: 2,
    documentId: 'document-a',
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  assert.equal((await f.send({ kind: 'START_PICKER', tabId: 2 })).ok, true)
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'document-a',
  }
  assert.equal(
    (
      await f.send(
        {
          kind: 'MEDIA_SELECTED',
          mediaKind: 'image',
          url: 'https://example.com/image.png',
        },
        sender
      )
    ).ok,
    true
  )
  assert.equal(stopCalls, 1)
  assert.equal(f.storage.selection.url, 'https://example.com/image.png')
})

test('MSE blob failure can use a granted complete video source on the selected element', async () => {
  const f = fixture('video/mp4')
  f.grantExisting()
  f.setBlobFailure({
    ok: false,
    code: 'VIDEO_BLOB_UNAVAILABLE',
    error: 'unreadable',
  })
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 12]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from('moov'),
    Buffer.from([0, 0, 0, 9]),
    Buffer.from('mdatx'),
  ])
  f.setResponse(
    () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } })
  )
  await selectBlobVideo(f, ['https://cdn.example.com/video.mp4'])
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  assert.deepEqual(f.uploadBytes(), bytes)
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 1)
})

test('MSE fallback never fetches an ungranted source or imports partial responses', async () => {
  for (const granted of [false, true]) {
    const f = fixture('video/mp4')
    if (granted) f.grantExisting()
    f.setBlobFailure({ ok: false, code: 'VIDEO_BLOB_UNAVAILABLE' })
    f.setResponse(
      () =>
        new Response(Buffer.from('0000ftypmp42'), {
          status: 206,
          headers: { 'content-type': 'video/mp4' },
        })
    )
    await selectBlobVideo(f, ['https://cdn.example.com/video.mp4'])
    assert.equal((await f.send({ kind: 'IMPORT' })).ok, false)
    assert.equal(f.fetchUrls.length, granted ? 1 : 0)
    assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
  }
})

test('does not fall back after a blob transfer or upload error', async () => {
  const f = fixture('video/mp4')
  f.grantExisting()
  f.setBlobFailure({ ok: false, error: 'upload failed' })
  await selectBlobVideo(f, ['https://cdn.example.com/video.mp4'])
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, false)
  assert.equal(f.fetchUrls.length, 0)
})

test('an inaccessible direct video can use a granted declared alternate', async () => {
  const f = fixture('video/mp4')
  f.grantExisting()
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 12]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from('moov'),
    Buffer.from([0, 0, 0, 9]),
    Buffer.from('mdatx'),
  ])
  f.setResponse((url) =>
    url.endsWith('/primary.mp4')
      ? new Response('', { status: 403 })
      : new Response(bytes, { headers: { 'content-type': 'video/mp4' } })
  )
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://example.com/primary.mp4',
      mediaKind: 'video',
      videoCandidates: ['https://example.com/alternate.mp4'],
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  assert.deepEqual(f.uploadBytes(), bytes)
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 1)
})

test('direct videos reject HTML, truncated data, and fragmented MP4 before upload', async () => {
  const complete = Buffer.concat([
    Buffer.from([0, 0, 0, 12]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from('moov'),
    Buffer.from([0, 0, 0, 9]),
    Buffer.from('mdatx'),
  ])
  const fragment = Buffer.concat([
    complete,
    Buffer.from([0, 0, 0, 8]),
    Buffer.from('moof'),
  ])
  for (const response of [
    () =>
      new Response('<html>login</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    () =>
      new Response(complete, {
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(complete.length + 3),
        },
      }),
    () =>
      new Response(complete.subarray(0, -1), {
        headers: { 'content-type': 'video/mp4' },
      }),
    () => new Response(fragment, { headers: { 'content-type': 'video/mp4' } }),
    () =>
      new Response(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), {
        headers: { 'content-type': 'video/webm' },
      }),
  ]) {
    const f = fixture('video/mp4')
    f.setResponse(response)
    await f.send({ kind: 'SET_TARGET', tabId: 1 })
    await f.send({ kind: 'START_PICKER', tabId: 2 })
    await f.send(
      {
        kind: 'MEDIA_SELECTED',
        url: 'https://example.com/video',
        mediaKind: 'video',
      },
      { id: 'test-id', tab: { id: 2 } }
    )
    assert.equal((await f.send({ kind: 'IMPORT' })).ok, false)
    assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
  }
})

test('direct finite WebM with tracks and a cluster is accepted', async () => {
  const f = fixture('video/webm')
  const bytes = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00, 0x18, 0x53, 0x80, 0x67, 0x8c, 0x16,
    0x54, 0xae, 0x6b, 0x81, 0x00, 0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00,
  ])
  f.setResponse(
    () => new Response(bytes, { headers: { 'content-type': 'video/webm' } })
  )
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://example.com/video.webm',
      mediaKind: 'video',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  assert.equal(f.calls.find((call) => call.type === 'BEGIN').mime, 'video/webm')
  assert.deepEqual(f.uploadBytes(), bytes)
})

test('uses the actual canvas name returned by the bridge when binding a target', async () => {
  const f = fixture()
  f.setCanvasName('  我的画布  ')
  const result = await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal(result.target.title, '我的画布')
})

test('hover entry only appears for a valid page when auto mode and a target are ready', async () => {
  let enabled = false
  const f = fixture('video/mp4', {
    async recover() {},
    async autoEnabled() {
      return enabled
    },
  })
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  let result = await f.send({ kind: 'HOVER_VIDEO_STATE' }, sender)
  assert.equal(result.enabled, false)
  assert.equal(result.hasTarget, false)
  enabled = true
  result = await f.send({ kind: 'HOVER_VIDEO_STATE' }, sender)
  assert.equal(result.hasTarget, false)
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  result = await f.send({ kind: 'HOVER_VIDEO_STATE' }, sender)
  assert.equal(result.enabled, true)
  assert.equal(result.hasTarget, true)
  const onCanvas = { ...sender, tab: { id: 1 } }
  assert.equal(
    (await f.send({ kind: 'HOVER_VIDEO_STATE' }, onCanvas)).hasTarget,
    false
  )
  assert.equal(
    (
      await f.send(
        { kind: 'HOVER_VIDEO_SEND', url: 'https://example.com/video.mp4' },
        onCanvas
      )
    ).ok,
    false
  )
  const invalid = await f.send(
    { kind: 'HOVER_VIDEO_STATE' },
    { ...sender, frameId: 1 }
  )
  assert.equal(invalid.ok, false)
})

test('hover video sends from the selected page document without changing existing selection', async () => {
  const f = fixture('video/mp4', {
    async recover() {},
    async autoEnabled() {
      return true
    },
  })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  const prior = {
    tabId: 2,
    mediaKind: 'image',
    url: 'https://example.com/a.png',
  }
  f.storage.selection = prior
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  const result = await f.send(
    { kind: 'HOVER_VIDEO_SEND', url: 'https://example.com/video.mp4' },
    sender
  )
  assert.equal(result.ok, true, result.error)
  assert.equal(result.message, '视频已交给画布')
  assert.deepEqual(f.uploadBytes(), f.bytes)
  assert.deepEqual(f.storage.selection, prior)
  const inject = f.scriptCalls.find((call) => call.files?.includes('source.js'))
  assert.equal(inject.target.documentIds[0], 'source-document')
})

test('right-click media entry sends displayed images even with automatic video preparation off', async () => {
  const f = fixture('image/png', {
    recover: async () => {},
    autoEnabled: async () => false,
  })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.displayedImage()
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  const state = await f.send({ kind: 'HOVER_MEDIA_STATE' }, sender)
  assert.equal(state.enabled, true)
  assert.equal(state.hasTarget, true)
  const result = await f.send(
    {
      kind: 'HOVER_MEDIA_SEND',
      mediaKind: 'image',
      url: 'https://example.com/image.png',
    },
    sender
  )
  assert.equal(result.ok, true, result.error)
  assert.equal(result.message, '图片已交给画布')
  assert.equal(f.calls.find((p) => p.type === 'BEGIN').mime, 'image/png')
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.permissionsRequested.length, 0)
})

test('right-click image keeps an unreadable selected resource for explicit popup permission', async () => {
  const f = fixture()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  const result = await f.send(
    {
      kind: 'HOVER_MEDIA_SEND',
      mediaKind: 'image',
      url: 'https://cdn.example.com/img.png',
    },
    { id: 'test-id', tab: { id: 2 }, frameId: 0, documentId: 'source-document' }
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, '请打开插件授权')
  assert.equal(f.storage.selection.needsImagePermission, true)
  assert.equal(f.storage.selection.documentId, 'source-document')
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(
    f.calls.some((p) => p.type === 'BEGIN'),
    false
  )
  assert.equal(f.permissionsRequested.length, 0)
})

test('Weibo right-click uses a temporary rule for only the selected image request', async () => {
  const f = fixture()
  f.grantExisting()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  const url = 'https://wx2.sinaimg.cn/large/photo.png?size=large&foo=a.b'
  f.setResponse((requestUrl, rules) => {
    assert.equal(requestUrl, url)
    assert.equal(rules.length, 1)
    const [rule] = rules
    const filter = new RegExp(rule.condition.regexFilter)
    assert.equal(filter.test(requestUrl), true)
    assert.equal(filter.test(url + '&another=1'), false)
    assert.equal(filter.test(url.replace('a.b', 'axb')), false)
    assert.equal(rule.condition.isUrlFilterCaseSensitive, true)
    assert.deepEqual(Array.from(rule.condition.initiatorDomains), ['test-id'])
    assert.deepEqual(Array.from(rule.condition.resourceTypes), [
      'xmlhttprequest',
    ])
    assert.deepEqual(Array.from(rule.condition.requestMethods), ['get'])
    assert.deepEqual(
      { ...rule.action.requestHeaders[0] },
      {
        header: 'Referer',
        operation: 'set',
        value: 'https://weibo.com/',
      }
    )
    return new Response(f.bytes, { headers: { 'Content-Type': 'image/png' } })
  })
  const result = await f.send(
    { kind: 'HOVER_MEDIA_SEND', mediaKind: 'image', url },
    {
      id: 'test-id',
      tab: { id: 2 },
      frameId: 0,
      documentId: 'source-document',
      url: 'https://weibo.com/ttarticle/p/show?id=123',
    }
  )
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(f.uploadBytes(), f.bytes)
  assert.equal(f.sessionRules.size, 0)
})

test('Weibo popup video removes its request rule after either a failed or successful fetch', async () => {
  const f = fixture('video/mp4')
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  const url = 'https://f.video.weibocdn.com/video.mp4'
  await f.send(
    { kind: 'MEDIA_SELECTED', mediaKind: 'video', url: url + '#t=2' },
    { id: 'test-id', tab: { id: 2 }, url: 'https://weibo.com/tv/show/123' }
  )
  let fails = true
  f.setResponse((requestUrl, rules) => {
    assert.equal(requestUrl, url)
    assert.equal(rules.length, 1)
    assert.equal(new RegExp(rules[0].condition.regexFilter).test(url), true)
    if (fails) throw new TypeError('network failure')
    return new Response(f.bytes, { headers: { 'Content-Type': 'video/mp4' } })
  })
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, false)
  assert.equal(f.sessionRules.size, 0)
  fails = false
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(f.uploadBytes(), f.bytes)
  assert.equal(f.sessionRules.size, 0)
})

test('Weibo native menu uses the clicked frame origin and leaves other requests alone', async () => {
  for (const [frameUrl, srcUrl, expected] of [
    ['https://www.weibo.com/post', 'https://wx2.sinaimg.cn/photo.png', 1],
    [
      'https://weibo.com.example.org/post',
      'https://wx2.sinaimg.cn/photo.png',
      0,
    ],
    ['https://weibo.com/post', 'https://sinaimg.cn.example.org/photo.png', 0],
    [undefined, 'https://wx2.sinaimg.cn/photo.png', 0],
  ]) {
    const f = fixture()
    f.grantExisting()
    await f.send({ kind: 'SET_TARGET', tabId: 1 })
    f.setResponse((_url, rules) => {
      assert.equal(rules.length, expected)
      return new Response(f.bytes, { headers: { 'Content-Type': 'image/png' } })
    })
    f.context({
      menuItemId: 'send-media-to-canvas',
      pageUrl: 'https://weibo.com/post',
      frameUrl,
      frameId: 1,
      mediaType: 'image',
      srcUrl,
    })
    await waitFor(() => f.storage.lastStatus === '图片已交给画布')
    assert.equal(f.fetchUrls.length, 1)
    assert.equal(f.sessionRules.size, 0)
  }
})

test('right-click direct video works without automatic capture and missing CDN access can be retried in popup', async () => {
  const f = fixture('video/mp4', {
    recover: async () => {},
    autoEnabled: async () => false,
  })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  const request = {
    kind: 'HOVER_MEDIA_SEND',
    mediaKind: 'video',
    url: 'https://cdn.example.com/video.mp4',
  }
  const result = await f.send(request, sender)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(f.uploadBytes(), f.bytes)
  f.setResponse(() => {
    throw new TypeError('Failed to fetch')
  })
  const failed = await f.send(request, sender)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, '请打开插件授权')
  assert.equal(f.storage.selection.needsVideoPermission, true)
  assert.equal(f.storage.selection.url, request.url)
  assert.equal(f.permissionsRequested.length, 0)
})

test('right-click media entry rejects invalid source frames and unsupported media', async () => {
  const f = fixture()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  for (const altered of [
    { ...sender, id: 'foreign' },
    { ...sender, frameId: 1 },
    { ...sender, documentId: null },
  ])
    assert.equal(
      (await f.send({ kind: 'HOVER_MEDIA_STATE' }, altered)).ok,
      false
    )
  assert.equal(
    (
      await f.send(
        {
          kind: 'HOVER_MEDIA_SEND',
          mediaKind: 'audio',
          url: 'https://example.com/a.mp3',
        },
        sender
      )
    ).ok,
    false
  )
  assert.equal(
    f.calls.some((p) => p.type === 'BEGIN'),
    false
  )
})

test('right-click entry preserves the select-then-send flow for manual video capture', async () => {
  const f = fixture('video/mp4', {
    recover: async () => {},
    autoEnabled: async () => false,
    stop: async () => {},
  })
  f.setMseClipAudio(false)
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.mseCapture = { phase: 'active', tabId: 2, documentId: 'source-doc' }
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-doc',
  }
  const message = {
    kind: 'HOVER_MEDIA_SEND',
    mediaKind: 'video',
    url: 'blob:https://example.com/video',
  }
  const first = await f.send(message, sender)
  assert.equal(first.ok, true, first.error)
  assert.equal(f.storage.selection.mse, true)
  assert.equal(f.storage.lastStatus, '已选视频，播放后再发送')
  assert.equal(
    f.calls.some((p) => p.type === 'BEGIN'),
    false
  )
  const second = await f.send(message, sender)
  assert.equal(second.ok, true, second.error)
  assert.match(second.message, /视频片段已交给画布/)
  assert.equal(f.storage.selection, null)
})

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for the context-menu action')
}

test('image context menu reports handoff without claiming upload success', async () => {
  const f = fixture('image/png')
  f.grantExisting()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'image',
    srcUrl: 'https://cdn.example.com/photo.png',
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.doesNotMatch(f.storage.lastStatus, /上传成功|上传完成|已保存/)
  assert.deepEqual(f.uploadBytes(), f.bytes)
  const delivery = f.storage.lastDelivery
  assert.equal(delivery.mediaKind, 'image')
  assert.equal(delivery.canvasName, '画布 A')
  assert.equal(
    delivery.filename,
    f.calls.find((call) => call.type === 'BEGIN').filename
  )
  assert.match(delivery.filename, /^FA Image \d+$/)
  assert.ok(Number.isFinite(delivery.timestamp))
  assert.equal('url' in delivery, false)
})

test('a linked image reports handoff as an image, not a video', async () => {
  const f = fixture('image/png')
  f.grantExisting()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'image',
    srcUrl: 'https://cdn.example.com/cover.png',
    linkUrl: 'https://example.com/watch/123',
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.doesNotMatch(f.storage.lastStatus, /视频|上传成功|上传完成|已保存/)
  assert.deepEqual(f.uploadBytes(), f.bytes)
})

test('an AVIF image is rejected before any data reaches the canvas', async () => {
  const f = fixture('image/avif')
  f.grantExisting()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'image',
    srcUrl: 'https://cdn.example.com/cover',
    linkUrl: 'https://example.com/watch/123',
  })
  await waitFor(() => /不支持.*AVIF/i.test(f.storage.lastStatus || ''))
  assert.equal(f.storage.lastStatus, '不支持 AVIF')
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
  assert.equal(f.uploadBytes().length, 0)
})

test('an AVIF response is stopped as soon as its bytes identify the format', async () => {
  const f = fixture('image/avif')
  f.grantExisting()
  let canceled = false
  f.setResponse(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(f.bytes.subarray(0, 64))
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } }
      )
  )
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'image',
    srcUrl: 'https://cdn.example.com/no-extension',
  })
  await waitFor(() => /不支持.*AVIF/i.test(f.storage.lastStatus || ''))
  assert.equal(canceled, true)
  assert.equal(
    f.calls.some((call) => call.type === 'BEGIN'),
    false
  )
})

test('a file extension alone does not claim that its content is AVIF', async () => {
  const f = fixture('image/png')
  f.grantExisting()
  f.setResponse(() => new Response(f.bytes))
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'image',
    srcUrl: 'https://cdn.example.com/cover.avif',
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.doesNotMatch(f.storage.lastStatus, /AVIF/)
  assert.deepEqual(f.uploadBytes(), f.bytes)
})

test('a real video context menu reports video processing without an image-cover hint', async () => {
  const f = fixture('video/mp4')
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'video',
    srcUrl: 'https://cdn.example.com/video.mp4',
    linkUrl: 'https://example.com/watch/123',
  })
  await waitFor(() => f.storage.lastStatus === '视频已交给画布')
  assert.doesNotMatch(f.storage.lastStatus, /图片|上传成功|上传完成|已保存/)
  assert.deepEqual(f.uploadBytes(), f.bytes)
})

test('MSE output reports video processing and retains the no-audio notice', async () => {
  for (const hasAudio of [true, false]) {
    const controller = { async recover() {}, async stop() {} }
    const f = fixture('video/mp4', controller)
    f.setMseClipAudio(hasAudio)
    await f.send({ kind: 'SET_TARGET', tabId: 1 })
    f.storage.mseCapture = {
      phase: 'active',
      tabId: 2,
      documentId: 'document-a',
    }
    f.storage.selection = {
      mse: true,
      tabId: 2,
      documentId: 'document-a',
      mediaKind: 'video',
      url: 'blob:https://example.com/selected',
    }
    const result = await f.send({ kind: 'IMPORT' })
    assert.equal(result.ok, true, result.error)
    assert.match(result.message, /^视频片段已交给画布/)
    assert.doesNotMatch(result.message, /上传成功|上传完成|已保存/)
    assert.equal(result.message.includes('无声'), !hasAudio)
  }
})

test('unreadable video uses the matching automatic capture and releases it', async () => {
  const capture = {
    phase: 'active',
    auto: true,
    tabId: 2,
    documentId: 'auto-document',
  }
  const controller = {
    async recover() {},
    async autoEnabled() {
      return true
    },
    async getAutoCapture(tabId) {
      return tabId === 2 ? capture : null
    },
  }
  const f = fixture('video/mp4', controller)
  f.setMseClipAudio(false)
  f.setBlobFailure({ ok: false, code: 'VIDEO_BLOB_UNAVAILABLE' })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.selection = {
    tabId: 2,
    frameId: 0,
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.message, '视频片段已交给画布（无声）')
  assert.deepEqual(
    f.captureCalls.map((call) => call.kind),
    ['MSE_SELECT', 'MSE_RELEASE']
  )
  assert.equal(f.captureCalls[0].options.documentId, 'auto-document')
  assert.equal(f.storage.lastDelivery.mediaKind, 'video')
})

test('automatic capture quota rejection gives a recovery action without a transfer', async () => {
  const controller = {
    async recover() {},
    async autoEnabled() {
      return true
    },
    async getAutoCapture() {
      return null
    },
    async getAutoDenial() {
      return { reason: 'CAPTURE_LIMIT' }
    },
  }
  const f = fixture('video/mp4', controller)
  f.setBlobFailure({ ok: false, code: 'VIDEO_BLOB_UNAVAILABLE' })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.selection = {
    tabId: 2,
    frameId: 0,
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '视频页过多，请关闭其他视频页后刷新')
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
})

test('right-click exports displayed pixels without requesting access or fetching', async () => {
  const f = fixture()
  f.displayedImage()
  f.install()
  await waitFor(() => f.menu() !== null)
  assert.equal(f.menu().title, '打开 Forge')
  assert.deepEqual(Array.from(f.menu().contexts), ['image', 'video', 'link'])
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal(f.menu().title, '发送到画布')
  const info = {
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'https://cdn.example.com/photo.png',
    mediaType: 'image',
    frameId: 0,
  }
  f.context(info)
  assert.equal(f.permissionsRequested.length, 0)
  f.context(info)
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 1)
  assert.deepEqual(f.uploadBytes(), Buffer.from([1, 2, 3]))
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.permissionsRequested.length, 0)
  await f.send({ kind: 'CLEAR_TARGET' })
  assert.equal(f.menu().title, '打开 Forge')
})

test('right-click keeps a prior selection visible in the badge and scopes its status to the source tab', async () => {
  const f = fixture()
  f.grantExisting()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.selection = {
    tabId: 2,
    mediaKind: 'image',
    url: 'https://example.com/existing.png',
  }
  const before = Date.now()
  f.context({
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'https://cdn.example.com/photo.png',
    mediaType: 'image',
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.equal(f.storage.selection.url, 'https://example.com/existing.png')
  assert.equal(f.badges.at(-1).text, '1')
  assert.equal(f.badges.at(-1).tabId, undefined)
  assert.equal(f.storage.lastStatusTabId, 2)
  assert.ok(f.storage.lastStatusAt >= before)
  assert.ok(f.storage.lastStatusAt <= Date.now())
  const state = await f.send({ kind: 'GET_STATE' })
  assert.equal(state.lastStatusTabId, 2)
  assert.equal(state.lastStatusAt, f.storage.lastStatusAt)
})

test('right-click on a covered media link imports the exact candidate only with an existing grant', async () => {
  const f = fixture()
  f.install()
  f.grantExisting()
  f.setLinkedCandidate({
    mediaKind: 'image',
    url: 'https://cdn.example.com/covered.png',
  })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    linkUrl: 'https://example.com/post/1',
    frameId: 7,
  })
  assert.equal(f.permissionsRequested.length, 0)
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.doesNotMatch(f.storage.lastStatus, /视频|上传成功|上传完成|已保存/)
  assert.equal(f.fetchUrls[0], 'https://cdn.example.com/covered.png')
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 1)
  assert.ok(
    f.scriptCalls.some(
      (call) =>
        call.files?.includes('linkCandidate.js') &&
        call.target.frameIds[0] === 7
    )
  )
})

test('link media requiring a new origin grant is retained for explicit popup authorization', async () => {
  const f = fixture()
  f.install()
  f.setLinkedCandidate({
    mediaKind: 'image',
    url: 'https://new-cdn.example.com/photo.png',
  })
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    linkUrl: 'https://example.com/post/1',
    frameId: 0,
  })
  await waitFor(() => f.storage.lastStatus === '请打开插件授权')
  assert.equal(f.storage.selection.url, 'https://new-cdn.example.com/photo.png')
  assert.equal(f.storage.selection.linkedImage, true)
  assert.equal(f.badges.at(-1).text, '1')
  assert.equal(f.badges.at(-1).tabId, undefined)
  assert.equal(f.permissionsRequested.length, 0)
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
  f.grantExisting()
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.message, '图片已交给画布')
})

test('a covered link replacing an MSE selection stops old capture after preserving the new media', async () => {
  let f
  let stopped = 0
  const controller = {
    async recover() {},
    async stop() {
      stopped++
      assert.equal(
        f.storage.selection.url,
        'https://new-cdn.example.com/photo.png'
      )
    },
  }
  f = fixture('image/png', controller)
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.mseCapture = { phase: 'active', tabId: 2, documentId: 'document-a' }
  f.storage.selection = {
    mse: true,
    tabId: 2,
    documentId: 'document-a',
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  f.setLinkedCandidate({
    mediaKind: 'image',
    url: 'https://new-cdn.example.com/photo.png',
  })
  f.context({
    menuItemId: 'send-media-to-canvas',
    linkUrl: 'https://example.com/post/1',
    frameId: 0,
  })
  await waitFor(() => f.storage.lastStatus === '请打开插件授权')
  assert.equal(stopped, 1)
  assert.equal(f.fetchUrls.length, 0)
})

test('a covered link with an existing grant stops old MSE capture only after upload succeeds', async () => {
  let f
  let stopped = 0
  const controller = {
    async recover() {},
    async stop() {
      stopped++
      assert.equal(f.calls.filter((call) => call.type === 'END').length, 1)
    },
  }
  f = fixture('image/png', controller)
  f.install()
  f.grantExisting()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.mseCapture = { phase: 'active', tabId: 2, documentId: 'document-a' }
  f.storage.selection = {
    mse: true,
    tabId: 2,
    documentId: 'document-a',
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  f.setLinkedCandidate({
    mediaKind: 'image',
    url: 'https://cdn.example.com/photo.png',
  })
  f.context({
    menuItemId: 'send-media-to-canvas',
    linkUrl: 'https://example.com/post/1',
    frameId: 0,
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.equal(stopped, 1)
  assert.equal(f.storage.selection, null)
  assert.equal(f.badges.at(-1).text, '')
})

test('an ambiguous link does not fetch, upload or replace an existing selection', async () => {
  const f = fixture()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.storage.selection = {
    tabId: 2,
    mediaKind: 'image',
    url: 'https://example.com/existing.png',
  }
  f.context({
    menuItemId: 'send-media-to-canvas',
    linkUrl: 'https://example.com/post/1',
    frameId: 0,
  })
  await waitFor(() => f.storage.lastStatus?.includes('无法唯一确定'))
  assert.equal(f.storage.selection.url, 'https://example.com/existing.png')
  assert.equal(f.permissionsRequested.length, 0)
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
})

test('right-click uses a same-origin alternative but never an unapproved origin', async () => {
  for (const [alternative, expected] of [
    [
      'https://cdn.example.com/photo.webp',
      'https://cdn.example.com/photo.webp',
    ],
    [
      'https://other.example.com/photo.webp',
      'https://cdn.example.com/photo.avif',
    ],
  ]) {
    const f = fixture('image/webp')
    f.grantExisting()
    f.install()
    await f.send({ kind: 'SET_TARGET', tabId: 1 })
    f.setContextAlternative(alternative)
    f.context({
      menuItemId: 'send-media-to-canvas',
      srcUrl: 'https://cdn.example.com/photo.avif',
      mediaType: 'image',
      frameId: 7,
    })
    await waitFor(() => f.storage.lastStatus === '图片已交给画布')
    assert.equal(f.fetchUrls[0], expected)
    assert.ok(
      f.scriptCalls.some(
        (call) =>
          call.files?.includes('source.js') && call.target.frameIds[0] === 7
      )
    )
  }
})

test('right-click blob media is read from the selected frame', async () => {
  const f = fixture('image/webp')
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.context({
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'blob:https://example.com/example-id',
    mediaType: 'image',
    frameId: 7,
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.deepEqual(f.uploadBytes(), Buffer.from([1, 2, 3]))
  assert.equal(f.permissionsRequested.length, 0)
})

test('right-click defers origin access without uploading and clears a closed target', async () => {
  const f = fixture()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.denyPermission()
  f.context({
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'https://cdn.example.com/photo.png',
    mediaType: 'image',
  })
  await waitFor(() => f.storage.lastStatus === '请打开插件授权')
  assert.equal(f.storage.selection.needsImagePermission, true)
  assert.equal(
    f.calls.some((call) => call.type === 'BEGIN'),
    false
  )
  f.removeTab(1)
  await waitFor(
    () => f.storage.target === null && f.menu().title === '打开 Forge'
  )
})

test('right-click continues with an existing grant when a synthetic gesture cannot request', async () => {
  const f = fixture()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.rejectRequest(true)
  f.context({
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'https://cdn.example.com/photo.png',
    mediaType: 'image',
  })
  await waitFor(() => f.storage.lastStatus === '图片已交给画布')
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 1)
})

test('right-click asks for authorization when it cannot export the image', async () => {
  const f = fixture()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.rejectRequest(false)
  f.context({
    menuItemId: 'send-media-to-canvas',
    srcUrl: 'https://cdn.example.com/photo.png',
    mediaType: 'image',
  })
  await waitFor(() => f.storage.lastStatus === '请打开插件授权')
  assert.equal(f.storage.selection.needsImagePermission, true)
  assert.equal(
    f.calls.some((call) => call.type === 'BEGIN'),
    false
  )
})

test('target navigation invalidates the menu without affecting unrelated tabs', async () => {
  const f = fixture()
  f.install()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  f.updateTab(2, { status: 'loading' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(f.storage.target)
  f.updateTab(1, { url: 'http://localhost:3000/detail/another-canvas' })
  await waitFor(
    () => f.storage.target === null && f.menu().title === '打开 Forge'
  )
})

test('selected media is transferred in bounded chunks to the explicitly armed canvas', async () => {
  const f = fixture()
  f.grantExisting()
  assert.equal((await f.send({ kind: 'SET_TARGET', tabId: 1 })).ok, true)
  f.storage.lastStatus = '之前右键发送失败'
  assert.equal((await f.send({ kind: 'START_PICKER', tabId: 2 })).ok, true)
  assert.equal(
    (
      await f.send(
        {
          kind: 'MEDIA_SELECTED',
          url: 'https://cdn.example.com/photo.png',
          mediaKind: 'image',
        },
        { id: 'test-id', tab: { id: 2 } }
      )
    ).ok,
    true
  )
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, true)
  assert.match(
    f.calls.find((call) => call.type === 'BEGIN').filename,
    /^FA Image \d{13}$/
  )
  assert.deepEqual(f.uploadBytes(), f.bytes)
  assert.deepEqual(
    f.calls
      .filter((call) => call.type === 'CHUNK')
      .map((call) => call.sequence),
    [0, 1, 2]
  )
  assert.ok(
    f.calls
      .filter((call) => call.type === 'CHUNK')
      .every((call) => call.data.length < 1024 * 1024)
  )
  assert.equal(f.storage.selection, null)
  assert.equal(f.storage.lastStatus, '')
})

test('selected image requests authorization only after displayed pixels are unavailable', async () => {
  const f = fixture()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/photo.png',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  const first = await f.send({ kind: 'IMPORT' })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'IMAGE_SOURCE_PERMISSION')
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.calls.filter((call) => call.type === 'BEGIN').length, 0)
  assert.equal(f.storage.selection.url, 'https://cdn.example.com/photo.png')
  f.grantExisting()
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  assert.deepEqual(f.uploadBytes(), f.bytes)
})

test('video uploads use the specified name without changing the MIME type', async () => {
  const f = fixture('video/mp4')
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/opaque?name=old.webm',
      mediaKind: 'video',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  const before = Date.now()
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  const filename = f.calls.find((call) => call.type === 'BEGIN').filename
  const match = filename.match(/^FA Video (\d{13})$/)
  assert.ok(match)
  assert.ok(Number(match[1]) >= before && Number(match[1]) <= Date.now())
  assert.equal(f.calls.find((call) => call.type === 'BEGIN').mime, 'video/mp4')
})

test('blob media uses the same naming rule', async () => {
  const f = fixture('image/webp')
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'blob:https://example.com/example-id',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  assert.equal((await f.send({ kind: 'IMPORT' })).ok, true)
  assert.match(
    f.calls.find((call) => call.type === 'BEGIN').filename,
    /^FA Image \d{13}$/
  )
  assert.equal(f.calls.find((call) => call.type === 'BEGIN').mime, 'image/webp')
  assert.deepEqual(f.uploadBytes(), Buffer.from([1, 2, 3]))
})

test('reports when the canvas cannot receive the drop without claiming an upload result', async () => {
  const f = fixture()
  f.grantExisting()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/photo.png',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  f.failDrop('DROP_UNAVAILABLE')
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, false)
  assert.match(result.error, /画布当前不能接收拖放/)
})

test('does not report delivery when the drop bridge omits its acknowledgement', async () => {
  const f = fixture()
  f.grantExisting()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/photo.png',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  f.omitAcknowledgement()
  const previous = { mediaKind: 'image', filename: '上一次' }
  f.storage.lastDelivery = previous
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '结果未知，先检查画布')
  assert.equal(f.storage.lastDelivery, previous)
})

for (const failure of ['disconnect', 'empty', 'wrong-canvas', 'old-bridge']) {
  test(`an uncertain ${failure} response does not claim delivery or resend`, async () => {
    const f = fixture()
    f.grantExisting()
    await f.send({ kind: 'SET_TARGET', tabId: 1 })
    await f.send({ kind: 'START_PICKER', tabId: 2 })
    await f.send(
      {
        kind: 'MEDIA_SELECTED',
        url: 'https://cdn.example.com/photo.png',
        mediaKind: 'image',
      },
      { id: 'test-id', tab: { id: 2 } }
    )
    f.failEndResponse(failure)
    const result = await f.send({ kind: 'IMPORT' })
    assert.equal(result.ok, false)
    assert.equal(result.error, '结果未知，先检查画布')
    assert.equal(f.calls.filter((call) => call.type === 'END').length, 1)
  })
}

test('an uncertain drop asks the user to check the canvas before retrying', async () => {
  const f = fixture()
  f.grantExisting()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/photo.png',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  f.failDrop('UNKNOWN_DELIVERY')
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '结果未知，先检查画布')
})

test('rejects unsolicited selection, untrusted target and a changed canvas', async () => {
  const f = fixture()
  assert.equal((await f.send({ kind: 'SET_TARGET', tabId: 2 })).ok, false)
  assert.equal(
    (
      await f.send(
        {
          kind: 'MEDIA_SELECTED',
          url: 'https://example.com/a.png',
          mediaKind: 'image',
        },
        { id: 'test-id', tab: { id: 2 } }
      )
    ).ok,
    false
  )
  assert.equal((await f.send({ kind: 'SET_TARGET', tabId: 1 })).ok, true)
  f.changeCanvas('canvas-b')
  const result = await f.send({ kind: 'START_PICKER', tabId: 2 })
  assert.equal(result.ok, false)
  assert.match(result.error, /画布已切换/)
})

test('binds requests to the exact injected top-level canvas document', async () => {
  const f = fixture()
  const target = await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal(target.ok, true)
  assert.equal(target.target.documentId, 'document-a')
  assert.ok(
    f.scriptCalls.some(
      (call) =>
        call.files?.includes('dropBridge.js') && call.target.frameIds[0] === 0
    )
  )
  f.changeDocument('document-b')
  const result = await f.send({ kind: 'START_PICKER', tabId: 2 })
  assert.equal(result.ok, false)
  assert.match(result.error, /画布已关闭或发生变化/)
})

test('missing or old bridge versions cannot be bound as a destination', async () => {
  for (const version of [undefined, '1.0.8']) {
    const f = fixture()
    f.setBridgeVersion(version)
    const result = await f.send({ kind: 'SET_TARGET', tabId: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.error, '无法连接画布，请刷新画布后重新设置')
    assert.equal(f.storage.target, null)
    assert.equal(
      f.calls.some((call) => call.type === 'ARM' || call.type === 'BEGIN'),
      false
    )
  }
})

test('a destination that reports an older bridge is invalidated before fetching or dropping media', async () => {
  const f = fixture()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  await f.send({ kind: 'START_PICKER', tabId: 2 })
  await f.send(
    {
      kind: 'MEDIA_SELECTED',
      url: 'https://cdn.example.com/photo.png',
      mediaKind: 'image',
    },
    { id: 'test-id', tab: { id: 2 } }
  )
  f.setBridgeVersion('1.0.8')
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '无法连接画布，请刷新画布后重新设置')
  assert.equal(f.storage.target, null)
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(
    f.calls.some((call) => call.type === 'BEGIN'),
    false
  )
})

test('selected preview reads only the pinned source without fetching or mutating selection', async () => {
  const f = fixture()
  const selected = {
    tabId: 2,
    frameId: 0,
    documentId: 'source-doc',
    mediaKind: 'video',
    url: 'blob:https://example.com/selected',
  }
  f.storage.selection = selected
  f.setPreviewResponse({
    ok: true,
    title: '所选视频',
    previewDataUrl: 'data:image/webp;base64,AQID',
  })
  // The first state render does not wait for or inject any thumbnail reader.
  assert.equal(
    (await f.send({ kind: 'GET_STATE' })).selection.url,
    selected.url
  )
  assert.equal(f.scriptCalls.length, 0)
  const result = await f.send({ kind: 'GET_SELECTION_PREVIEW', ...selected })
  assert.equal(result.selection.title, '所选视频')
  assert.equal(result.selection.previewDataUrl, 'data:image/webp;base64,AQID')
  assert.equal(f.previewCalls[0].options.documentId, 'source-doc')
  assert.equal(f.scriptCalls[0].target.documentIds[0], 'source-doc')
  assert.equal(f.storage.selection, selected)
  assert.equal(f.storage.selection.previewDataUrl, undefined)
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.permissionsRequested.length, 0)
  assert.equal(f.calls.length, 0)
})

test('preview requests reject a stale or untrusted selection before touching the page', async () => {
  const f = fixture()
  f.storage.selection = {
    tabId: 2,
    url: 'https://example.com/a.png',
    mediaKind: 'image',
    documentId: 'new-doc',
  }
  const stale = await f.send({
    kind: 'GET_SELECTION_PREVIEW',
    ...f.storage.selection,
    documentId: 'old-doc',
  })
  assert.equal(stale.selection, null)
  const untrusted = await f.send(
    { kind: 'GET_SELECTION_PREVIEW', ...f.storage.selection },
    { id: 'test-id', tab: { id: 2 }, url: 'https://example.com/' }
  )
  assert.equal(untrusted.ok, false)
  assert.equal(f.scriptCalls.length, 0)
})

test('preview failure does not affect selection and late responses never show another media', async () => {
  const f = fixture()
  const selected = {
    tabId: 2,
    url: 'https://example.com/a.png',
    mediaKind: 'image',
  }
  f.storage.selection = selected
  f.setPreviewResponse({
    ok: true,
    title: '图片',
    previewDataUrl: 'https://example.com/remote.png',
  })
  const invalid = await f.send({ kind: 'GET_SELECTION_PREVIEW', ...selected })
  assert.equal(invalid.selection.title, '图片')
  assert.equal(invalid.selection.previewDataUrl, undefined)
  f.setPreviewResponse(() => {
    throw new Error('page closed')
  })
  assert.equal(
    (await f.send({ kind: 'GET_SELECTION_PREVIEW', ...selected })).selection
      .url,
    selected.url
  )
  f.setPreviewResponse(async () => {
    f.storage.selection = { ...selected, url: 'https://example.com/b.png' }
    return {
      ok: true,
      title: '旧图片',
      previewDataUrl: 'data:image/png;base64,AQID',
    }
  })
  assert.equal(
    (await f.send({ kind: 'GET_SELECTION_PREVIEW', ...selected })).selection,
    null
  )
})

test('the latest media survives selected, sending, success and a later failed attempt', async () => {
  const f = fixture('video/mp4')
  await selectBlobVideo(f, [])
  const selected = f.storage.mediaActivity
  assert.equal(selected.status, 'selected')
  assert.equal(selected.id, f.storage.selection.mediaId)
  f.setPreviewResponse({
    ok: true,
    title: '演示视频',
    previewDataUrl: 'data:image/webp;base64,AQID',
    duration: 42,
  })
  const result = await f.send({ kind: 'IMPORT' })
  assert.equal(result.ok, true, result.error)
  assert.equal(f.storage.selection, null)
  assert.equal(f.storage.mediaActivity.status, 'sent')
  assert.equal(f.storage.mediaActivity.title, '演示视频')
  assert.equal(f.storage.mediaActivity.sourceStart, 0)
  assert.equal(f.storage.mediaActivity.sourceEnd, 42)
  assert.ok(f.activityStates.some((a) => a.status === 'sending'))
  assert.match(f.storage.mediaActivity.filename, /^FA Video \d+$/)
  await selectBlobVideo(f, [])
  assert.notEqual(f.storage.mediaActivity.id, selected.id)
  f.setBlobFailure({ ok: false, error: '无法读取视频' })
  const failed = await f.send({ kind: 'IMPORT' })
  assert.equal(failed.ok, false)
  assert.equal(f.storage.mediaActivity.status, 'failed')
  assert.equal(f.storage.mediaActivity.message, '无法读取视频')
  assert.equal(f.storage.mediaActivity.title, '演示视频')
})

test('view canvas focuses the selected canvas only after checking that it is still valid', async () => {
  const f = fixture()
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal((await f.send({ kind: 'VIEW_TARGET' })).ok, true)
  assert.equal(f.focusCalls.length, 1)
  assert.equal(f.focusCalls[0].id, 1)
  assert.equal(f.focusCalls[0].active, true)
  f.changeCanvas('changed')
  assert.equal((await f.send({ kind: 'VIEW_TARGET' })).ok, false)
  assert.equal(f.focusCalls.length, 1)
  assert.equal(
    f.calls.some((c) => c.type === 'BEGIN'),
    false
  )
})

test('common failures use the same short message in the response and media card', async () => {
  for (const [raw, expected] of [
    ['Failed to fetch', '无法获取素材，请重试'],
    ['未捕获视频片段，请刷新网页后重试', '视频尚未准备好'],
    ['暂不支持此视频分段格式', '不支持该视频格式'],
    ['视频备用来源尚未授权，请在插件中选取视频并授权后重试', '请打开插件授权'],
  ]) {
    const f = fixture('video/mp4')
    await selectBlobVideo(f, [])
    f.setBlobFailure({ ok: false, error: raw })
    const result = await f.send({ kind: 'IMPORT' })
    assert.equal(result.ok, false)
    assert.equal(result.error, expected)
    assert.equal(f.storage.mediaActivity.message, expected)
    assert.equal(
      f.fetchUrls.length,
      0,
      'wording does not trigger another fetch or retry'
    )
  }
})

test('missing destination offers Forge home without acquiring media or permissions', async () => {
  const f = fixture()
  f.menus.set('open-forge-home', { id: 'open-forge-home', visible: false })
  f.install()
  await waitFor(() => f.menu()?.title === '打开 Forge')
  assert.equal(f.menus.size, 1)
  assert.equal(f.menu().title, '打开 Forge')
  f.context({
    menuItemId: 'send-media-to-canvas',
    mediaType: 'video',
    srcUrl: 'https://cdn.example/video.mp4',
  })
  await waitFor(() => f.openedTabs.length === 1)
  assert.equal(f.openedTabs[0].url, 'https://forge.art/')
  assert.equal(f.permissionsRequested.length, 0)
  assert.equal(f.fetchUrls.length, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.storage.selection, undefined)
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal(f.menus.size, 1)
  assert.equal(f.menu().title, '发送到画布')
  await f.send({ kind: 'CLEAR_TARGET' })
  assert.equal(f.menu().title, '打开 Forge')
  assert.equal(f.menus.size, 1)
})

test('Forge home entry allows extension UI and authorized top-frame scripts only', async () => {
  const f = fixture()
  const sender = {
    id: 'test-id',
    tab: { id: 2 },
    frameId: 0,
    documentId: 'source-document',
  }
  const state = await f.send({ kind: 'HOVER_MEDIA_STATE' }, sender)
  assert.equal(state.canShow, true)
  assert.equal(state.hasTarget, false)
  assert.equal((await f.send({ kind: 'OPEN_FORGE' })).ok, true)
  assert.equal((await f.send({ kind: 'OPEN_FORGE' }, sender)).ok, true)
  for (const invalid of [
    { ...sender, id: 'other' },
    { ...sender, frameId: 1 },
    { ...sender, documentId: undefined },
  ]) {
    assert.equal((await f.send({ kind: 'OPEN_FORGE' }, invalid)).ok, false)
  }
  assert.equal(f.openedTabs.length, 2)
  assert.equal(f.permissionsRequested.length, 0)
  await f.send({ kind: 'SET_TARGET', tabId: 1 })
  assert.equal(
    (await f.send({ kind: 'HOVER_MEDIA_STATE' }, { ...sender, tab: { id: 1 } }))
      .canShow,
    false
  )
})
