import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('./source.js', import.meta.url), 'utf8')
const imagePreflight = await readFile(
  new URL('./imagePreflight.js', import.meta.url),
  'utf8'
)

function fixture(fetch, failEnd = false, document = null, globals = {}) {
  let listener
  const sent = []
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn
        },
      },
      async sendMessage(message) {
        sent.push(message)
        if (failEnd && message.kind === 'BLOB_END') return { ok: false }
        return { ok: true }
      },
    },
  }
  vm.runInNewContext(`${imagePreflight}\n${source}`, {
    chrome,
    fetch,
    document,
    Blob,
    Uint8Array,
    TypeError,
    URL,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    ...globals,
  })
  const read = (mediaKind) =>
    new Promise((resolve) =>
      listener(
        {
          kind: 'READ_BLOB',
          url: 'blob:https://example.com/test',
          transferId: '1',
          mediaKind,
        },
        {},
        resolve
      )
    )
  const readDisplayed = (url) =>
    new Promise((resolve) =>
      listener(
        {
          kind: 'READ_DISPLAYED_IMAGE',
          url,
          displayUrl: url,
          transferId: '1',
          mediaKind: 'image',
        },
        {},
        resolve
      )
    )
  const readPreview = (message) =>
    new Promise((resolve) =>
      listener({ kind: 'READ_MEDIA_PREVIEW', ...message }, {}, resolve)
    )
  const readCachedAudio = (url) =>
    new Promise((resolve) =>
      listener(
        { kind: 'READ_CACHED_AUDIO', url, mediaKind: 'audio', transferId: '1' },
        {},
        resolve
      )
    )
  return { read, readDisplayed, readPreview, readCachedAudio, sent }
}

test('reads same-origin cached audio without a network request and leaves misses to the importer', async () => {
  const origin = 'https://example.com'
  const url = origin + '/audio.wav'
  const requests = []
  let partial = false
  const f = fixture(
    async (resource, options) => {
      requests.push(resource)
      assert.equal(options.mode, 'same-origin')
      assert.equal(options.cache, 'only-if-cached')
      return new Response(
        new Uint8Array([1, 2, 3]),
        partial
          ? {
              status: 206,
              headers: { 'Content-Range': 'bytes 0-2/10' },
            }
          : undefined
      )
    },
    false,
    null,
    { location: { origin } }
  )
  assert.equal((await f.readCachedAudio(url)).ok, true)
  assert.deepEqual(
    f.sent.map((message) => message.kind),
    ['BLOB_META', 'BLOB_CHUNK', 'BLOB_END']
  )
  partial = true
  assert.equal((await f.readCachedAudio(url)).code, 'CACHED_AUDIO_UNAVAILABLE')
  assert.equal(
    (await f.readCachedAudio('https://cdn.example.com/audio.wav')).code,
    'CACHED_AUDIO_UNAVAILABLE'
  )
  assert.deepEqual(requests, [url, url])
  assert.equal(f.sent.length, 3)
})

function previewFixture({
  media,
  canvas,
  title = ' Selected media ',
  globals = {},
}) {
  const requested = []
  const f = fixture(
    () => assert.fail('a preview must not fetch media'),
    false,
    {
      title,
      querySelectorAll(selector) {
        requested.push(selector)
        return media
      },
      createElement(tag) {
        assert.equal(tag, 'canvas')
        return canvas
      },
    },
    globals
  )
  return { ...f, requested }
}

test('previews selected image pixels at thumbnail size without a network request or upload', async () => {
  const url = 'https://example.com/selected.png'
  const image = {
    currentSrc: url,
    isConnected: true,
    complete: true,
    naturalWidth: 1440,
    naturalHeight: 720,
  }
  const draws = []
  const canvas = {
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
    toDataURL: () => 'data:image/webp;base64,YQ==',
  }
  const f = previewFixture({ media: [image], canvas })
  const result = await f.readPreview({ url, mediaKind: 'image' })
  assert.equal(result.ok, true)
  assert.equal(result.title, 'Selected media')
  assert.equal(result.previewDataUrl, 'data:image/webp;base64,YQ==')
  assert.equal(canvas.width, 144)
  assert.equal(canvas.height, 72)
  assert.deepEqual(draws, [[image, 0, 0, 144, 72]])
  assert.deepEqual(f.requested, ['img'])
  assert.equal(f.sent.length, 0)
})

