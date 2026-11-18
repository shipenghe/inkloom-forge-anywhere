import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  BufferSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { remuxCapturedVideo } from './mseRemux.mjs'

const script = readFileSync(
  new URL('./mseCaptureMain.js', import.meta.url),
  'utf8'
)
function setup({
  nav = 'reload',
  age = 60000,
  marker = true,
  automatic = false,
} = {}) {
  const ctx = vm.createContext({})
  vm.runInContext(
    `
    let nextUrl = 1
    globalThis.URL = { createObjectURL() { return 'blob:fixture/' + nextUrl++ }, revokeObjectURL() {} }
    globalThis.SourceBuffer = class SourceBuffer {
      constructor() { this.mode='segments'; this.timestampOffset=0; this.appendWindowStart=0; this.appendWindowEnd=Infinity }
      appendBuffer() { if (this.offsetAfterAppend !== undefined) this.timestampOffset = this.offsetAfterAppend } changeType() {} abort() {}
    }
    globalThis.MediaSource = class MediaSource { addSourceBuffer() { return new SourceBuffer() } }
    globalThis.videos = []
    globalThis.document = { querySelectorAll() { return videos } }
    globalThis.sessionStorage = {
      value: JSON.stringify({nonce:'1234567890123456', expiresAt:Date.now()+${age}}),
      getItem() { return this.value }, removeItem() { this.value = null }
    }
    globalThis.performance = { getEntriesByType() { return [{ type:'${nav}' }] } }
    if (!${marker}) sessionStorage.value = null
    globalThis.__inkloomMseAutoStart = ${automatic}
    globalThis.crypto = { getRandomValues(bytes) { bytes.fill(42); return bytes } }
    globalThis.window = globalThis
    window.innerWidth = 1000; window.innerHeight = 800
    window.getComputedStyle = (node) => ({display:node.display || 'block', visibility:node.visibility || 'visible', opacity:node.opacity || '1'})
    globalThis.visible = (url, overrides = {}) => ({
      currentSrc:url, isConnected:true, nodeType:1, parentElement:null,
      getBoundingClientRect() { return {left:0, top:0, right:640, bottom:360, width:640, height:360} },
      ...overrides,
    })
    globalThis.listeners = new Map()
    window.addEventListener = (type, cb) => listeners.set(type, cb)
    window.removeEventListener = (type, cb) => { if (listeners.get(type) === cb) listeners.delete(type) }
    window.postMessage = () => {}
    globalThis.box = (type, payload = [1]) => {
      const bytes = new Uint8Array(8 + payload.length)
      new DataView(bytes.buffer).setUint32(0, bytes.length)
      for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i)
      bytes.set(payload, 8)
      return bytes
    }
    globalThis.concat = (...parts) => {
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let pos = 0
      for (const p of parts) { bytes.set(p, pos); pos += p.length }
      return bytes
    }
  `,
    ctx
  )
  vm.runInContext(script, ctx)
  return (code) => vm.runInContext(code, ctx)
}

