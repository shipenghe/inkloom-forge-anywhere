import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const fallback = readFileSync(
  new URL('./mediaFallback.js', import.meta.url),
  'utf8'
)
const code = readFileSync(new URL('./hoverVideo.js', import.meta.url), 'utf8')

async function fixture({ enabled = true, hasTarget = true } = {}) {
  const ctx = vm.createContext({ setTimeout, clearTimeout })
  vm.runInContext(
    `
    class Element {
      constructor(tag='div', rect={left:100,top:100,right:500,bottom:350,width:400,height:250}) {
        this.tag=tag; this.tagName=tag.toUpperCase(); this.rect=rect; this.children=[]; this.parentElement=null;
        this.style={display:'block',visibility:'visible',opacity:'1'}; this.isConnected=true;
        this.listeners={}; this.hidden=false; this.attrs={}
      }
      append(...nodes) {for(const node of nodes){node.parentElement=this;this.children.push(node)}}
      attachShadow(){return this.shadow=new Element('shadow')}
      remove(){this.isConnected=false}
      setAttribute(k,v){this.attrs[k]=v}
      addEventListener(type, fn){this.listeners[type]=fn}
      matches(selector){
        if (selector==='img, video, audio') return ['img','video','audio'].includes(this.tag)
        if (selector==='dialog, [role="dialog"], [aria-modal="true"]') return this.tag==='dialog'
        return false
      }
      closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null}
      contains(item){return this===item||this.children.some(child=>child.contains(item))}
      querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)])}
      getBoundingClientRect(){return this.rect}
    }
    class HTMLVideoElement extends Element { constructor(url='blob:https://video.example/one'){super('video');this.currentSrc=url;this.src=url} }
    class HTMLImageElement extends Element { constructor(url='https://image.example/one.png'){super('img');this.currentSrc=url;this.src=url} }
    globalThis.Element=Element;globalThis.HTMLVideoElement=HTMLVideoElement;globalThis.HTMLImageElement=HTMLImageElement;
    globalThis.innerWidth=1200;globalThis.innerHeight=900;globalThis.getComputedStyle=el=>el.style;
    const html=new Element('html',{left:0,top:0,right:1200,bottom:900,width:1200,height:900});
    const body=new Element('body',{left:0,top:0,right:1200,bottom:900,width:1200,height:900});html.append(body);
    globalThis.created=[];globalThis.listeners={};globalThis.windowListeners={};globalThis.sent=[];
    globalThis.settings={enabled:${enabled},hasTarget:${hasTarget},canShow:true};
    globalThis.document={documentElement:html,body,
      createElement(tag){let element=new Element(tag);created.push(element);return element},
      addEventListener(type,fn){listeners[type]=fn}, removeEventListener(type,fn){if(listeners[type]===fn)delete listeners[type]}
    };
    globalThis.window=globalThis;
    globalThis.addEventListener=(type,fn)=>{windowListeners[type]=fn};
    globalThis.removeEventListener=(type,fn)=>{if(windowListeners[type]===fn)delete windowListeners[type]};
    globalThis.chrome={runtime:{id:'test-id',onMessage:{addListener(fn){globalThis.messageListener=fn},removeListener(fn){if(globalThis.messageListener===fn)delete globalThis.messageListener}},
      async sendMessage(msg){sent.push(msg);return msg.kind==='HOVER_MEDIA_STATE'?{ok:true,...settings}:{ok:true,message:'视频已交给画布'}}},
      storage:{onChanged:{addListener(fn){globalThis.storageListener=fn},removeListener(fn){if(globalThis.storageListener===fn)delete globalThis.storageListener}}}};
    globalThis.__inkloomVideoCandidates={videoCandidates:()=>['https://cdn.example/video.mp4']};
    globalThis.eventFor=(target,x=150,y=150)=>({isTrusted:true,target,clientX:x,clientY:y,pointerType:'mouse',
      composedPath(){let p=[];for(let node=target;node;node=node.parentElement)p.push(node);return p}});
    globalThis.clickFor=(trusted=true)=>({isTrusted:trusted,preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true}});
  `,
    ctx
  )
  ctx.location = { hostname: 'fixture.test' }
  vm.runInContext(fallback, ctx)
  vm.runInContext(code, ctx)
  await new Promise((resolve) => setImmediate(resolve))
  return { ctx, run: (source) => vm.runInContext(source, ctx) }
}