test('image preview uses the selected displayed element even when its transfer URL differs', async () => {
  const image = {
    src: 'data:image/png;base64,YQ==',
    isConnected: true,
    complete: true,
    naturalWidth: 20,
    naturalHeight: 30,
  }
  const canvas = {
    getContext: () => ({ drawImage: (value) => assert.equal(value, image) }),
    toDataURL: () => 'data:image/png;base64,YQ==',
  }
  const f = previewFixture({
    media: [image, image],
    canvas,
    globals: { __inkloomSelectedImage: image },
  })
  const result = await f.readPreview({
    url: 'blob:https://example.com/picker-transfer',
    displayUrl: image.src,
    mediaKind: 'image',
  })
  assert.equal(result.previewDataUrl, 'data:image/png;base64,YQ==')
  assert.deepEqual(f.requested, [])
})

test('video preview uses only the already decoded current frame of the exact video', async () => {
  const url = 'blob:https://example.com/selected-video'
  const video = {
    currentSrc: url,
    isConnected: true,
    readyState: 2,
    videoWidth: 1080,
    videoHeight: 1920,
  }
  const canvas = {
    getContext: () => ({ drawImage: (value) => assert.equal(value, video) }),
    toDataURL: () => 'data:image/webp;base64,YQ==',
  }
  const f = previewFixture({ media: [video], canvas })
  const result = await f.readPreview({ url, mediaKind: 'video' })
  assert.equal(result.previewDataUrl, 'data:image/webp;base64,YQ==')
  assert.equal(canvas.width, 81)
  assert.equal(canvas.height, 144)
  assert.deepEqual(f.requested, ['video'])
  assert.equal(f.sent.length, 0)
})

test('only the selected QQ Music audio supplies its trial or listed track duration', async () => {
  const url = 'blob:https://y.qq.com/selected-audio'
  const attrs = new Map([
    ['data-forge-qq-song', '/n/ryqq_v2/songDetail/sample'],
    ['data-forge-qq-trial', ''],
  ])
  const media = {
    src: url,
    isConnected: true,
    hasAttribute: (key) => attrs.has(key),
    getAttribute: (key) => attrs.get(key),
  }
  const f = previewFixture({ media: [media] })
  const selection = { url, mediaKind: 'audio' }
  assert.equal((await f.readPreview(selection)).audioScope, 'preview')
  attrs.delete('data-forge-qq-trial')
  attrs.set('data-forge-qq-duration', '189')
  assert.equal((await f.readPreview(selection)).audioTrackDuration, 189)
  assert.equal(
    (await f.readPreview({ ...selection, url: url + '-other' }))
      .audioTrackDuration,
    undefined
  )
})

test('origin-tainted preview pixels retain only a short source title', async () => {
  const url = 'https://cdn.example.com/selected-video.mp4'
  const video = {
    currentSrc: url,
    isConnected: true,
    readyState: 4,
    videoWidth: 640,
    videoHeight: 360,
  }
  const canvas = {
    getContext: () => ({ drawImage() {} }),
    toDataURL() {
      throw new Error('SecurityError')
    },
  }
  const f = previewFixture({ media: [video], canvas, title: 'x'.repeat(250) })
  const result = await f.readPreview({ url, mediaKind: 'video' })
  assert.equal(result.ok, true)
  assert.equal(result.title.length, 160)
  assert.equal(result.previewDataUrl, undefined)
  assert.equal(f.sent.length, 0)
})

test('preview does not guess between duplicate sources or use detached or mismatched media', async () => {
  const url = 'https://example.com/selected.png'
  const image = {
    src: url,
    isConnected: true,
    complete: true,
    naturalWidth: 20,
    naturalHeight: 30,
  }
  for (const media of [
    [image, { ...image }],
    [{ ...image, isConnected: false }],
    [{ ...image, src: url + '?different' }],
  ]) {
    const f = previewFixture({ media, canvas: null })
    const result = await f.readPreview({ url, mediaKind: 'image' })
    assert.equal(result.ok, true)
    assert.equal(result.previewDataUrl, undefined)
    assert.equal(result.title, undefined)
  }
})

test('preview ignores unavailable video frames and oversized or invalid data URIs', async () => {
  const url = 'https://example.com/selected.mp4'
  const video = {
    src: url,
    isConnected: true,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
  }
  const unloaded = previewFixture({ media: [video], canvas: null })
  assert.equal(
    (await unloaded.readPreview({ url, mediaKind: 'video' })).previewDataUrl,
    undefined
  )
  for (const data of [
    'https://example.com/reload.png',
    'data:image/svg+xml;base64,YQ==',
    `data:image/webp;base64,${'a'.repeat(100_000)}`,
  ]) {
    const f = previewFixture({
      media: [{ ...video, readyState: 2, videoWidth: 100, videoHeight: 100 }],
      canvas: {
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => data,
      },
    })
    const result = await f.readPreview({ url, mediaKind: 'video' })
    assert.equal(result.ok, true)
    assert.equal(result.previewDataUrl, undefined)
    assert.equal(f.sent.length, 0)
  }
})

