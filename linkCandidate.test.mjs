import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(
  new URL('./linkCandidate.js', import.meta.url),
  'utf8'
)
const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})
function fixture({
  media = [],
  links = 1,
  box = rect(10, 20, 200, 150),
  linkStyle,
  blocker,
  nested = false,
  dialog = false,
} = {}) {
  const linkUrl = 'https://example.test/note/1'
  const parent = { querySelectorAll: () => media }
  const link = {
    href: linkUrl,
    parentElement: parent,
    getBoundingClientRect: () => box,
    contains: (node) => nested && media.includes(node),
    closest: () => (dialog ? {} : null),
    style: linkStyle,
  }
  const doc = {
    querySelectorAll: () => Array.from({ length: links }, () => link),
    elementsFromPoint: () => [
      link,
      ...(blocker ? [blocker] : []),
      ...media.filter((item) => item.style?.display !== 'none'),
    ],
  }
  const context = vm.createContext({
    document: doc,
    getComputedStyle: (item, pseudo) =>
      pseudo
        ? {
            content: 'none',
            backgroundImage: 'none',
            backgroundColor: 'rgba(0, 0, 0, 0)',
          }
        : {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            backgroundImage: 'none',
            backgroundColor: 'rgba(0, 0, 0, 0)',
            ...(item.style || {}),
          },
  })
  vm.runInContext(source, context)
  return () => context.__inkloomLinkedMedia.linkedMedia(linkUrl)
}
function image(box = rect(10, 20, 200, 150)) {
  return {
    tagName: 'IMG',
    currentSrc: 'https://cdn.test/image.jpg',
    getBoundingClientRect: () => box,
  }
}
test('finds a single image geometrically covered by the unique link', () => {
  const result = fixture({ media: [image()] })()
  assert.equal(result.mediaKind, 'image')
  assert.equal(result.url, 'https://cdn.test/image.jpg')
})
test('never guesses between multiple plausible covers or overlapping media', () => {
  assert.equal(fixture({ links: 2, media: [image()] })(), null)
  assert.equal(fixture({ media: [image(), image()] })(), null)
})

test('finds the sole image cover when the same post also has a separate text link', () => {
  const src = image()
  const href = 'https://example.test/note/1'
  const card = { querySelectorAll: () => [src] }
  const cover = {
    href,
    parentElement: card,
    getBoundingClientRect: () => rect(10, 20, 200, 150),
    contains: (node) => node === src,
  }
  const title = {
    href,
    parentElement: card,
    getBoundingClientRect: () => rect(10, 180, 200, 30),
    contains: () => false,
    textContent: '一条笔记',
  }
  let links = [cover, title]
  const context = vm.createContext({
    document: { querySelectorAll: () => links, elementsFromPoint: () => [] },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }),
  })
  vm.runInContext(source, context)
  assert.equal(
    context.__inkloomLinkedMedia.linkedMedia(href).url,
    src.currentSrc
  )
  links = [cover, title, { ...cover }]
  assert.equal(context.__inkloomLinkedMedia.linkedMedia(href), null)
})
test('rejects an unrelated nearby image or tiny icon', () => {
  assert.equal(fixture({ media: [image(rect(210, 20, 200, 150))] })(), null)
  assert.equal(fixture({ media: [image(rect(10, 20, 20, 20))] })(), null)
  assert.equal(fixture({ media: [image()], box: rect(0, 0, 0, 0) })(), null)
})
test('ignores hidden siblings and supports a uniquely covered video', () => {
  const hidden = image()
  hidden.style = { display: 'none', visibility: 'visible', opacity: '1' }
  const video = {
    tagName: 'VIDEO',
    currentSrc: 'blob:https://example.test/id',
    getBoundingClientRect: () => rect(10, 20, 200, 150),
  }
  const result = fixture({ media: [hidden, video] })()
  assert.equal(result.mediaKind, 'video')
  assert.equal(result.url, video.currentSrc)
})

test('does not consider media inside a transparent ancestor visible', () => {
  const hidden = image()
  hidden.parentElement = {
    style: { display: 'block', visibility: 'visible', opacity: '0' },
  }
  assert.equal(fixture({ media: [hidden] })(), null)
})

test('never infer a sibling image below an opaque link or intervening layer', () => {
  assert.equal(
    fixture({
      media: [image()],
      linkStyle: { backgroundColor: 'rgb(255, 255, 255)' },
    })(),
    null
  )
  assert.equal(
    fixture({
      media: [image()],
      blocker: { style: { backgroundColor: 'rgb(255, 255, 255)' } },
    })(),
    null
  )
  assert.equal(fixture({ media: [image()], dialog: true })(), null)
})

test('nested media can still be selected when its link has an opaque background', () => {
  const result = fixture({
    media: [image()],
    nested: true,
    linkStyle: { backgroundColor: 'rgb(255, 255, 255)' },
  })()
  assert.equal(result.url, 'https://cdn.test/image.jpg')
})