test('keeps only initialization before selection and captures only selected MediaSource afterward', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.b = new MediaSource()
    globalThis.aurl = URL.createObjectURL(a); globalThis.burl = URL.createObjectURL(b)
    globalThis.at = a.addSourceBuffer('video/mp4; codecs="avc1"')
    globalThis.bt = b.addSourceBuffer('video/mp4; codecs="avc1"')
    at.appendBuffer(concat(box('ftyp'), box('moov'), box('moof', [11]), box('mdat', [12])))
    bt.appendBuffer(concat(box('ftyp'), box('moov')))
    videos.push({ currentSrc: aurl })
    __inkloomMseCapture.select(aurl)
    bt.appendBuffer(box('mdat', [66]))
    at.appendBuffer(concat(box('moof', [22]), box('mdat', [23])))
  `)
  const result = run('__inkloomMseCapture.snapshot()')
  assert.equal(result.tracks.length, 1)
  assert.deepEqual(Array.from(result.tracks[0].parts), [9, 9, 9, 9])
  assert.equal(run('__inkloomMseCapture.read(0, 2, 0, 9).at(-1)'), 22)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 23)
  assert.equal(
    run(
      'String.fromCharCode(...__inkloomMseCapture.read(0, 0, 0, 9).slice(4, 8))'
    ),
    'ftyp'
  )
  assert.throws(
    () => run('__inkloomMseCapture.read(0, 0, 0, 192 * 1024 + 1)'),
    /参数/
  )
})

test('reselecting the same video retains its captured bytes, while a different video is rejected', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.b = new MediaSource()
    globalThis.aurl = URL.createObjectURL(a); globalThis.burl = URL.createObjectURL(b)
    globalThis.at = a.addSourceBuffer('video/mp4'); globalThis.bt = b.addSourceBuffer('video/mp4')
    at.appendBuffer(concat(box('ftyp'), box('moov')))
    bt.appendBuffer(concat(box('ftyp'), box('moov')))
    videos.push(visible(aurl), visible(burl))
    __inkloomMseCapture.select(aurl)
    at.appendBuffer(concat(box('moof', [31]), box('mdat', [32])))
    __inkloomMseCapture.select(aurl)
  `)
  assert.throws(() => run('__inkloomMseCapture.select(burl)'), /已有正在采集/)
  const result = run('__inkloomMseCapture.snapshot()')
  assert.deepEqual(Array.from(result.tracks[0].parts), [9, 9, 9, 9])
  assert.equal(run('__inkloomMseCapture.read(0, 2, 0, 9).at(-1)'), 31)
})

test('reselection requires the exact same unique video and cannot reuse frozen data', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'), box('moov')))
    videos.push(visible(url)); __inkloomMseCapture.select(url)
    track.appendBuffer(concat(box('moof'), box('mdat')))
    videos.push(visible(url))
  `)
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /唯一/)
  run('videos.pop(); __inkloomMseCapture.snapshot()')
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /已有正在采集/)
})

test('retains already-buffered segments only for the sole visible video once selected', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[21]),box('mdat',[22])))
    __inkloomMseCapture.select(url)
  `)
  assert.deepEqual(
    Array.from(run('__inkloomMseCapture.snapshot().tracks[0].parts')),
    [9, 9, 9, 9]
  )
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 22)
})

test('does not retain preselection media when multiple videos are visible', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.b = new MediaSource()
    globalThis.aurl = URL.createObjectURL(a); globalThis.burl = URL.createObjectURL(b)
    globalThis.at = a.addSourceBuffer('video/mp4'); globalThis.bt = b.addSourceBuffer('video/mp4')
    videos.push(visible(aurl), visible(burl))
    at.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[11]),box('mdat',[12])))
    bt.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[21]),box('mdat',[22])))
    __inkloomMseCapture.select(aurl)
  `)
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
  run(`at.appendBuffer(concat(box('moof',[31]),box('mdat',[32])))`)
  run('__inkloomMseCapture.snapshot()')
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 32)
})

test('drops preselection data if another video appears or selected element changes', () => {
  for (const change of [
    `videos.push(visible('blob:another'))`,
    `videos[0] = visible(url)`,
  ]) {
    const run = setup()
    run(
      `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url)); track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof'),box('mdat'))); ${change}; __inkloomMseCapture.select(url)`
    )
    assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
  }
})

test('ignores hidden or offscreen video elements when identifying the sole visible player', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url), visible('blob:hidden',{display:'none'}), visible('blob:offscreen',{getBoundingClientRect(){return {left:1100,top:0,right:1200,bottom:100,width:100,height:100}}})); track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof'),box('mdat'))); __inkloomMseCapture.select(url)`
  )
  assert.equal(run('__inkloomMseCapture.snapshot().tracks.length'), 1)
})

