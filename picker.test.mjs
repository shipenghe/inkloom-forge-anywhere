import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('./picker.js', import.meta.url), 'utf8')

function fixture() {
  const ctx = vm.createContext({})
  vm.runInContext(
    `
    class Element {
      constructor(tag='div', rect={left:0,top:0,right:100,bottom:100,width:100,height:100}) {
        this.tag = tag; this.rect=rect; this.children=[]; this.parentElement=null;
        this.style={display:'block',visibility:'visible',opacity:'1',cssText:''}; this.isConnected=true;
      }
      append(...nodes) { for (const node of nodes) { node.parentElement=this; this.children.push(node) } }
      remove() { this.isConnected=false }
      matches(selector) {
        if (selector === 'img, video') return this.tag === 'img' || this.tag === 'video'
        if (selector === 'a, button, [role="link"], [role="button"]') return this.tag === 'a' || this.tag === 'button'
        if (selector === 'dialog, [role="dialog"], [aria-modal="true"]') return this.tag === 'dialog'
        return false
      }
      closest(selector) { for(let node=this;node;node=node.parentElement) if(node.matches(selector)) return node; return null }
      contains(element) { if(this===element) return true; return this.children.some(child=>child.contains(element)) }
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
      getBoundingClientRect() { return this.rect }
    }
    class HTMLVideoElement extends Element { constructor() {super('video');this.currentSrc='https://video.example/test.mp4'} }
    globalThis.Element=Element; globalThis.HTMLVideoElement=HTMLVideoElement;
    globalThis.getComputedStyle = element => element.style;
    const root = new Element('html', {left:0,top:0,right:1000,bottom:1000,width:1000,height:1000})
    const body = new Element('body', {left:0,top:0,right:1000,bottom:1000,width:1000,height:1000}); root.append(body)
    globalThis.app = new Element('div', {left:0,top:0,right:1000,bottom:1000,width:1000,height:1000}); body.append(app)
    globalThis.listeners={}; globalThis.hits=[]; globalThis.sent=[]; globalThis.created=[];
    globalThis.document = {
      body, documentElement:root,
      createElement(tag) {const el=new Element(tag); created.push(el); return el},
      addEventListener(type, fn) {listeners[type]=fn},
      removeEventListener(type, fn) {if(listeners[type]===fn) delete listeners[type]},
      elementsFromPoint() {return hits}
    }
    globalThis.chrome = {runtime:{sendMessage:async msg => {sent.push(msg); return {ok:true}}}}
    globalThis.__inkloomMediaFallback = {imageUrl: element=>element.url}
    globalThis.__inkloomVideoCandidates = {videoCandidates:()=>[]}
    globalThis.makeEvent = target => ({target,clientX:50,clientY:50,preventDefault(){},stopImmediatePropagation(){}, composedPath(){const path=[]; for(let node=target;node;node=node.parentElement) path.push(node);return path}})
  `,
    ctx
  )
  vm.runInContext(code, ctx)
  return {
    run: (source) => vm.runInContext(source, ctx),
    click: async (target) => await ctx.listeners.click(ctx.makeEvent(target)),
    move: (target) => ctx.listeners.pointermove(ctx.makeEvent(target)),
    ctx,
  }
}

test('shows a concise hint for selecting media', () => {
  const f = fixture()
  assert.equal(f.ctx.created[1].textContent, '点击图片或视频 · Esc 取消')
})

test('selects the image beneath a link overlay even when the image cannot receive pointer events', async () => {
  const f = fixture()
  f.run(`
    globalThis.card = new Element('div'); globalThis.image = new Element('img'); image.url='https://img.example/selected.webp'; image.style.pointerEvents='none';
    globalThis.overlay = new Element('a'); card.append(image,overlay); app.append(card); hits=[overlay,card,app,document.body]
  `)
  f.move(f.ctx.overlay)
  assert.equal(f.ctx.created[0].style.display, 'block')
  await f.click(f.ctx.overlay)
  assert.equal(f.ctx.sent.length, 1)
  assert.equal(f.ctx.sent[0].mediaKind, 'image')
  assert.equal(f.ctx.sent[0].url, 'https://img.example/selected.webp')
  assert.equal(f.ctx.listeners.click, undefined)
})

test('refuses overlapping media instead of picking one', async () => {
  const f = fixture()
  f.run(`
    globalThis.card = new Element('div'); globalThis.a = new Element('img'); a.url='https://img.example/a.png';
    globalThis.b = new HTMLVideoElement(); globalThis.overlay = new Element('a');
    card.append(a,b,overlay); app.append(card); hits=[overlay,card,app,document.body]
  `)
  await f.click(f.ctx.overlay)
  assert.equal(f.ctx.sent.length, 0)
  assert.match(f.ctx.created[1].textContent, /多个图片或视频/)
})

test('ignores hidden descendants and does not mistake an unrelated modal for a media card', async () => {
  const f = fixture()
  f.run(`
    globalThis.card = new Element('div'); globalThis.hidden = new Element('img'); hidden.url='https://img.example/hidden.png'; hidden.style.opacity='0';
    globalThis.image = new Element('img'); image.url='https://img.example/visible.png'; globalThis.overlay = new Element('a');
    card.append(hidden,image,overlay); app.append(card); hits=[overlay,card,app,document.body]
  `)
  await f.click(f.ctx.overlay)
  assert.equal(f.ctx.sent[0].url, 'https://img.example/visible.png')

  const g = fixture()
  g.run(`
    app.rect={left:0,top:0,right:200,bottom:200,width:200,height:200}
    globalThis.card = new Element('div'); globalThis.image = new Element('img'); image.url='https://img.example/background.png'; card.append(image)
    globalThis.modal = new Element('div'); globalThis.overlay = new Element('a'); modal.append(overlay)
    app.append(card,modal); hits=[overlay,modal,image,card,app,document.body]
  `)
  await g.click(g.ctx.overlay)
  assert.equal(g.ctx.sent.length, 0)

  const h = fixture()
  h.run(`
    globalThis.card = new Element('div'); globalThis.image = new Element('img'); image.url='https://img.example/covered.png'
    globalThis.overlay = new Element('a'); overlay.style.backgroundColor='rgb(255, 255, 255)';
    card.append(image,overlay); app.append(card); hits=[overlay,card,app,document.body]
  `)
  await h.click(h.ctx.overlay)
  assert.equal(h.ctx.sent.length, 0)
})

test('direct video hit retains video selection and Escape cancels', async () => {
  const f = fixture()
  f.run(
    `globalThis.video=new HTMLVideoElement(); document.body.append(video); hits=[video,document.body]`
  )
  await f.click(f.ctx.video)
  assert.equal(f.ctx.sent[0].mediaKind, 'video')
  assert.equal(f.ctx.sent[0].url, 'https://video.example/test.mp4')

  const g = fixture()
  await g.ctx.listeners.keydown({ key: 'Escape' })
  assert.equal(g.ctx.sent[0].kind, 'PICKER_CANCEL')
  assert.equal(g.ctx.listeners.click, undefined)
})
