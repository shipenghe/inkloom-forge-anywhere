// Check the static image formats Inkloom accepts. The background worker can
// also convert a verified static AVIF when it has to fetch the original file.
;(() => {
  if (globalThis.__inkloomImagePreflight) return
  const MAX_AVIF_BYTES = 16 * 1024 * 1024
  const MAX_AVIF_PIXELS = 16 * 1024 * 1024
  const MAX_AVIF_SIDE = 8192

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
        if (brands.includes('avis')) return 'avis'
        if (brands.includes('avif')) return 'avif'
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

  function avifConversionAvailable() {
    return (
      typeof createImageBitmap === 'function' &&
      typeof OffscreenCanvas === 'function'
    )
  }

  function checkAvifDimensions(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let boxCount = 0
    function* boxes(start, end) {
      while (start < end) {
        if (end - start < 8 || ++boxCount > 4096) throw new Error('不支持 AVIF')
        const type = ascii(bytes, start + 4, 4)
        let size = view.getUint32(start)
        let header = 8
        if (size === 1) {
          if (end - start < 16) throw new Error('不支持 AVIF')
          size = Number(view.getBigUint64(start + 8))
          header = 16
        } else if (size === 0) size = end - start
        if (!Number.isSafeInteger(size) || size < header || size > end - start)
          throw new Error('不支持 AVIF')
        yield { type, body: start + header, end: start + size }
        start += size
      }
    }

    let hasDimensions = false
    for (const box of boxes(0, bytes.length)) {
      // Sequence AVIF can contain a movie track even if the ftyp also says avif.
      if (box.type === 'moov') throw new Error('不支持 AVIF')
      if (box.type !== 'meta') continue
      for (const property of boxes(box.body + 4, box.end)) {
        if (property.type !== 'iprp') continue
        for (const container of boxes(property.body, property.end)) {
          if (container.type !== 'ipco') continue
          for (const item of boxes(container.body, container.end)) {
            if (item.type !== 'ispe') continue
            if (item.end - item.body < 12) throw new Error('不支持 AVIF')
            checkDimensions(
              view.getUint32(item.body + 4),
              view.getUint32(item.body + 8)
            )
            hasDimensions = true
          }
        }
      }
    }
    if (!hasDimensions) throw new Error('不支持 AVIF')
  }

  function checkDimensions(width, height) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    )
      throw new Error('不支持 AVIF')
    if (
      width > MAX_AVIF_SIDE ||
      height > MAX_AVIF_SIDE ||
      width * height > MAX_AVIF_PIXELS
    )
      throw new Error('媒体文件过大，无法导入')
  }

  async function convertStaticAvif(blob, header) {
    if (!avifConversionAvailable()) throw new Error('不支持 AVIF')
    if (blob.size > MAX_AVIF_BYTES) throw new Error('媒体文件过大，无法导入')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const size = new DataView(header.buffer).getUint32(0)
    if (
      size < 16 ||
      size > Math.min(4096, bytes.length) ||
      formatOf(bytes.subarray(0, size)) !== 'avif'
    )
      throw new Error('不支持 AVIF')
    checkAvifDimensions(bytes)

    let bitmap
    try {
      bitmap = await createImageBitmap(blob.slice(0, blob.size, 'image/avif'))
    } catch {
      throw new Error('不支持 AVIF')
    }
    try {
      checkDimensions(bitmap.width, bitmap.height)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('不支持 AVIF')
      context.drawImage(bitmap, 0, 0)
      const result = await canvas
        .convertToBlob({ type: 'image/png' })
        .catch(() => null)
      if (!result?.size || result.type !== 'image/png')
        throw new Error('不支持 AVIF')
      return result
    } finally {
      bitmap.close()
    }
  }

  async function validate(blob, { convertAvif = false } = {}) {
    const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
    const format = formatOf(header)
    if (format === 'avif' && convertAvif) return convertStaticAvif(blob, header)
    if (format === 'avif' || format === 'avis') throw new Error('不支持 AVIF')
    if (format === 'gif') throw new Error('不支持 GIF')
    if (format === 'other') throw new Error('不支持此图片格式')
    if (format === 'webp') {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (isAnimatedWebP(bytes)) throw new Error('不支持动态 WebP')
    }
    return blob
  }

  globalThis.__inkloomImagePreflight = {
    validate,
    formatOf,
    avifConversionAvailable,
    MAX_AVIF_BYTES,
  }
})()