test('drops older provisional fragments when the shared memory budget would overflow', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url)); track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[11]),box('mdat',[12]))); track.appendBuffer(new Uint8Array(64 * 1024 * 1024 + 1)); track.appendBuffer(concat(box('moof',[21]),box('mdat',[22]))); __inkloomMseCapture.select(url)`
  )
  run('__inkloomMseCapture.snapshot()')
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 22)
})

test('rejects ambiguous videos, unknown players, missing initialization and missing segments', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push({currentSrc:url}, {currentSrc:url})`
  )
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /唯一/)
  run('videos.pop()')
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
  run(
    "track.appendBuffer(concat(box('ftyp'), box('moov'))); __inkloomMseCapture.select(url)"
  )
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
})

test('keeps a revoked MediaSource URL associated with its already attached video', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'), box('moov')))
    videos.push({currentSrc:url}); URL.revokeObjectURL(url)
    __inkloomMseCapture.select(url)
    track.appendBuffer(concat(box('moof'),box('mdat')))
  `)
  assert.equal(run('__inkloomMseCapture.snapshot().tracks.length'), 1)
})

test('distinguishes an unknown player from a known player without media tracks', () => {
  const unknown = setup()
  unknown('videos.push({currentSrc:"blob:fixture/unknown"})')
  assert.throws(
    () => unknown('__inkloomMseCapture.select("blob:fixture/unknown")'),
    /无法关联该视频的播放器/
  )
  const pending = setup()
  pending(
    'globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); videos.push({currentSrc:url})'
  )
  assert.throws(
    () => pending('__inkloomMseCapture.select(url)'),
    /尚未加载媒体轨道/
  )
})

test('bounds retained MediaSource URL associations', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.urls = []
    for (let i = 0; i < 65; i++) urls.push(URL.createObjectURL(a))
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'),box('moov')))
    videos.push({currentSrc:urls[64]})
  `)
  assert.throws(
    () => run('__inkloomMseCapture.select(urls[64])'),
    /无法关联该视频的播放器/
  )
  run('videos[0].currentSrc = urls[0]; __inkloomMseCapture.select(urls[0])')
  assert.equal(run('__inkloomMseCapture.snapshot instanceof Function'), true)
})

test('tracks a new URL for an existing source even at the source limit', () => {
  const run = setup()
  run(`
    globalThis.sources = Array.from({length:16}, () => new MediaSource())
    for (const source of sources) URL.createObjectURL(source)
    globalThis.track = sources[0].addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'),box('moov')))
    globalThis.again = URL.createObjectURL(sources[0]); videos.push({currentSrc:again})
    __inkloomMseCapture.select(again)
    track.appendBuffer(concat(box('moof'),box('mdat')))
  `)
  assert.equal(run('__inkloomMseCapture.snapshot().tracks.length'), 1)
})

test('rejects a changed selected source and releases hooks on stop', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({ currentSrc: url }); __inkloomMseCapture.select(url); track.appendBuffer(box('mdat')); videos[0].currentSrc = 'blob:different'`
  )
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /变化/)
  run('__inkloomMseCapture.stop()')
  assert.equal(run('typeof __inkloomMseCapture'), 'undefined')
  assert.equal(run('listeners.has("message")'), false)
})

test('rejects a selected video removed from the document even if its URL is unchanged', () => {
  const run = setup()
  run(`
    globalThis.source = new MediaSource()
    globalThis.url = URL.createObjectURL(source)
    globalThis.track = source.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'), box('moov')))
    globalThis.video = visible(url)
    videos.push(video)
    __inkloomMseCapture.select(url)
    track.appendBuffer(concat(box('moof'), box('mdat')))
    video.isConnected = false
  `)
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /视频来源已变化/)
  run('video.isConnected = true')
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /视频来源已变化/)
})

test('does not mistake partial MP4 boxes or mixed initialization/media as full preselected media', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push({currentSrc:url}); track.appendBuffer(new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]));`
  )
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
})