test('anchors audio to the QQ Music bar and refuses a changed track', async () => {
  const f = await fixture()
  f.run(`
    globalThis.bar=new Element('div'); document.body.append(bar)
    globalThis.track=new Element('audio'); track.currentSrc='https://cdn.example/one.mp3'
    document.body.append(track)
    globalThis.__inkloomMediaFallback={audioPlayer: el=>el===bar ? {element:track,anchor:bar,control:bar} : null}
  `)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.bar))
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[2].attrs['aria-label'], '发送音频到画布')
  f.ctx.track.currentSrc = 'https://cdn.example/two.mp3'
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(
    f.ctx.sent.some((m) => m.kind === 'HOVER_MEDIA_SEND'),
    false
  )
  f.ctx.__forgeHoverVideoCleanup()
})

test('button capture receives the first click before document menus and sends once', async () => {
  const f = await fixture()
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  const host = f.ctx.created[0],
    button = f.ctx.created[2]
  button.rect = {
    left: 456,
    top: 108,
    right: 492,
    bottom: 144,
    width: 36,
    height: 36,
  }
  const event = (type) => ({
    ...f.ctx.clickFor(true),
    type,
    button: 0,
    detail: 1,
    clientX: 474,
    clientY: 126,
    composedPath: () => [host, f.ctx.document.documentElement],
    stopImmediatePropagation() {
      this.intercepted = true
    },
  })
  const down = event('pointerdown')
  f.ctx.windowListeners.pointerdown(down)
  assert.equal(down.intercepted, true)
  assert.equal(
    f.ctx.sent.filter((m) => m.kind === 'HOVER_MEDIA_SEND').length,
    0,
    'press alone cannot send'
  )
  let finish
  f.ctx.chrome.runtime.sendMessage = (msg) => {
    f.ctx.sent.push(msg)
    return new Promise((r) => {
      finish = r
    })
  }
  const click = event('click')
  const pending = f.ctx.windowListeners.click(click)
  assert.equal(click.intercepted, true)
  assert.equal(f.ctx.created[4].textContent, '正在准备…')
  await button.listeners.click(f.ctx.clickFor(true))
  assert.equal(
    f.ctx.sent.filter((m) => m.kind === 'HOVER_MEDIA_SEND').length,
    1
  )
  finish({ ok: true, message: '视频已交给画布' })
  await pending
  assert.equal(f.ctx.created[4].textContent, '视频已交给画布')
  for (const alter of [
    { clientX: 800 },
    { clientY: 180 },
    { button: 2 },
    { isTrusted: false },
    { composedPath: () => [f.ctx.document.body] },
  ]) {
    const ignored = { ...event('click'), ...alter }
    f.ctx.windowListeners.click(ignored)
    assert.equal(
      ignored.intercepted,
      undefined,
      'other page/notice/synthetic clicks pass through'
    )
  }
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
  assert.equal(f.ctx.windowListeners.click, undefined)
})

