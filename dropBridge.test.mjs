import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('./dropBridge.js', import.meta.url),
  'utf8'
)

function fixture(preview = 'unavailable', { legacy = false } = {}) {
  const listeners = []
  let version = '1.0.11'
  let legacyCalls = 0
  let ready = true
  let blocked = false
  let referenceMode = false
  let acceptDragOver = true
  let acceptDrop = true
  let nodeAtProbe = false
  let viewportReady = true
  let dimensions = null
  let matrix = { is2D: true, a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  let bounds = { left: 0, top: 0, width: 400, height: 300 }
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
  const hit = {
    closest: (selector) =>
      nodeAtProbe && selector.includes('.react-flow__node') ? {} : null,
  }
  const viewport = {}
  const flow = {
    getBoundingClientRect: () => bounds,
    querySelector: (selector) =>
      viewportReady && selector === '.react-flow__viewport' ? viewport : null,
    contains: (node) => node === hit,
    dispatchEvent(event) {
      events.push(event)
      if (
        (event.type === 'dragover' && acceptDragOver) ||
        (event.type === 'drop' && acceptDrop)
      )
        event.preventDefault()
      if (event.type === 'dragover' && !referenceMode)
        event.dataTransfer.dropEffect = 'copy'
      if (event.type === 'drop' && acceptDrop && !referenceMode) {
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
        naturalWidth: dimensions?.width ?? 1200,
        naturalHeight: dimensions?.height ?? 800,
        videoWidth: dimensions?.width ?? 1920,
        videoHeight: dimensions?.height ?? 1080,
        removeAttribute() {
          element.removed = true
        },
        load() {
          element.stopped = true
        },
        set src(value) {
          if (preview === 'metadata')
            queueMicrotask(() => element.onloadedmetadata?.())
          else if (!['stall', 'manual'].includes(preview))
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
      getManifest: () => ({ version }),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const index = listeners.indexOf(fn)
          if (index >= 0) listeners.splice(index, 1)
        },
      },
    },
  }
  const context = vm.createContext({
    chrome,
    document,
    location,
    getComputedStyle: (element) =>
      element === viewport
        ? { transform: JSON.stringify(matrix) }
        : { display: 'block', visibility: 'visible' },
    DOMMatrixReadOnly: class {
      constructor(value) {
        Object.assign(this, JSON.parse(value))
      }
    },
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
  if (legacy) {
    context.__inkloomDropBridge = true
    listeners.push((request, sender, respond) => {
      if (request.kind !== 'INKLOOM_DROP_REQUEST') return
      legacyCalls++
      respond({ ok: true, canvasId: 'canvas-1' })
    })
  }
  vm.runInContext(source, context)
  function send(type, fields = {}, sender = { id: 'extension-id' }) {
    let result
    let resolveResult
    const pending = new Promise((resolve) => {
      resolveResult = resolve
    })
    let settled = false
    for (const listener of [...listeners])
      listener(
        {
          kind: 'FORGE_DROP_REQUEST_V2',
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
          if (settled) return
          settled = true
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
    listeners,
    legacyCalls: () => legacyCalls,
    reinject: (nextVersion = version) => {
      version = nextVersion
      vm.runInContext(source, context)
    },
    setReady: (value) => (ready = value),
    setBlocked: (value) => (blocked = value),
    setReferenceMode: (value) => (referenceMode = value),
    setAcceptDragOver: (value) => (acceptDragOver = value),
    setAcceptDrop: (value) => (acceptDrop = value),
    setNodeAtProbe: (value) => (nodeAtProbe = value),
    setViewportReady: (value) => (viewportReady = value),
    setDimensions: (width, height) => (dimensions = { width, height }),
    setView: (transform, rect = bounds) => {
      matrix = { ...matrix, ...transform }
      bounds = rect
    },
  }
}

async function deliverNext(f, mime = 'image/png') {
  const index = f.events.filter((event) => event.type === 'drop').length
  assert.equal(
    f.send('BEGIN', { filename: `FA media ${index}`, mime, size: 1 }).ok,
    true
  )
  assert.equal(f.send('CHUNK', { sequence: 0, data: 'YQ==' }).ok, true)
  return f.send('END')
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

test('a legacy boolean bridge cannot block the new layout or answer its transfers', async () => {
  const f = fixture('available', { legacy: true })
  f.setDimensions(1600, 900)
  assert.equal(f.send('PING').bridgeVersion, '1.0.11')
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  f.reinject()
  assert.equal((await deliverNext(f)).delivered, true)
  assert.equal(
    f.listeners.length,
    2,
    'one inert legacy listener and one current listener'
  )
  assert.equal(f.legacyCalls(), 0, 'old listeners must not win the reply race')
  assert.deepEqual(
    f.events
      .filter((event) => event.type === 'drop')
      .map((event) => event.clientX),
    [200, 760],
    'reinjection uses display width plus gap, preserves the grid, and drops each file once'
  )
})

test('a newer bridge replaces its listener, clears old transfers and requires a new target session', async () => {
  const f = fixture('available')
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  f.send('BEGIN', { filename: 'interrupted', mime: 'image/png', size: 1 })
  f.reinject('1.0.12')
  assert.equal(f.listeners.length, 1)
  assert.equal(f.send('PING').bridgeVersion, '1.0.12')
  assert.equal(
    f.send('CHUNK', { sequence: 0, data: 'YQ==' }).error,
    'NOT_ARMED'
  )
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  assert.deepEqual(
    f.events
      .filter((event) => event.type === 'drop')
      .map((event) => event.clientX),
    [200, 200]
  )
})

test('single-file imports fill ten columns before starting the next row', async () => {
  const f = fixture('available')
  f.setDimensions(1600, 900)
  f.send('ARM')
  for (let index = 0; index < 21; index++) {
    assert.equal((await deliverNext(f)).delivered, true)
  }
  const points = f.events
    .filter((event) => event.type === 'drop')
    .map((event) => [event.clientX, event.clientY])
  assert.deepEqual(points, [
    [200, 150],
    [760, 150],
    [1320, 150],
    [1880, 150],
    [2440, 150],
    [3000, 150],
    [3560, 150],
    [4120, 150],
    [4680, 150],
    [5240, 150],
    [200, 528],
    [760, 528],
    [1320, 528],
    [1880, 528],
    [2440, 528],
    [3000, 528],
    [3560, 528],
    [4120, 528],
    [4680, 528],
    [5240, 528],
    [200, 906],
  ])
})

test('mixed images and videos start the next row below the tallest media', async () => {
  const f = fixture('available')
  f.send('ARM')
  for (const [width, height, mime] of [
    [1200, 800, 'image/png'],
    [600, 1200, 'image/png'],
    [1920, 1080, 'video/mp4'],
    [4000, 1000, 'image/png'],
    [1000, 1000, 'image/png'],
    [1200, 800, 'image/png'],
    [1920, 1080, 'video/mp4'],
    [1200, 800, 'image/png'],
    [1200, 800, 'image/png'],
    [1200, 800, 'image/png'],
    [1200, 800, 'image/png'],
  ]) {
    f.setDimensions(width, height)
    assert.equal((await deliverNext(f, mime)).delivered, true)
  }
  const last = f.events.at(-1)
  assert.equal(last.clientX, 200)
  assert.equal(last.clientY, 768)
  const points = f.events
    .filter((event) => event.type === 'drop')
    .slice(0, 5)
    .map((event) => [event.clientX, event.clientY])
  assert.deepEqual(points, [
    [200, 150],
    [721, 150],
    [1056, 150],
    [1616, 150],
    [2256, 150],
  ])
})

test('grid positions stay in canvas coordinates when the viewport pans, zooms or resizes', async () => {
  const f = fixture('available')
  f.setView(
    { a: 0.5, d: 0.5, e: 50, f: -30 },
    { left: 100, top: 40, width: 1000, height: 800 }
  )
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  assert.deepEqual(
    [f.events.at(-1).clientX, f.events.at(-1).clientY],
    [600, 440]
  )
  f.setView(
    { a: 2, d: 2, e: -200, f: 100 },
    { left: 60, top: 20, width: 800, height: 600 }
  )
  assert.equal((await deliverNext(f)).delivered, true)
  assert.deepEqual(
    [f.events.at(-1).clientX, f.events.at(-1).clientY],
    [2702, 1840]
  )
})

test('node-covered probes allow fixed placement, while invalid viewport transforms reject it', async () => {
  const f = fixture()
  f.setNodeAtProbe(true)
  assert.equal(f.send('PING').ok, true)
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  f.setViewportReady(false)
  assert.equal(f.send('PING').error, 'CANVAS_NOT_READY')
  f.setViewportReady(true)
  for (const invalid of [
    { a: 0, d: 0 },
    { a: 1, d: 2 },
    { a: 1, d: 1, b: 1 },
    { b: 0, e: Infinity },
  ]) {
    f.setView(invalid)
    assert.equal(f.send('PING').error, 'CANVAS_NOT_READY')
  }
})

test('aborted transfers and rejected drag/drop events do not consume grid slots', async () => {
  const f = fixture()
  f.send('ARM')
  f.send('BEGIN', { filename: 'aborted', mime: 'image/png', size: 1 })
  f.send('ABORT')
  f.setAcceptDragOver(false)
  assert.equal((await deliverNext(f)).error, 'DROP_UNAVAILABLE')
  f.setAcceptDragOver(true)
  f.setAcceptDrop(false)
  assert.equal((await deliverNext(f)).error, 'DROP_UNAVAILABLE')
  f.setAcceptDrop(true)
  assert.equal((await deliverNext(f)).delivered, true)
  assert.deepEqual(
    [f.events.at(-1).clientX, f.events.at(-1).clientY],
    [200, 150]
  )
  assert.equal((await deliverNext(f)).delivered, true)
  assert.equal(f.events.at(-1).clientX, 840)
})

test('uncertain delivery keeps its slot reserved in case the upload completes later', async () => {
  const f = fixture()
  f.send('ARM')
  f.setReferenceMode(true)
  assert.equal((await deliverNext(f)).error, 'UNKNOWN_DELIVERY')
  f.setReferenceMode(false)
  assert.equal((await deliverNext(f)).delivered, true)
  assert.equal(f.events.at(-1).clientX, 840)
})

test('video metadata controls row height even if no preview frame can be decoded', async () => {
  const f = fixture('metadata')
  f.send('ARM')
  f.setDimensions(600, 1200)
  for (let index = 0; index < 11; index++) {
    assert.equal((await deliverNext(f, 'video/mp4')).delivered, true)
  }
  assert.equal(f.events.at(-1).clientY, 768)
})

test('failed preview encoding still preserves dimensions for grid rows', async () => {
  const f = fixture('throw')
  f.send('ARM')
  f.setDimensions(600, 1200)
  for (let index = 0; index < 11; index++) {
    assert.equal((await deliverNext(f)).delivered, true)
  }
  assert.equal(f.events.at(-1).clientY, 768)
})

test('new transfers wait for dimensions, and rearming resets the grid without stale work modifying it', async () => {
  const f = fixture('manual')
  f.send('ARM')
  const pending = deliverNext(f)
  await Promise.resolve()
  assert.equal(
    f.send('BEGIN', { filename: 'too soon', mime: 'image/png', size: 1 }).error,
    'BUSY'
  )
  f.send('DISARM')
  f.setView({ e: 100, f: 40 })
  f.send('ARM')
  assert.equal((await deliverNext(f)).delivered, true)
  await pending
  assert.equal((await deliverNext(f)).delivered, true)
  const points = f.events
    .filter((event) => event.type === 'drop')
    .map((event) => event.clientX)
  assert.deepEqual(points, [200, 200, 840])
})

test('wide media use their capped display width, while narrow media keep the same gap', async () => {
  const f = fixture('available')
  f.send('ARM')
  for (const [width, height] of [
    [4000, 1000],
    [1000, 1000],
    [900, 1600],
  ]) {
    f.setDimensions(width, height)
    assert.equal((await deliverNext(f)).delivered, true)
  }
  const points = f.events.filter((event) => event.type === 'drop')
  assert.deepEqual(
    points.map((event) => event.clientX),
    [200, 840, 1280]
  )
  assert.equal(points[1].clientX - (points[0].clientX + 560), 80)
  assert.equal(points[2].clientX - (points[1].clientX + 360), 80)
})

test('unreadable dimensions reserve the maximum node bounds before wrapping rows', async () => {
  const f = fixture('unavailable')
  f.send('ARM')
  for (let index = 0; index < 11; index++) {
    assert.equal((await deliverNext(f)).delivered, true)
  }
  const points = f.events.filter((event) => event.type === 'drop')
  assert.deepEqual([points[1].clientX, points[1].clientY], [840, 150])
  assert.deepEqual([points[10].clientX, points[10].clientY], [200, 818])
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