test('retains initialization and media boxes across append boundaries', () => {
  const run = setup()
  run(`
    globalThis.source = new MediaSource(); globalThis.url = URL.createObjectURL(source)
    globalThis.track = source.addSourceBuffer('video/mp4'); videos.push(visible(url))
    let init = concat(box('ftyp'),box('moov',[11,12]))
    let media = concat(box('moof',[21]),box('mdat',[22,23]))
    track.appendBuffer(init.slice(0,5))
    track.appendBuffer(init.slice(5,-1))
    track.appendBuffer(concat(init.slice(-1),media.slice(0,12)))
    __inkloomMseCapture.select(url)
    track.appendBuffer(media.slice(12))
  `)
  const result = run('__inkloomMseCapture.snapshot()')
  assert.deepEqual(Array.from(result.tracks[0].parts), [9, 10, 9, 10])
  assert.equal(run('__inkloomMseCapture.read(0, 1, 8, 2).at(-1)'), 12)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 8, 2).at(-1)'), 23)
})

test('remuxes real MP4 initialization without an appended ftyp box', async () => {
  const fixture = readFileSync(
    new URL('./fixtures/remux-sample.mp4', import.meta.url)
  )
  const input = new Input({ source: new BufferSource(fixture), formats: [MP4] })
  const target = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target,
  })
  const video = await input.getPrimaryVideoTrack()
  const source = new EncodedVideoPacketSource(video.codec)
  output.addVideoTrack(source)
  await output.start()
  const decoderConfig = await video.getDecoderConfig()
  for await (const packet of new EncodedPacketSink(video).packets())
    await source.add(packet, { decoderConfig })
  source.close()
  await output.finalize()
  input.dispose()

  const start = new DataView(target.buffer).getUint32(0)
  const payload = Array.from(new Uint8Array(target.buffer, start))
  const run = setup()
  run(`
    const input = new MediaSource(); const url = URL.createObjectURL(input)
    const track = input.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(Uint8Array.from(${JSON.stringify(
      payload
    )})); __inkloomMseCapture.select(url)
  `)
  const {
    tracks: [track],
  } = run('__inkloomMseCapture.snapshot()')
  const chunks = Array.from(track.parts, (length, index) =>
    Uint8Array.from(run(`__inkloomMseCapture.read(0, ${index}, 0, ${length})`))
  )
  assert.equal(new TextDecoder().decode(chunks[0].subarray(4, 8)), 'ftyp')
  assert.equal(new TextDecoder().decode(chunks[1].subarray(4, 8)), 'moov')
  const clip = await remuxCapturedVideo([{ mime: track.mime, chunks }])
  assert.ok(clip.duration > 14.9 && clip.duration < 15.1)
})

test('a native abort discards split bytes without borrowing the previous initialization', () => {
  const run = setup()
  run(`
    globalThis.source = new MediaSource(); globalThis.url = URL.createObjectURL(source)
    globalThis.track = source.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(box('moov',[7,8,9]).slice(0,-2)); track.abort()
    track.appendBuffer(concat(box('ftyp'),box('moov',[11]),box('moof',[21]),box('mdat',[22])))
    __inkloomMseCapture.select(url); __inkloomMseCapture.snapshot()
  `)
  assert.equal(run('__inkloomMseCapture.read(0, 1, 8, 1)[0]'), 11)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 8, 1)[0]'), 22)
})

test('keeps media with its own movie initialization across repeated init and format changes', () => {
  const run = setup()
  run(`
    globalThis.source = new MediaSource(); globalThis.url = URL.createObjectURL(source)
    globalThis.track = source.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(concat(box('ftyp'),box('moov',[1]),box('moof',[11]),box('mdat',[12])))
    track.appendBuffer(concat(box('ftyp'),box('moov',[2]),box('moof',[21]),box('mdat',[22])))
    track.appendBuffer(box('moov',[2])); __inkloomMseCapture.select(url)
  `)
  run('__inkloomMseCapture.snapshot()')
  assert.equal(run('__inkloomMseCapture.read(0, 1, 8, 1)[0]'), 2)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 8, 1)[0]'), 22)
  run("track.appendBuffer(box('moov',[3]))")
  assert.equal(run('__inkloomMseCapture.read(0, 1, 8, 1)[0]'), 2)
  run('__inkloomMseCapture.release()')
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
  run(`
    track.appendBuffer(concat(box('moov',[3]),box('moof',[31]),box('mdat',[32])))
    __inkloomMseCapture.select(url); track.appendBuffer(box('moov',[4]))
  `)
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /格式发生切换/)
  run('__inkloomMseCapture.release()')
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
})

