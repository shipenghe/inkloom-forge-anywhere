import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(
  new URL('./qqMusicAudio.js', import.meta.url),
  'utf8'
)
const stream = 'https://ws6.stream.qqmusic.qq.com/preview.mp3'

function fixture(duration = 60) {
  const link = { pathname: '/n/ryqq_v2/songDetail/song' }
  const footer = {
    querySelector(selector) {
      if (selector.includes('songDetail')) return link
      if (selector === '.player_music__try') return { textContent: '试听中' }
      if (selector === '.player_music__time')
        return { textContent: '00:06 / 04:29' }
    },
  }
  const created = []
  const listeners = new Map()
  const audio = {
    duration,
    attributes: new Map(),
    addEventListener: (name, listener) => listeners.set(name, listener),
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    remove() {
      this.removed = true
    },
  }
  let changeTrack
  let pending
  const context = vm.createContext({
    URL: class extends URL {
      static createObjectURL(blob) {
        created.push(blob)
        return 'blob:test'
      }
      static revokeObjectURL() {}
    },
    Request,
    Blob,
    location: new URL('https://y.qq.com/n/ryqq_v2/player'),
    MutationObserver: class {
      constructor(callback) {
        changeTrack = callback
      }
      observe() {}
      disconnect() {}
    },
    document: {
      querySelector: () => footer,
      createElement: () => audio,
      body: { append() {} },
    },
    window: { fetch: () => Promise.resolve(pending), addEventListener() {} },
  })
  vm.runInContext(script, context)
  return {
    created,
    audio,
    listeners,
    changeSong() {
      link.pathname += '2'
      changeTrack()
    },
    async load(start, bytes, url = stream, mime = 'audio/mpeg') {
      const waiting = new Response(bytes, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(bytes.length),
          'Content-Range': `bytes ${start}-${start + bytes.length - 1}/4`,
        },
      })
      Object.defineProperty(waiting, 'url', { value: url })
      pending = waiting
      assert.equal(await context.window.fetch(url), waiting)
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('joins already loaded MP3 ranges only after complete coverage and clears on song change', async () => {
  const f = fixture()
  await f.load(2, 'cd')
  assert.equal(f.created.length, 0)
  await f.load(0, 'ab')
  assert.equal(await f.created[0].text(), 'abcd')
  assert.equal(f.audio.attributes.has('data-forge-qq-song'), false)
  f.listeners.get('loadedmetadata')()
  assert.equal(
    f.audio.attributes.get('data-forge-qq-song'),
    '/n/ryqq_v2/songDetail/song'
  )
  f.changeSong()
  assert.equal(f.audio.removed, true)
})

test('does not join different streams or expose the full file underneath a trial', async () => {
  const different = fixture()
  await different.load(0, 'ab')
  await different.load(2, 'cd', stream.replace('preview', 'different'))
  assert.equal(different.created.length, 0)

  const trial = fixture(269)
  await trial.load(0, 'abcd')
  trial.listeners.get('loadedmetadata')()
  assert.equal(trial.audio.attributes.has('data-forge-qq-song'), false)
  assert.equal(trial.audio.removed, true)
})

test('preserves the M4A format when joining the web player’s audio/mp4 ranges', async () => {
  const f = fixture()
  const m4a = stream.replace('.mp3', '.m4a')
  await f.load(0, 'ab', m4a, 'audio/mpeg')
  await f.load(2, 'cd', m4a, 'audio/mp4')
  assert.equal(f.created.length, 0)
  await f.load(0, 'ab', m4a, 'audio/mp4')
  assert.equal(f.created[0].type, 'audio/mp4')
  assert.equal(await f.created[0].text(), 'abcd')
})
