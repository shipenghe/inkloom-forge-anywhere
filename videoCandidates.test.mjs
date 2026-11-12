import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('./videoCandidates.js', import.meta.url),
  'utf8'
)
function candidates({
  currentSrc = 'blob:https://example.com/video',
  src = null,
  sources = [],
} = {}) {
  const context = {
    URL,
    window: { matchMedia: (query) => ({ matches: query !== 'not-matching' }) },
  }
  vm.runInNewContext(source, context)
  const node = (attrs) => ({ getAttribute: (name) => attrs[name] || null })
  const video = {
    currentSrc,
    src: src || '',
    getAttribute: (name) => (name === 'src' ? src : null),
    ownerDocument: { baseURI: 'https://example.com/page' },
    querySelectorAll: () => sources.map(node),
  }
  return Array.from(context.__inkloomVideoCandidates.videoCandidates(video))
}

test('only collects direct sources attached to the selected video', () => {
  assert.deepEqual(
    candidates({
      sources: [
        { src: '/one.mp4', type: 'video/mp4' },
        { src: '/one.mp4', type: 'video/mp4' },
        { src: '/two.webm' },
        { src: '/not-selected.mp4', media: 'not-matching' },
        { src: '/segment.m4s', type: 'video/mp4' },
        { src: '/playlist.m3u8', type: 'application/x-mpegURL' },
        { src: 'blob:https://example.com/another' },
        { src: '/unknown' },
      ],
    }),
    ['https://example.com/one.mp4', 'https://example.com/two.webm']
  )
})

test('does not repeat the current source or guess untyped URLs', () => {
  assert.deepEqual(
    candidates({
      currentSrc: 'https://example.com/video.mp4',
      src: '/video.mp4',
      sources: [{ src: '/unknown' }],
    }),
    []
  )
})