test('rejects a playback timing change while a media box is incomplete', () => {
  const run = setup()
  run(`
    globalThis.source = new MediaSource(); globalThis.url = URL.createObjectURL(source)
    globalThis.track = source.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(concat(box('ftyp'),box('moov'))); __inkloomMseCapture.select(url)
    const fragment = concat(box('moof'), box('mdat',[21,22]))
    track.appendBuffer(fragment.slice(0,-1))
    track.timestampOffset=5
    track.appendBuffer(fragment.slice(-1))
  `)
  assert.throws(
    () => run('__inkloomMseCapture.snapshot()'),
    /播放时间配置发生变化/
  )
})

test('rejects capture beyond its byte budget without creating a retained copy', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({currentSrc:url}); __inkloomMseCapture.select(url); track.appendBuffer(new Uint8Array(64 * 1024 * 1024 + 1));`
  )
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /内存上限/)
})

test('permits earlier non-default settings when selection and media append use a stable configuration', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.timestampOffset=5; track.appendWindowStart=1; track.appendWindowEnd=30
    track.appendBuffer(concat(box('ftyp'),box('moov')))
    track.timestampOffset=0; track.appendWindowStart=0; track.appendWindowEnd=Infinity
    videos.push({currentSrc:url}); __inkloomMseCapture.select(url)
    track.appendBuffer(concat(box('moof'),box('mdat')))
  `)
  const track = run('__inkloomMseCapture.snapshot().tracks[0]')
  assert.equal(track.timestampOffset, 0)
  assert.equal(track.appendWindowStart, 0)
  assert.equal(track.appendWindowEnd, null)
})

test('captures stable offset and append window before native append can change them', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'),box('moov')))
    track.timestampOffset=3; track.appendWindowStart=2; track.appendWindowEnd=20
    videos.push({currentSrc:url}); __inkloomMseCapture.select(url)
    track.offsetAfterAppend=4; track.appendBuffer(concat(box('moof'),box('mdat')))
  `)
  const track = run('__inkloomMseCapture.snapshot().tracks[0]')
  assert.equal(track.timestampOffset, 3)
  assert.equal(track.appendWindowStart, 2)
  assert.equal(track.appendWindowEnd, 20)
})

test('rejects sequence mode and mid-capture timing changes', () => {
  const before = setup()
  before(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({currentSrc:url}); track.mode='sequence'`
  )
  assert.throws(() => before('__inkloomMseCapture.select(url)'), /播放时间配置/)
  for (const change of [
    'track.timestampOffset=5',
    'track.mode="sequence"',
    'track.appendWindowStart=1',
    'track.appendWindowEnd=30',
  ]) {
    const run = setup()
    run(
      `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({currentSrc:url}); __inkloomMseCapture.select(url); track.appendBuffer(concat(box('moof'),box('mdat'))); ${change}; track.appendBuffer(concat(box('moof'),box('mdat')))`
    )
    assert.throws(
      () => run('__inkloomMseCapture.snapshot()'),
      /播放时间配置发生变化/
    )
  }
})

test('accepts a preselection changeType only after new initialization, and rejects changes during capture', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/webm'); track.changeType('video/mp4'); videos.push({currentSrc:url})`
  )
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
  run(
    `track.appendBuffer(concat(box('ftyp'),box('moov'))); __inkloomMseCapture.select(url); track.changeType('video/mp4')`
  )
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /格式发生切换/)
})

