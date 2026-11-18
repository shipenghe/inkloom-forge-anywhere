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
  // Kuwo's elapsed-time label is eight levels below the playback bar.
  let nestedControl = control
  for (let depth = 1; depth < 8; depth++)
    nestedControl = { children: [], parentElement: nestedControl }
  assert.equal(find(nestedControl)?.element, audio)
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

test('a transparent full-slide control targets the fitted photo above its backdrop', () => {
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  const slide = rect(0, 0, 664, 633)
  const photo = {
    complete: true,
    naturalWidth: 2132,
    naturalHeight: 4096,
    currentSrc: 'https://example.test/photo.jpg',
    getBoundingClientRect: () => rect(180, 24, 304.5, 585),
  }
  const backdrop = {
    ...photo,
    currentSrc: 'https://example.test/backdrop.jpg',
    getBoundingClientRect: () => slide,
  }
  const images = [backdrop, photo]
  const videos = []
  const container = {
    getBoundingClientRect: () => slide,
    querySelectorAll: (selector) => (selector === 'video' ? videos : images),
  }
  const button = {
    tagName: 'BUTTON',
    parentElement: container,
    getBoundingClientRect: () => slide,
  }
  const style = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' }
  const context = vm.createContext({
    document: {},
    innerWidth: 1100,
    innerHeight: 800,
    getComputedStyle: () => style,
  })
  vm.runInContext(sourceCode, context)
  const find = () =>
    context.__inkloomMediaFallback.coveredImage(button, 330, 300, () => true)
  assert.equal(find().element, photo)
  photo.complete = false
  assert.equal(find().element, null)
  photo.complete = true
  images.push({ ...photo })
  assert.equal(find().ambiguous, true)
  images.pop()
  videos.push({ readyState: 2 })
  assert.equal(find(), null)
  videos.pop()
  style.backgroundColor = 'rgb(255, 255, 255)'
  assert.equal(find(), null)
})

test('a plain full-size overlay can identify the decoded video beneath its aligned hit layers', () => {
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  const aligned = rect(20.5, 51, 285, 506)
  const player = rect(20, 50, 286, 508)
  const node = (tagName, parentElement, bounds = aligned) => ({
    tagName,
    parentElement,
    style: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' },
    getBoundingClientRect: () => bounds,
    matches: () => false,
    contains(other) {
      for (let current = other; current; current = current.parentElement)
        if (current === this) return true
      return false
    },
  })
  const body = node('BODY')
  const frame = node('DIV', body, player)
  const overlay = node('DIV', frame)
  const origin = node('DIV', overlay)
  const scrim = node('DIV', frame)
  const video = Object.assign(node('VIDEO', frame, player), {
    readyState: 4,
    videoWidth: 540,
    videoHeight: 960,
    currentSrc: 'blob:https://example.test/clip',
  })
  let stack = [origin, scrim, overlay, video, frame, body]
  const context = vm.createContext({
    document: { body, elementsFromPoint: () => stack },
    getComputedStyle: (layer) => layer.style,
  })
  vm.runInContext(sourceCode, context)
  const find = () =>
    context.__inkloomMediaFallback.coveredVideo(
      [origin, overlay, frame, body],
      100,
      100,
      () => true
    )
  assert.equal(find()?.element, video)

  scrim.style.backgroundImage = 'url("https://example.test/poster.jpg")'
  assert.equal(find()?.element, null)
  scrim.style.backgroundImage = 'none'

  const foreign = node('DIV', body)
  stack = [origin, foreign, overlay, video, frame, body]
  assert.equal(find()?.element, null)

  const control = node('DIV', frame, rect(20, 50, 60, 60))
  stack = [origin, control, overlay, video, frame, body]
  assert.equal(find()?.element, null)

  const surface = node('CANVAS', frame)
  stack = [origin, surface, overlay, video, frame, body]
  assert.equal(find()?.element, null)

  stack = [origin, scrim, overlay, frame, body]
  assert.equal(find(), null)

  const second = { ...video }
  stack = [origin, scrim, overlay, video, second, frame, body]
  assert.equal(find()?.ambiguous, true)
  assert.equal(find().element, null)
})

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