test('reveals on video right-click and sends that exact video only after button click', async () => {
  const f = await fixture()
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  assert.equal(f.ctx.created[0].style.display, 'block')
  const button = f.ctx.created[2]
  const icon = f.ctx.created[3]
  assert.deepEqual(
    Buffer.from(icon.src.split(',')[1], 'base64'),
    readFileSync(new URL('./icons/icon32.png', import.meta.url))
  )
  await button.listeners.click(f.ctx.clickFor(true))
  const sent = f.ctx.sent.find((message) => message.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent.url, 'blob:https://video.example/one')
  assert.deepEqual(Array.from(sent.videoCandidates), [
    'https://cdn.example/video.mp4',
  ])
  assert.equal(f.ctx.created[4].textContent, '视频已交给画布')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('uses a text fallback if the page blocks the embedded favicon', async () => {
  const f = await fixture()
  const button = f.ctx.created[2]
  f.ctx.created[3].listeners.error()
  assert.equal(button.textContent, 'FA')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('recognizes an overlay in the same player but refuses ambiguous videos', async () => {
  const f = await fixture()
  f.run(
    `globalThis.card=new Element('div');globalThis.one=new HTMLVideoElement();globalThis.overlay=new Element('div');card.append(one,overlay);document.body.append(card)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'block')
  f.run(
    `globalThis.two=new HTMLVideoElement('blob:https://video.example/two');card.append(two)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('does not select a video underneath an unrelated opaque overlay', async () => {
  const f = await fixture()
  f.run(
    `globalThis.card=new Element('div');globalThis.video=new HTMLVideoElement();globalThis.overlay=new Element('div');overlay.style.backgroundColor='rgb(255, 255, 255)';card.append(video,overlay);document.body.append(card)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('recognizes the Pexels photo beneath its gradient overlay and keeps the site menu', async () => {
  const f = await fixture()
  f.run(`
    globalThis.card=new Element('a');globalThis.image=new HTMLImageElement();globalThis.overlay=new Element();
    overlay.style.backgroundImage='linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0) 20%, rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.3))';
    overlay.style.backgroundColor='rgba(0, 0, 0, 0)';
    card.append(image,overlay);document.body.append(card)
  `)
  const event = f.ctx.eventFor(f.ctx.overlay)
  event.preventDefault = () => assert.fail('must keep the Pexels menu')
  event.stopPropagation = () =>
    assert.fail('must allow the site context handler')
  await f.ctx.listeners.contextmenu(event)
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[2].attrs['aria-label'], '发送图片到画布')
  assert.equal(
    f.ctx.sent.filter((m) => m.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  const sent = f.ctx.sent.find((m) => m.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent.url, f.ctx.image.currentSrc)
  assert.equal(f.ctx.__inkloomSelectedImage, f.ctx.image)
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('Pexels preview above its poster shows a video entry and sends the video, not the cover', async () => {
  const f = await fixture()
  f.run(`
    globalThis.card=new Element('a');globalThis.image=new HTMLImageElement();globalThis.video=new HTMLVideoElement('https://videos.pexels.com/preview.mp4');globalThis.overlay=new Element();
    video.readyState=4;video.videoWidth=360;video.videoHeight=640;
    overlay.style.backgroundImage='linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0) 20%, rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.3))';
    card.append(image,video,overlay);document.body.append(card);
    document.elementsFromPoint=()=>[overlay,video,image,card]
  `)
  const event = f.ctx.eventFor(f.ctx.overlay)
  event.preventDefault = () => assert.fail('must keep the site context menu')
  event.stopPropagation = () =>
    assert.fail('must allow the site context handler')
  await f.ctx.listeners.contextmenu(event)
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[2].attrs['aria-label'], '发送视频到画布')
  assert.equal(
    f.ctx.sent.filter((m) => m.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  const sent = f.ctx.sent.find((m) => m.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent.mediaKind, 'video')
  assert.equal(sent.url, 'https://videos.pexels.com/preview.mp4')
  assert.equal(sent.displayUrl, undefined)
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('poster pairing never selects an unloaded, covered, translucent or unrelated video', async () => {
  const f = await fixture()
  f.run(`
    globalThis.card=new Element('a');globalThis.image=new HTMLImageElement();globalThis.video=new HTMLVideoElement();globalThis.overlay=new Element();
    card.append(image,video,overlay);document.body.append(card);
    globalThis.stack=[overlay,video,image,card];document.elementsFromPoint=()=>stack;
    video.videoWidth=640;video.videoHeight=360;video.readyState=0
  `)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run('video.readyState=4;stack=[overlay,image,video,card]')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run('stack=[overlay,video,image,card];video.style.opacity="0.5"')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run(
    'video.style.opacity="1";video.rect={...video.rect,right:450,width:350}'
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run(
    'video.rect={...image.rect};globalThis.second=new HTMLVideoElement();card.append(second)'
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run('second.style.display="none";video.style.opacity="0"')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(
    f.ctx.created[2].attrs['aria-label'],
    '发送图片到画布',
    'an inactive video leaves the visible poster as an image'
  )
  f.run(
    'video.style.opacity="1";video.currentSrc="";video.src="";video.readyState=0'
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(
    f.ctx.created[2].attrs['aria-label'],
    '发送图片到画布',
    'an empty video placeholder does not hide the image entry'
  )
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('gradients never bypass opaque backgrounds, image layers, or ambiguous media', async () => {
  const f = await fixture()
  f.run(`
    globalThis.card=new Element('a');globalThis.image=new HTMLImageElement();globalThis.overlay=new Element();
    card.append(image,overlay);document.body.append(card)
  `)
  for (const [backgroundImage, backgroundColor] of [
    ['linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0))', 'transparent'],
    ['linear-gradient(rgba(0, 0, 0, 0.98), rgba(0, 0, 0, 0))', 'transparent'],
    ['url("https://image.example/cover.png")', 'transparent'],
    [
      'linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.3)), url("https://image.example/cover.png")',
      'transparent',
    ],
    [
      'linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.3))',
      'rgb(255, 255, 255)',
    ],
    [
      'linear-gradient(rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0.9))',
      'rgba(0, 0, 0, 0.9)',
    ],
    [
      'linear-gradient(rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0.9)), linear-gradient(rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0.9))',
      'transparent',
    ],
  ]) {
    Object.assign(f.ctx.overlay.style, { backgroundImage, backgroundColor })
    await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
    assert.equal(f.ctx.created[0].style.display, 'none', backgroundImage)
  }
  f.run(`
    overlay.style.backgroundImage='linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.3))';
    globalThis.video=new HTMLVideoElement();card.append(video)
  `)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('without a target the right-click entry opens Forge without sending media', async () => {
  const f = await fixture({ hasTarget: false })
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[2].title, '打开 Forge')
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(f.ctx.sent.filter((m) => m.kind === 'OPEN_FORGE').length, 1)
  assert.equal(
    f.ctx.sent.filter((m) => m.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.storageListener({ autoCaptureEnabled: { newValue: false } }, 'local')
  assert.equal(
    f.ctx.created[0].isConnected,
    true,
    'video preparation does not control media entry'
  )
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
  assert.equal(f.ctx.created[0].isConnected, false)
  assert.equal(f.ctx.listeners.contextmenu, undefined)
  const g = await fixture({ enabled: false })
  assert.equal(g.ctx.created[0].isConnected, false)
  assert.equal(g.ctx.listeners.contextmenu, undefined)
})

test('ignores synthetic clicks and a source changed after right-click', async () => {
  const f = await fixture()
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  const button = f.ctx.created[2]
  await button.listeners.click(f.ctx.clickFor(false))
  f.ctx.video.currentSrc = 'blob:https://video.example/changed'
  await button.listeners.click(f.ctx.clickFor(true))
  assert.equal(
    f.ctx.sent.filter((message) => message.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('reveals an image entry only on trusted right-click and preserves the page menu', async () => {
  const f = await fixture()
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  assert.equal(f.ctx.listeners.pointermove, undefined)
  assert.equal(f.ctx.created[0].style.display, 'none')
  const synthetic = f.ctx.eventFor(f.ctx.image)
  synthetic.isTrusted = false
  await f.ctx.listeners.contextmenu(synthetic)
  assert.equal(f.ctx.created[0].style.display, 'none')
  const context = f.ctx.eventFor(f.ctx.image)
  context.preventDefault = () =>
    assert.fail('must keep the original context menu')
  context.stopPropagation = () =>
    assert.fail('must allow the site context handler')
  await f.ctx.listeners.contextmenu(context)
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[2].attrs['aria-label'], '发送图片到画布')
  assert.equal(
    f.ctx.sent.filter((message) => message.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  const sent = f.ctx.sent.find((message) => message.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent.mediaKind, 'image')
  assert.equal(sent.url, 'https://image.example/one.png')
  assert.equal(sent.displayUrl, sent.url)
  assert.equal(sent.videoCandidates, undefined)
  assert.equal(f.ctx.__inkloomSelectedImage, f.ctx.image)
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('resolves an image under a lightbox overlay but never media behind an unrelated dialog', async () => {
  const f = await fixture()
  f.run(
    `globalThis.dialog=new Element('dialog');globalThis.image=new HTMLImageElement();globalThis.overlay=new Element();dialog.append(image,overlay);document.body.append(dialog)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'block')
  f.run(
    `globalThis.unrelated=new Element('dialog');globalThis.unrelatedOverlay=new Element();unrelated.append(unrelatedOverlay);document.body.append(unrelated)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.unrelatedOverlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('rejects ambiguous image/video overlays and small avatar images', async () => {
  const f = await fixture()
  f.run(
    `globalThis.card=new Element();globalThis.image=new HTMLImageElement();globalThis.video=new HTMLVideoElement();globalThis.overlay=new Element();card.append(image,video,overlay);document.body.append(card)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.overlay))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.run(
    `globalThis.avatar=new HTMLImageElement();avatar.rect={left:100,top:100,right:140,bottom:140,width:40,height:40};document.body.append(avatar)`
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.avatar, 120, 120))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('a changed source explains why it cannot send; outside interaction and Escape dismiss feedback', async () => {
  const f = await fixture()
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.image.currentSrc = 'https://image.example/changed.png'
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[4].textContent, '素材已变化，请重新右键')
  assert.equal(
    f.ctx.sent.filter((message) => message.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.listeners.pointerdown(f.ctx.eventFor(f.ctx.document.body, 900, 700))
  assert.equal(f.ctx.created[0].style.display, 'none')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.listeners.keydown({ key: 'Escape' })
  assert.equal(f.ctx.created[0].style.display, 'none')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.listeners.click(f.ctx.eventFor(f.ctx.document.body, 900, 700))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('removing the selected source hides its entry without another user event', async () => {
  const f = await fixture()
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.image.isConnected = false
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('right-click refreshes a newly set target instead of retaining the initial missing target', async () => {
  const f = await fixture({ hasTarget: false })
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  f.ctx.settings.hasTarget = true
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  assert.equal(f.ctx.created[0].style.display, 'block')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('carousel source replacement during target lookup never reveals a different image', async () => {
  const f = await fixture()
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  let finish
  f.ctx.chrome.runtime.sendMessage = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  f.ctx.image.currentSrc = 'https://image.example/next.png'
  finish({ ok: true, enabled: true, hasTarget: true })
  await pending
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('an ignored entry expires while an active send keeps its feedback until dismissal', async () => {
  const f = await fixture()
  const timers = new Map()
  let nextId = 0
  f.ctx.setTimeout = (fn, delay) => {
    const id = ++nextId
    timers.set(id, { fn, delay })
    return id
  }
  f.ctx.clearTimeout = (id) => timers.delete(id)
  f.run(`globalThis.image=new HTMLImageElement();document.body.append(image)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  const idle = [...timers.values()].find((timer) => timer.delay === 8000)
  assert.ok(idle)
  idle.fn()
  assert.equal(f.ctx.created[0].style.display, 'none')
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  let finish
  f.ctx.chrome.runtime.sendMessage = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(
    [...timers.values()].some((timer) => timer.delay === 8000),
    false
  )
  finish({ ok: true, message: '已交给画布' })
  await pending
  assert.equal(f.ctx.created[0].style.display, 'block')
  const outcome = [...timers.values()].find((timer) => timer.delay === 6000)
  assert.ok(outcome)
  outcome.fn()
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('long inline images use a bounded local blob URL that survives until handoff completes', async () => {
  const f = await fixture()
  f.run(
    `globalThis.image=new HTMLImageElement('data:image/png;base64,'+'A'.repeat(6000));document.body.append(image)`
  )
  const fetched = []
  const revoked = []
  f.ctx.fetch = async (url) => {
    fetched.push(url)
    return { blob: async () => ({ size: 4500, type: 'image/png' }) }
  }
  f.ctx.URL = {
    createObjectURL: (blob) => {
      assert.equal(blob.size, 4500)
      return 'blob:https://image.example/inline'
    },
    revokeObjectURL: (url) => revoked.push(url),
  }
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  let finish
  f.ctx.chrome.runtime.sendMessage = async (message) => {
    f.ctx.sent.push(message)
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const pending = f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetched.length, 1)
  assert.ok(fetched[0].startsWith('data:'))
  const sent = f.ctx.sent.find((message) => message.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent.url, 'blob:https://image.example/inline')
  assert.equal(sent.displayUrl, sent.url)
  assert.equal(sent.mediaKind, 'image')
  assert.equal(f.ctx.__inkloomSelectedImage, f.ctx.image)
  assert.equal(
    revoked.length,
    0,
    'the source blob remains readable during transfer'
  )
  finish({ ok: true, message: '已交给画布' })
  await pending
  assert.deepEqual(revoked, ['blob:https://image.example/inline'])
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('inline resources reject oversized blobs and revoke temporary URLs on send failure', async () => {
  const f = await fixture()
  f.run(
    `globalThis.image=new HTMLImageElement('data:image/png;base64,'+'A'.repeat(6000));document.body.append(image)`
  )
  let size = 201 * 1024 * 1024
  const revoked = []
  let created = 0
  f.ctx.fetch = async () => ({ blob: async () => ({ size }) })
  f.ctx.URL = {
    createObjectURL: () => {
      created++
      return 'blob:https://image.example/inline'
    },
    revokeObjectURL: (url) => revoked.push(url),
  }
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.image))
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(created, 0)
  assert.equal(
    f.ctx.sent.filter((message) => message.kind === 'HOVER_MEDIA_SEND').length,
    0
  )
  size = 100
  f.ctx.chrome.runtime.sendMessage = async () => {
    throw new Error('port closed')
  }
  await f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  assert.equal(created, 1)
  assert.deepEqual(revoked, ['blob:https://image.example/inline'])
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('hides when scrolling the selected media away from its original right-click position', async () => {
  const f = await fixture()
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  f.ctx.video.rect = {
    left: 600,
    top: 600,
    right: 1000,
    bottom: 850,
    width: 400,
    height: 250,
  }
  f.ctx.windowListeners.scroll()
  assert.equal(f.ctx.created[0].style.display, 'none')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('outside pointerdown during a send hides the button without cancelling the send', async () => {
  const f = await fixture()
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  let finish
  f.ctx.chrome.runtime.sendMessage = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = f.ctx.created[2].listeners.click(f.ctx.clickFor(true))
  f.ctx.listeners.pointerdown(f.ctx.eventFor(f.ctx.document.body, 900, 700))
  assert.equal(f.ctx.created[0].style.display, 'none')
  finish({ ok: true, message: '视频已交给画布' })
  await pending
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[4].textContent, '视频已交给画布')
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('pending video feedback survives source replacement and reports a delayed failure', async () => {
  const f = await fixture()
  const timers = new Map()
  let id = 0
  f.ctx.setTimeout = (fn, delay) => {
    timers.set(++id, { fn, delay })
    return id
  }
  f.ctx.clearTimeout = (key) => timers.delete(key)
  f.run(`globalThis.video=new HTMLVideoElement();document.body.append(video)`)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.video))
  let finish
  let sends = 0
  f.ctx.chrome.runtime.sendMessage = () => {
    sends++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const button = f.ctx.created[2]
  const pending = button.listeners.click(f.ctx.clickFor(true))
  assert.equal(f.ctx.created[4].hidden, false)
  assert.equal(f.ctx.created[4].textContent, '正在准备…')
  assert.equal(button.attrs['aria-busy'], 'true')
  f.ctx.video.currentSrc = 'blob:https://video.example/replaced'
  f.ctx.video.isConnected = false
  f.ctx.windowListeners.scroll()
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(
    [...timers.values()].some((t) => t.delay === 250),
    false
  )
  await button.listeners.click(f.ctx.clickFor(true))
  assert.equal(sends, 1, 'waiting cannot trigger duplicate sends')
  const delayed = [...timers.values()].find((t) => t.delay === 10000)
  assert.ok(delayed)
  delayed.fn()
  assert.equal(f.ctx.created[4].textContent, '仍在处理中，请稍候')
  finish({ ok: false, error: '未捕获视频片段，请刷新网页后重试' })
  await pending
  assert.equal(f.ctx.created[0].style.display, 'block')
  assert.equal(f.ctx.created[4].textContent, '未捕获视频片段，请刷新网页后重试')
  assert.equal(button.attrs['aria-busy'], 'false')
  assert.equal(button.disabled, true)
  assert.equal(
    [...timers.values()].some((t) => t.delay === 10000),
    false
  )
  f.ctx.messageListener(
    { kind: 'HOVER_MEDIA_STOP' },
    { id: 'test-id' },
    () => {}
  )
})

test('right-click finds nested video after skipping unrelated player control trees', async () => {
  const f = await fixture()
  f.run(`
    globalThis.player=new Element('demo-player'); document.body.append(player)
    const inner=new Element('demo-video'); player.shadowRoot=player.attachShadow();
    const control=new Element('demo-control',{left:100,top:100,right:140,bottom:140,width:40,height:40});
    control.shadowRoot=control.attachShadow();
    control.shadowRoot.querySelectorAll=()=>Array.from({length:510},()=>new Element('div'));
    player.shadowRoot.append(control,inner);
    inner.shadowRoot=inner.attachShadow(); inner.shadowRoot.append(Object.assign(new HTMLVideoElement('https://cdn.example/shadow.mp4'), {
      readyState:4,videoWidth:1920,videoHeight:1080
    }))
    player.shadowRoot.querySelectorAll=()=>player.shadowRoot.children
    inner.shadowRoot.querySelectorAll=()=>inner.shadowRoot.children
  `)
  await f.ctx.listeners.contextmenu(f.ctx.eventFor(f.ctx.player))
  assert.equal(f.ctx.created[0].style.display, 'block')
  await f.ctx.created[2].listeners.click(f.ctx.clickFor())
  const sent = f.ctx.sent.find((message) => message.kind === 'HOVER_MEDIA_SEND')
  assert.equal(sent?.mediaKind, 'video')
  assert.equal(sent?.url, 'https://cdn.example/shadow.mp4')
  f.ctx.__forgeHoverVideoCleanup()
})