test('discards initialization from before a preselection changeType', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); track.changeType('video/mp4'); videos.push({currentSrc:url})`
  )
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /初始化/)
  run(
    `track.appendBuffer(concat(box('ftyp'),box('moov'))); __inkloomMseCapture.select(url); track.appendBuffer(concat(box('moof'),box('mdat')))`
  )
  assert.equal(run('__inkloomMseCapture.snapshot().tracks.length'), 1)
})

test('installs only on a timely prepared reload and always consumes the marker', () => {
  for (const options of [
    { nav: 'navigate' },
    { age: -1 },
    { age: 130000 },
    { marker: false },
  ]) {
    const run = setup(options)
    assert.equal(run('typeof __inkloomMseCapture'), 'undefined')
    assert.equal(run('sessionStorage.value'), null)
  }
  const run = setup()
  assert.equal(run('typeof __inkloomMseCapture'), 'object')
  assert.equal(run('sessionStorage.value'), null)
})

test('automatic capture starts on navigation without a reload marker and releases reusable state', () => {
  const run = setup({ nav: 'navigate', marker: false, automatic: true })
  assert.equal(run('typeof __inkloomMseCapture'), 'object')
  assert.equal(run('typeof __inkloomMseAutoStart'), 'undefined')
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url))
    track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[1]),box('mdat',[2])))
    __inkloomMseCapture.select(url); __inkloomMseCapture.snapshot()
    __inkloomMseCapture.release()
    track.appendBuffer(concat(box('moof',[3]),box('mdat',[4])))
    __inkloomMseCapture.select(url); __inkloomMseCapture.snapshot()
  `)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 4)
})

test('automatic capture retains a sole source appended before its video is attached', () => {
  const run = setup({ nav: 'navigate', marker: false, automatic: true })
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a)
    globalThis.track = a.addSourceBuffer('video/mp4')
    track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[1]),box('mdat',[2])))
    videos.push(visible(url)); __inkloomMseCapture.select(url); __inkloomMseCapture.snapshot()
  `)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 2)
})

test('automatic pre-attachment bytes are never used for a different source', () => {
  const run = setup({ nav: 'navigate', marker: false, automatic: true })
  run(`
    globalThis.a = new MediaSource(); globalThis.aurl = URL.createObjectURL(a)
    globalThis.at = a.addSourceBuffer('video/mp4')
    at.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[1]),box('mdat',[2])))
    globalThis.b = new MediaSource(); globalThis.burl = URL.createObjectURL(b)
    globalThis.bt = b.addSourceBuffer('video/mp4')
    bt.appendBuffer(concat(box('ftyp'),box('moov'),box('moof',[3]),box('mdat',[4])))
    videos.push(visible(burl)); __inkloomMseCapture.select(burl)
  `)
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
})

test('automatic capture keeps other players initialization for later selection', () => {
  const run = setup({ nav: 'navigate', marker: false, automatic: true })
  run(`
    globalThis.a = new MediaSource(); globalThis.b = new MediaSource()
    globalThis.aurl = URL.createObjectURL(a); globalThis.burl = URL.createObjectURL(b)
    globalThis.at = a.addSourceBuffer('video/mp4'); globalThis.bt = b.addSourceBuffer('video/mp4')
    at.appendBuffer(concat(box('ftyp'),box('moov')))
    bt.appendBuffer(concat(box('ftyp'),box('moov')))
    videos.push(visible(aurl)); __inkloomMseCapture.select(aurl)
    at.appendBuffer(concat(box('moof'),box('mdat')))
    __inkloomMseCapture.snapshot(); __inkloomMseCapture.release()
    videos[0] = visible(burl); __inkloomMseCapture.select(burl)
    bt.appendBuffer(concat(box('moof',[8]),box('mdat',[9])))
    __inkloomMseCapture.snapshot()
  `)
  assert.equal(run('__inkloomMseCapture.read(0, 3, 0, 9).at(-1)'), 9)
})

test('capture exceptions never prevent the original appendBuffer call', () => {
  const run = setup({ nav: 'navigate', marker: false, automatic: true })
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); videos.push(visible(url)); document.querySelectorAll = () => { throw new Error('page document changed') }; track.offsetAfterAppend = 7`
  )
  assert.doesNotThrow(() =>
    run(
      "track.appendBuffer(concat(box('ftyp'),box('moov'),box('moof'),box('mdat')))"
    )
  )
  assert.equal(run('track.timestampOffset'), 7)
})

