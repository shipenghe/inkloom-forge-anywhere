import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('./dropBridge.js', import.meta.url),
  'utf8'
)

function fixture(preview = 'unavailable') {
  let listener
  let ready = true
  let blocked = false
  let referenceMode = false
  let observerCallback = null
  const events = []
  const canvasContents = []
  const revoked = []
  const previewElements = []
  const location = { pathname: '/detail/canvas-1' }
  class FakeDataTransfer {
    dropEffect = 'none'
    files = []
    items = { add: (file) => this.files.push(file) }
  }
  class FakeDragEvent {
    constructor(type, init) {
      Object.assign(this, init, { type, defaultPrevented: false })
    }
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  const hit = { closest: () => null }
  const flow = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    contains: (node) => node === hit,
    dispatchEvent(event) {
      events.push(event)
      event.preventDefault()
      if (event.type === 'dragover' && !referenceMode)
        event.dataTransfer.dropEffect = 'copy'
      if (event.type === 'drop' && !referenceMode) {
        canvasContents.push({
          matches: () => false,
          children: [],
          textContent: event.dataTransfer.files[0].name,
        })
        observerCallback?.()
      }
      return !event.defaultPrevented
    },
  }
  const root = {
    isConnected: true,
    querySelectorAll: (selector) =>
      selector === '.react-flow'
        ? [flow]
        : selector === '*'
        ? canvasContents
        : [],
    closest: () => null,
  }
  const document = {
    querySelectorAll: () => (ready ? [root] : []),
    elementFromPoint: () => (blocked ? null : hit),
    createElement(tag) {
      if (preview === 'unavailable') throw new Error('No media decoder')
      if (tag === 'canvas')
        return {
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => {
            if (preview === 'throw') throw new Error('Encoder unavailable')
            if (preview === 'large')
              return 'data:image/webp;base64,' + 'A'.repeat(100_001)
            return 'data:image/webp;base64,YQ=='
          },
        }
      const element = {
        tagName: tag.toUpperCase(),
        naturalWidth: 1200,
        naturalHeight: 800,
        videoWidth: 1920,
        videoHeight: 1080,
        removeAttribute() {
          element.removed = true
        },
        load() {
          element.stopped = true
        },
        set src(value) {
          if (preview !== 'stall')
            queueMicrotask(() =>
              tag === 'video' ? element.onloadeddata?.() : element.onload?.()
            )
        },
      }
      previewElements.push(element)
      return element
    },
  }
  const chrome = {
    runtime: {
      id: 'extension-id',
      onMessage: { addListener: (fn) => (listener = fn) },
    },
  }
  vm.runInNewContext(source, {
    chrome,
    document,
    location,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    File,
    Uint8Array,
    URL: {
      createObjectURL: () => 'blob:preview',
      revokeObjectURL: (value) => revoked.push(value),
    },
    DataTransfer: FakeDataTransfer,
    DragEvent: FakeDragEvent,
    MutationObserver: class {
      constructor(fn) {
        observerCallback = fn
      }
      observe() {}
      disconnect() {
        observerCallback = null
      }
    },
    atob,
    setTimeout: (fn, delay) =>
      setTimeout(fn, delay === 5_000 || delay === 1_000 ? 1 : delay),
    clearTimeout,
  })
  function send(type, fields = {}, sender = { id: 'extension-id' }) {
    let result
    let resolveResult
    const pending = new Promise((resolve) => {
      resolveResult = resolve
    })
    listener(
      {
        kind: 'INKLOOM_DROP_REQUEST',
        payload: {
          channel: 'inkloom-media-import-v1',
          from: 'extension',
          type,
          requestId: 'transfer-1',
          canvasId: 'canvas-1',
          sessionId: '0123456789abcdef',
          ...fields,
        },
      },
      sender,
      (response) => {
        result = response
        resolveResult(response)
      }
    )
    return result ?? pending
  }
  return {
    send,
    events,
    revoked,
    previewElements,
    location,
    setReady: (value) => (ready = value),
    setBlocked: (value) => (blocked = value),
    setReferenceMode: (value) => (referenceMode = value),
  }
}

async function deliverPreview(f, mime) {
  f.send('ARM')
  f.send('BEGIN', { filename: 'FA media', mime, size: 1 })
  f.send('CHUNK', { sequence: 0, data: 'YQ==' })
  return f.send('END')
}

test('image and video previews are produced only from delivered file bytes', async () => {
  for (const mime of ['image/png', 'video/mp4']) {
    const f = fixture('available')
    const result = await deliverPreview(f, mime)
    assert.equal(result.delivered, true)
    assert.equal(result.previewDataUrl, 'data:image/webp;base64,YQ==')
    assert.deepEqual(f.revoked, ['blob:preview'])
    if (mime === 'video/mp4') {
      assert.equal(f.previewElements[0].removed, true)
      assert.equal(f.previewElements[0].stopped, true)
    }
  }
})

