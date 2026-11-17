import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const sourceCode = await readFile(
  new URL('./mediaFallback.js', import.meta.url),
  'utf8'
)

test('QQ Music maps a playback control to the one loaded track', () => {
  const anchor = { isConnected: true }
  const control = {
    closest: (selector) => (selector === '.player__ft' ? anchor : null),
  }
  const origin = { children: [], closest: () => control }
  const audio = {
    readyState: 4,
    paused: false,
    currentSrc: 'blob:https://y.qq.com/fixture',
  }
  const old = { ...audio, paused: true }
  const tracks = [audio, old]
  const location = { hostname: 'y.qq.com', pathname: '/n/ryqq_v2/player' }
  const context = vm.createContext({
    location,
    document: { querySelectorAll: () => tracks },
  })
  vm.runInContext(sourceCode, context)
  const find = context.__inkloomMediaFallback.audioPlayer
  assert.equal(find(origin).element, audio)
  assert.equal(find(origin).anchor, anchor)
  assert.equal(find({ children: [], closest: () => null }), null)
  audio.mediaKeys = {}
  assert.equal(find(origin), null)
  delete audio.mediaKeys
  old.paused = false
  assert.equal(find(origin), null)
  old.readyState = 0
  audio.paused = true
  assert.equal(find(origin).element, audio)
  location.pathname = '/n/ryqq_v2/songDetail/sample'
  assert.equal(find(origin), null)
})

test('QQ Music can select complete bytes before native media metadata loads', () => {
  const song = '/n/ryqq_v2/songDetail/sample'
  let trial = false
  const anchor = {
    isConnected: true,
    querySelector: (s) =>
      s.includes('songDetail')
        ? { pathname: song }
        : trial
        ? { textContent: '试听中' }
        : null,
  }
  const control = { closest: () => anchor }
  const origin = { children: [], closest: () => control }
  const audio = {
    src: 'blob:https://y.qq.com/fixture',
    currentSrc: '',
    readyState: 0,
    getAttribute: () => song,
    hasAttribute: () => false,
  }
  const context = vm.createContext({
    location: { hostname: 'y.qq.com', pathname: '/n/ryqq_v2/player' },
    document: { querySelectorAll: () => [], querySelector: () => audio },
  })
  vm.runInContext(sourceCode, context)
  const find = context.__inkloomMediaFallback.audioPlayer
  assert.equal(find(origin).element, audio)
  trial = true
  assert.equal(find(origin), null)
})

test('custom controls select a single hidden native audio inside a compact container', () => {
  const body = { children: [] }
  const audio = {
    tagName: 'AUDIO',
    isConnected: true,
    readyState: 4,
    currentSrc: 'https://media.example/song.mp3',
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  }
  const anchor = {
    children: [audio],
    parentElement: body,
    getBoundingClientRect: () => ({ width: 600, height: 70 }),
  }
  const control = { children: [], parentElement: anchor }
  const context = vm.createContext({
    location: { hostname: 'example.test' },
    document: { body },
    innerHeight: 900,
  })
  vm.runInContext(sourceCode, context)
  const find = context.__inkloomMediaFallback.audioPlayer
  assert.equal(find(control).element, audio)
  assert.equal(find(control).anchor, anchor)
  audio.mediaKeys = {}
  assert.equal(find(control), null)
  delete audio.mediaKeys
  anchor.children.push({ ...audio })
  assert.equal(find(control), null)
  anchor.children.pop()
  anchor.getBoundingClientRect = () => ({ width: 600, height: 850 })
  assert.equal(find(control), null)
})

test('Apple Music associates its detached preview source only with the player bar', () => {
  const audio = {
    tagName: 'AUDIO',
    isConnected: true,
    readyState: 4,
    currentSrc: 'https://audio.example/preview.m4a',
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  }
  const body = { children: [audio] }
  const anchor = { children: [], parentElement: body }
  const control = { children: [], parentElement: anchor, closest: () => anchor }
  const context = vm.createContext({
    location: { hostname: 'music.apple.com' },
    document: {
      body,
      getElementById: (id) => (id === 'apple-music-player' ? audio : null),
    },
  })
  vm.runInContext(sourceCode, context)
  const find = context.__inkloomMediaFallback.audioPlayer
  assert.equal(find(control).element, audio)
  assert.equal(find(control).anchor, anchor)
  assert.equal(
    find({ children: [], parentElement: body, closest: () => null }),
    null
  )
})