test('rejects unsupported audio buffers instead of silently dropping audio', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); a.addSourceBuffer('audio/webm'); videos.push({currentSrc:url})`
  )
  assert.throws(
    () => run('__inkloomMseCapture.select(url)'),
    /暂不支持的媒体格式/
  )
})

test('reports more source buffers than the remuxer supports before capture', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); a.addSourceBuffer('video/mp4'); a.addSourceBuffer('audio/mp4'); a.addSourceBuffer('audio/mp4'); videos.push({currentSrc:url})`
  )
  assert.throws(() => run('__inkloomMseCapture.select(url)'), /轨道数量过多/)
})

test('rejects time-setting changes after selection without freezing, and stops late wrappers', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({currentSrc:url}); __inkloomMseCapture.select(url); track.appendBuffer(concat(box('moof'),box('mdat'))); track.timestampOffset=1; track.appendBuffer(box('mdat'))`
  )
  assert.throws(
    () => run('__inkloomMseCapture.snapshot()'),
    /播放时间配置发生变化/
  )
  run(
    `globalThis.inner = SourceBuffer.prototype.appendBuffer; SourceBuffer.prototype.appendBuffer = function(data) { return inner.call(this, data) }; __inkloomMseCapture.stop(); track.appendBuffer(box('mdat'))`
  )
  assert.equal(run('typeof __inkloomMseCapture'), 'undefined')
})

test('does not freeze until a full moof/mdat pair is available', () => {
  const run = setup()
  run(
    `globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a); globalThis.track = a.addSourceBuffer('video/mp4'); track.appendBuffer(concat(box('ftyp'),box('moov'))); videos.push({currentSrc:url}); __inkloomMseCapture.select(url); track.appendBuffer(box('moof'))`
  )
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
  run("track.appendBuffer(box('mdat'))")
  assert.equal(run('__inkloomMseCapture.snapshot().tracks.length'), 1)
})

test('freezes only complete fragment pairs when capture starts or ends between boxes', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a);
    globalThis.track = a.addSourceBuffer('video/mp4');
    track.appendBuffer(concat(box('ftyp'), box('moov')));
    videos.push({currentSrc:url}); __inkloomMseCapture.select(url);
    globalThis.remainder = box('mdat',[26,27]);
    track.appendBuffer(concat(box('mdat',[20]), box('moof',[21]), box('mdat',[22]), box('moof',[23]), box('mdat',[24]), box('moof',[25]), remainder.slice(0,-1)));
  `)
  const snapshot = run('__inkloomMseCapture.snapshot()')
  assert.deepEqual(Array.from(snapshot.tracks[0].parts), Array(6).fill(9))
  assert.equal(snapshot.size, 54)
  assert.equal(run('__inkloomMseCapture.read(0, 2, 0, 9).at(-1)'), 21)
  assert.equal(run('__inkloomMseCapture.read(0, 5, 0, 9).at(-1)'), 24)
  run('track.appendBuffer(remainder.slice(-1))')
  assert.throws(() => run('__inkloomMseCapture.read(0, 6, 0, 9)'), /位置无效/)
})

test('does not join captured media across an unpaired internal fragment header', () => {
  const run = setup()
  run(`
    globalThis.a = new MediaSource(); globalThis.url = URL.createObjectURL(a);
    globalThis.track = a.addSourceBuffer('video/mp4');
    track.appendBuffer(concat(box('ftyp'), box('moov')));
    videos.push({currentSrc:url}); __inkloomMseCapture.select(url);
    track.appendBuffer(concat(box('moof'), box('mdat'), box('moof'), box('moof'), box('mdat')));
  `)
  assert.throws(() => run('__inkloomMseCapture.snapshot()'), /尚未获取/)
})
