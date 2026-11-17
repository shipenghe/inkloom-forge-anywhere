;(() => {
  const formats = {
    MP3: { extension: 'mp3', mime: 'audio/mpeg', aliases: ['audio/mp3'] },
    WAVE: {
      extension: 'wav',
      mime: 'audio/wav',
      aliases: ['audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
    },
    MP4: {
      extension: 'm4a',
      mime: 'audio/mp4',
      aliases: ['audio/m4a', 'audio/x-m4a'],
    },
    ADTS: {
      extension: 'aac',
      mime: 'audio/aac',
      aliases: ['audio/aacp', 'audio/x-aac'],
    },
    OGG: { extension: 'ogg', mime: 'audio/ogg', aliases: ['application/ogg'] },
    FLAC: { extension: 'flac', mime: 'audio/flac', aliases: ['audio/x-flac'] },
  }

  function responseMime(contentType, pathname) {
    const mime = contentType?.split(';')[0].trim().toLowerCase()
    const extension = pathname.match(/\.([^./]+)$/)?.[1].toLowerCase()
    const supported = Object.values(formats)
    const named = supported.find((format) => format.extension === extension)
    if (!mime || mime === 'application/octet-stream') return named?.mime
    const declared = supported.find(
      (format) => format.mime === mime || format.aliases.includes(mime)
    )
    if (!named || named === declared) return declared?.mime
  }

  globalThis.ForgeAudioFormats = { formats, responseMime }
})()
