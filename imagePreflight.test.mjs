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

function avif(width, height, compatibleBrands = '') {
  const box = (type, data) => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(8 + data.length)
    header.write(type, 4)
    return Buffer.concat([header, data])
  }
  const extent = Buffer.alloc(12)
  extent.writeUInt32BE(width, 4)
  extent.writeUInt32BE(height, 8)
  return Buffer.concat([
    box('ftyp', Buffer.from(`avif\0\0\0\0avifmif1${compatibleBrands}`)),
    box(
      'meta',
      Buffer.concat([
        Buffer.alloc(4),
        box('iprp', box('ipco', box('ispe', extent))),
      ])
    ),
    box('mdat', Buffer.alloc(10)),
  ])
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

test('opt-in AVIF conversion refuses animated, incomplete or oversized input before decoding', async () => {
  let decodeCalls = 0
  const browser = vm.createContext({
    Uint8Array,
    DataView,
    createImageBitmap() {
      decodeCalls++
    },
    OffscreenCanvas: class {},
  })
  vm.runInContext(source, browser)
  const prepare = (bytes) =>
    browser.__inkloomImagePreflight.validate(new Blob([bytes]), {
      convertAvif: true,
    })
  // Check beyond the 32-byte streaming preflight before invoking the decoder.
  await assert.rejects(prepare(avif(824, 464, 'mif1mif1avis')), {
    message: '不支持 AVIF',
  })
  await assert.rejects(prepare(avif(824, 464).subarray(0, -1)), {
    message: '不支持 AVIF',
  })
  await assert.rejects(prepare(avif(8192, 4096)), {
    message: '媒体文件过大，无法导入',
  })
  await assert.rejects(prepare(Buffer.from('GIF89a')), {
    message: '不支持 GIF',
  })
  await assert.rejects(prepare(webp('ANIM', Buffer.alloc(2))), {
    message: '不支持动态 WebP',
  })
  assert.equal(decodeCalls, 0)
})