test('exports an already displayed origin-clean image without fetching it', async () => {
  let draws = 0
  const url = 'https://example.com/image.png'
  const image = {
    currentSrc: url,
    isConnected: true,
    complete: true,
    naturalWidth: 2,
    naturalHeight: 1,
  }
  const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  })
  const document = {
    querySelectorAll: () => [image],
    createElement: () => ({
      getContext: () => ({
        drawImage(value) {
          assert.equal(value, image)
          draws++
        },
      }),
      toBlob: (callback) => callback(png),
    }),
  }
  const f = fixture(
    () => assert.fail('unexpected image request'),
    false,
    document
  )
  const result = await f.readDisplayed(url)
  assert.equal(result.ok, true)
  assert.equal(draws, 1)
  assert.equal(f.sent[0].kind, 'BLOB_META')
  assert.equal(f.sent.at(-1).kind, 'BLOB_END')
})

test('cross-origin restrictions and ambiguous image elements fall back before transfer', async () => {
  const url = 'https://example.com/image.png'
  const image = {
    currentSrc: url,
    isConnected: true,
    complete: true,
    naturalWidth: 2,
    naturalHeight: 1,
  }
  const tainted = {
    querySelectorAll: () => [image],
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toBlob() {
        throw new Error('SecurityError')
      },
    }),
  }
  const f = fixture(
    () => assert.fail('unexpected image request'),
    false,
    tainted
  )
  assert.equal((await f.readDisplayed(url)).code, 'DISPLAYED_IMAGE_UNAVAILABLE')
  assert.equal(f.sent.length, 0)
  const ambiguous = fixture(
    () => assert.fail('unexpected image request'),
    false,
    { querySelectorAll: () => [image, image] }
  )
  assert.equal(
    (await ambiguous.readDisplayed(url)).code,
    'DISPLAYED_IMAGE_UNAVAILABLE'
  )
  assert.equal(ambiguous.sent.length, 0)
})

test('an unreadable video blob reports a clear potential cause', async () => {
  const f = fixture(async () => {
    throw new TypeError('Failed to fetch')
  })
  const response = await f.read('video')
  assert.equal(response.ok, false)
  assert.equal(response.error, '无法读取视频，可能是分段播放或来源限制')
  assert.equal(response.code, 'VIDEO_BLOB_UNAVAILABLE')
  assert.equal(f.sent[0].kind, 'BLOB_FAIL')
})

test('image blob errors retain their existing behavior', async () => {
  const f = fixture(async () => {
    throw new TypeError('Failed to fetch')
  })
  const response = await f.read('image')
  assert.equal(response.ok, false)
  assert.equal(response.error, 'Failed to fetch')
})

test('successful video blob transfer still sends its bytes', async () => {
  const f = fixture(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4' },
      })
  )
  assert.equal((await f.read('video')).ok, true)
  assert.deepEqual(
    f.sent.map((item) => item.kind),
    ['BLOB_META', 'BLOB_CHUNK', 'BLOB_END']
  )
  assert.equal(f.sent[0].mime, 'video/mp4')
  assert.deepEqual(
    Buffer.from(f.sent[1].data, 'base64'),
    Buffer.from([1, 2, 3])
  )
})

test('an unlabelled delivery failure is reported as a send failure', async () => {
  const f = fixture(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4' },
      }),
    true
  )
  const result = await f.read('video')
  assert.equal(result.ok, false)
  assert.equal(result.error, '发送失败')
})

test('unsupported AVIF blob is rejected before transfer to the canvas', async () => {
  const avif = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypavif'),
    Buffer.alloc(16),
  ])
  const f = fixture(
    async () =>
      new Response(avif, {
        headers: { 'content-type': 'image/avif' },
      })
  )
  const result = await f.read('image')
  assert.equal(result.ok, false)
  assert.match(result.error, /不支持.*AVIF/i)
  assert.equal(
    f.sent.some((message) => message.kind === 'BLOB_META'),
    false
  )
})

test('a supported PNG blob is transferred to the canvas unchanged', async () => {
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([1, 2, 3]),
  ])
  const f = fixture(
    async () =>
      new Response(png, {
        headers: { 'content-type': 'image/png' },
      })
  )
  assert.equal((await f.read('image')).ok, true)
  assert.deepEqual(Buffer.from(f.sent[1].data, 'base64'), png)
})
