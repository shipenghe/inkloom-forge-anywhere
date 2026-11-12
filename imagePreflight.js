// Mirrors the existing Inkloom static-image format checks. The file stays
// unchanged; the canvas remains responsible for decoding and uploading it.
;(() => {
  if (globalThis.__inkloomImagePreflight) return

  function ascii(bytes, start, length) {
    return String.fromCharCode(...bytes.subarray(start, start + length))
  }

  function formatOf(bytes) {
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    )
      return 'jpeg'
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      ascii(bytes, 1, 3) === 'PNG' &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    )
      return 'png'
    if (
      bytes.length >= 12 &&
      ascii(bytes, 0, 4) === 'RIFF' &&
      ascii(bytes, 8, 4) === 'WEBP'
    )
      return 'webp'
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
      const size = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).getUint32(0)
      if (size === 0 || size >= 16) {
        const end = Math.min(bytes.length, size || bytes.length)
        const brands = [ascii(bytes, 8, 4)]
        for (let offset = 16; offset + 4 <= end; offset += 4)
          brands.push(ascii(bytes, offset, 4))
        if (brands.includes('avif') || brands.includes('avis')) return 'avif'
      }
    }
    if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6)))
      return 'gif'
    return 'other'
  }

  function isAnimatedWebP(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4)
      const length = view.getUint32(offset + 4, true)
      const payload = offset + 8
      if (payload + length > bytes.length) return false
      if (type === 'ANIM' || type === 'ANMF') return true
      if (type === 'VP8X' && length >= 1 && bytes[payload] & 0x02) return true
      offset = payload + length + (length % 2)
    }
    return false
  }

  async function validate(blob) {
    const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
    const format = formatOf(header)
    if (format === 'avif') throw new Error('不支持 AVIF')
    if (format === 'gif') throw new Error('不支持 GIF')
    if (format === 'other') throw new Error('不支持此图片格式')
    if (format === 'webp') {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (isAnimatedWebP(bytes)) throw new Error('不支持动态 WebP')
    }
  }

  globalThis.__inkloomImagePreflight = { validate, formatOf }
})()
