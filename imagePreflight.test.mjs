import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('./imagePreflight.js', import.meta.url),
  'utf8'
)
const context = vm.createContext({ Uint8Array, DataView })
vm.runInContext(source, context)
const validate = (bytes, mime = '') =>
  context.__inkloomImagePreflight.validate(new Blob([bytes], { type: mime }))

function webp(chunk, data) {
  const header = Buffer.alloc(20)
  header.write('RIFF', 0)
  header.writeUInt32LE(12 + data.length, 4)
  header.write('WEBP', 8)
  header.write(chunk, 12)
  header.writeUInt32LE(data.length, 16)
  return Buffer.concat([header, data])
}

test('accepts JPEG, PNG and static WebP based on bytes, not MIME', async () => {
  await validate(Buffer.from([0xff, 0xd8, 0xff, 0]), 'image/avif')
  await validate(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/avif')
  await validate(webp('VP8 ', Buffer.from([1, 2])), 'image/avif')
})

test('rejects AVIF and GIF even when the MIME header claims JPEG', async () => {
  const avif = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypavif'),
    Buffer.alloc(12),
  ])
  await assert.rejects(validate(avif, 'image/jpeg'), { message: '不支持 AVIF' })
  await assert.rejects(validate(Buffer.from('GIF89a'), 'image/jpeg'), {
    message: '不支持 GIF',
  })
})

test('rejects animated WebP using both chunk and VP8X markers', async () => {
  await assert.rejects(validate(webp('ANIM', Buffer.alloc(2))), {
    message: '不支持动态 WebP',
  })
  await assert.rejects(validate(webp('VP8X', Buffer.from([2]))), {
    message: '不支持动态 WebP',
  })
  await validate(webp('VP8X', Buffer.from([0])))
})

test('does not claim an unknown image is AVIF based only on MIME', async () => {
  await assert.rejects(validate(Buffer.from('unknown'), 'image/avif'), {
    message: '不支持此图片格式',
  })
})