test('preview failures, size limits and timeouts do not change confirmed delivery', async () => {
  for (const mode of ['unavailable', 'throw', 'large', 'stall']) {
    const f = fixture(mode)
    const result = await deliverPreview(f, 'image/png')
    assert.equal(result.delivered, true)
    assert.equal(result.previewDataUrl, undefined)
    if (mode !== 'unavailable') assert.deepEqual(f.revoked, ['blob:preview'])
  }
})

test('a bound transfer delivers the original bytes as a file drop', async () => {
  const f = fixture()
  assert.equal(f.send('PING').canvasName, '画布 canvas-1')
  assert.equal(f.send('ARM').ok, true)
  assert.equal(
    f.send('BEGIN', {
      filename: 'FA Image 1234567890000',
      mime: 'image/png',
      size: 3,
    }).ok,
    true
  )
  assert.equal(f.send('CHUNK', { sequence: 0, data: 'YWJj' }).ok, true)
  assert.equal((await f.send('END')).delivered, true)
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['dragover', 'drop']
  )
  const file = f.events[1].dataTransfer.files[0]
  assert.equal(file.name, 'FA Image 1234567890000')
  assert.equal(file.type, 'image/png')
  assert.equal(await file.text(), 'abc')
  assert.equal(f.events[1].clientX, 200)
  assert.equal(f.events[1].clientY, 150)
  assert.equal(f.send('DISARM').ok, true)
})

test('missing or covered canvas and reference picking cannot claim delivery', async () => {
  const f = fixture()
  f.setReady(false)
  assert.equal(f.send('PING').error, 'CANVAS_NOT_READY')
  f.setReady(true)
  f.setBlocked(true)
  assert.equal(f.send('PING').error, 'CANVAS_NOT_READY')
  f.setBlocked(false)
  f.setReferenceMode(true)
  f.send('ARM')
  f.send('BEGIN', { filename: 'v', mime: 'video/mp4', size: 1 })
  f.send('CHUNK', { sequence: 0, data: 'YQ==' })
  assert.equal((await f.send('END')).error, 'UNKNOWN_DELIVERY')
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['dragover', 'drop']
  )
})

test('rejects untrusted senders, invalid files, stale navigation and chunks', () => {
  const f = fixture()
  assert.equal(
    f.send('ARM', {}, { id: 'other-extension' }).error,
    'INVALID_REQUEST'
  )
  assert.equal(f.send('BEGIN').error, 'NOT_ARMED')
  f.send('ARM')
  assert.equal(
    f.send('BEGIN', { filename: 'x', mime: 'text/plain', size: 1 }).error,
    'INVALID_FILE'
  )
  assert.equal(
    f.send('BEGIN', {
      filename: 'x',
      mime: 'video/mp4',
      size: 200 * 1024 * 1024 + 1,
    }).error,
    'INVALID_FILE'
  )
  f.send('BEGIN', { filename: 'x', mime: 'video/mp4', size: 2 })
  assert.equal(
    f.send('CHUNK', { sequence: 1, data: 'YQ==' }).error,
    'INVALID_CHUNK'
  )
  f.send('BEGIN', { filename: 'x', mime: 'video/mp4', size: 2 })
  f.send('CHUNK', { sequence: 0, data: 'YQ==' })
  assert.equal(f.send('END').error, 'INCOMPLETE_FILE')
  f.send('BEGIN', { filename: 'x', mime: 'video/mp4', size: 1 })
  f.location.pathname = '/detail/canvas-2'
  assert.equal(
    f.send('CHUNK', { sequence: 0, data: 'YQ==' }).error,
    'CANVAS_CHANGED'
  )
  f.location.pathname = '/detail/canvas-1'
  assert.equal(
    f.send('BEGIN', { filename: 'x', mime: 'video/mp4', size: 1 }).error,
    'NOT_ARMED'
  )
})

test('abort and disarm release a pending transfer', () => {
  const f = fixture()
  f.send('ARM')
  f.send('BEGIN', { filename: 'x', mime: 'image/png', size: 1 })
  assert.equal(f.send('ABORT').ok, true)
  assert.equal(f.send('END').error, 'TRANSFER_NOT_FOUND')
  f.send('BEGIN', { filename: 'x', mime: 'image/png', size: 1 })
  assert.equal(f.send('DISARM').ok, true)
  assert.equal(f.send('END').error, 'NOT_ARMED')
})