function fixture({
  current = 'https://i1.hdslb.com/a.jpg@120w.avif',
  src = '//i1.hdslb.com/a.jpg',
  width = 120,
  dpr = 1,
  sources = [],
  matches = {},
} = {}) {
  const context = vm.createContext({
    URL,
    window: {
      devicePixelRatio: dpr,
      matchMedia: (query) => ({ matches: !!matches[query] }),
    },
  })
  vm.runInContext(sourceCode, context)
  const children = sources.map((attributes) => ({
    tagName: 'SOURCE',
    hasAttribute: (name) => attributes[name] !== undefined,
    getAttribute: (name) => attributes[name] ?? null,
  }))
  const image = {
    currentSrc: current,
    src: new URL(src, 'https://t.bilibili.com/feed').href,
    getAttribute: (name) => (name === 'src' ? src : null),
    ownerDocument: { baseURI: 'https://t.bilibili.com/feed' },
    parentElement: { tagName: 'PICTURE', children },
    getBoundingClientRect: () => ({ width }),
  }
  return { select: () => context.__inkloomMediaFallback.imageUrl(image), image }
}

test('chooses the same Bilibili picture WebP source when AVIF was selected', () => {
  const f = fixture({
    sources: [
      { type: 'image/avif', srcset: '//i1.hdslb.com/a.jpg@120w.avif' },
      { type: 'image/webp', srcset: '//i1.hdslb.com/a.jpg@120w.webp' },
    ],
  })
  assert.equal(f.select(), 'https://i1.hdslb.com/a.jpg@120w.webp')
})

test('resolves srcset and chooses a suitable width without mixing media conditions', () => {
  const f = fixture({
    current: 'https://t.bilibili.com/desktop.avif',
    width: 200,
    dpr: 2,
    sources: [
      {
        type: 'image/avif',
        media: '(min-width: 800px)',
        srcset: '/desktop.avif',
      },
      {
        type: 'image/webp',
        media: '(min-width: 1000px)',
        srcset: '/different.webp 800w',
      },
      {
        type: 'image/webp',
        media: '(min-width: 800px)',
        srcset: '/small.webp 200w, /medium.webp 400w, /large.webp 800w',
      },
    ],
    matches: { '(min-width: 800px)': true, '(min-width: 1000px)': true },
  })
  assert.equal(f.select(), 'https://t.bilibili.com/medium.webp')
})

test('uses declared image fallback if WebP source does not match or has invalid candidates', () => {
  const f = fixture({
    current: 'https://t.bilibili.com/a.avif',
    src: '/a.jpg',
    sources: [
      { type: 'image/avif', srcset: '/a.avif' },
      {
        type: 'image/webp',
        media: '(min-width: 800px)',
        srcset: '/other.webp',
      },
      { type: 'image/webp', srcset: '/bad.webp 0w' },
    ],
  })
  assert.equal(f.select(), 'https://t.bilibili.com/a.jpg')
})

test('does not guess a fallback when none is known to represent the selected image', () => {
  const f = fixture({
    current: 'https://t.bilibili.com/desktop.avif',
    src: '/mobile.jpg',
    sources: [
      {
        type: 'image/avif',
        media: '(min-width: 800px)',
        srcset: '/desktop.avif',
      },
      { type: 'image/webp', srcset: '/mobile.webp' },
    ],
    matches: { '(min-width: 800px)': true },
  })
  assert.equal(f.select(), 'https://t.bilibili.com/desktop.avif')
})

test('leaves ordinary images unchanged and does not invent AVIF alternatives', () => {
  const ordinary = fixture({ current: 'https://i1.hdslb.com/image.webp' })
  assert.equal(ordinary.select(), 'https://i1.hdslb.com/image.webp')
  const outsidePicture = fixture({ current: 'https://i1.hdslb.com/image.avif' })
  outsidePicture.image.parentElement = { tagName: 'DIV' }
  assert.equal(outsidePicture.select(), 'https://i1.hdslb.com/image.avif')
})
