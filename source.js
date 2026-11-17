// Blob URLs must be read in the page where they were created.
;(() => {
  if (globalThis.__inkloomMediaSource) return
  globalThis.__inkloomMediaSource = true
  function encode(bytes) {
    let result = ''
    for (let start = 0; start < bytes.length; start += 0x8000) {
      result += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
    }
    return btoa(result)
  }
  function mediaPreview(message) {
    // Preview only pixels already available to this document. In particular,
    // do not load a poster or refetch a URL just to decorate the popup.
    const result = { ok: true }
    try {
      const image = message.mediaKind === 'image'
      const audio = message.mediaKind === 'audio'
      if (!image && !audio && message.mediaKind !== 'video') return result
      const url = image ? message.displayUrl || message.url : message.url
      if (typeof url !== 'string' || !url) return result
      const matches = (element) =>
        element?.isConnected && (element.currentSrc || element.src) === url
      let media = image ? globalThis.__inkloomSelectedImage : null
      if (!matches(media)) {
        const candidates = [
          ...document.querySelectorAll(image ? 'img' : message.mediaKind),
        ].filter(matches)
        media = candidates.length === 1 ? candidates[0] : null
      }
      if (!media) return result
      const title = document.title?.replace(/\s+/g, ' ').trim().slice(0, 160)
      if (title && !/^https?:\/\//i.test(title)) result.title = title
      if (!image && Number.isFinite(media.duration) && media.duration > 0)
        result.duration = media.duration
      if (audio) {
        if (media.hasAttribute?.('data-forge-qq-song')) {
          if (media.hasAttribute('data-forge-qq-trial'))
            result.audioScope = 'preview'
          else {
            const duration = Number(
              media.getAttribute('data-forge-qq-duration')
            )
            if (Number.isFinite(duration) && duration > 0)
              result.audioTrackDuration = duration
          }
        }
        return result
      }
      const width = image ? media.naturalWidth : media.videoWidth
      const height = image ? media.naturalHeight : media.videoHeight
      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        (image ? !media.complete : media.readyState < 2)
      )
        return result
      const scale = Math.min(1, 144 / Math.max(width, height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const context = canvas.getContext('2d')
      if (!context) return result
      context.drawImage(media, 0, 0, canvas.width, canvas.height)
      const preview = canvas.toDataURL('image/webp', 0.7)
      if (
        preview.length <= 100_000 &&
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          preview
        )
      )
        result.previewDataUrl = preview
    } catch {
      // Unavailable decoded frames and origin-tainted pixels are optional.
    }
    return result
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === 'READ_MEDIA_PREVIEW') {
      sendResponse(mediaPreview(message))
      return
    }
    if (
      !message ||
      !['READ_BLOB', 'READ_DISPLAYED_IMAGE', 'READ_CACHED_AUDIO'].includes(
        message.kind
      )
    )
      return
    ;(async () => {
      let unavailableVideo = false
      let startedTransfer = false
      const cachedAudio = message.kind === 'READ_CACHED_AUDIO'
      try {
        let response
        let blob
        if (message.kind === 'READ_DISPLAYED_IMAGE') {
          const url = message.displayUrl || message.url
          let image = globalThis.__inkloomSelectedImage
          if (!image?.isConnected || (image.currentSrc || image.src) !== url) {
            const matches = [...document.querySelectorAll('img')].filter(
              (candidate) => (candidate.currentSrc || candidate.src) === url
            )
            image = matches.length === 1 ? matches[0] : null
          }
          if (
            !image ||
            !image.complete ||
            !image.naturalWidth ||
            !image.naturalHeight ||
            image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024
          ) {
            sendResponse({ ok: false, code: 'DISPLAYED_IMAGE_UNAVAILABLE' })
            return
          }
          try {
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            canvas.getContext('2d').drawImage(image, 0, 0)
            blob = await new Promise((resolve) =>
              canvas.toBlob(resolve, 'image/png')
            )
          } catch {
            // A cross-origin image without CORS cannot be exported.
          }
          if (!blob || !blob.size) {
            sendResponse({ ok: false, code: 'DISPLAYED_IMAGE_UNAVAILABLE' })
            return
          }
        } else {
          // only-if-cached is limited to same-origin requests. It must not
          // initiate a second network fetch before the import fallback.
          if (
            cachedAudio &&
            (message.mediaKind !== 'audio' ||
              new URL(message.url).origin !== location.origin)
          ) {
            sendResponse({ ok: false, code: 'CACHED_AUDIO_UNAVAILABLE' })
            return
          }
          try {
            response = cachedAudio
              ? await fetch(message.url, {
                  mode: 'same-origin',
                  cache: 'only-if-cached',
                  redirect: 'error',
                })
              : await fetch(message.url)
          } catch (error) {
            if (message.mediaKind === 'video' && error instanceof TypeError) {
              unavailableVideo = true
              throw new Error('无法读取视频，可能是分段播放或来源限制')
            }
            throw error
          }
          if (!response.ok) throw new Error('无法读取页面中的媒体')
          if (
            message.mediaKind === 'audio' &&
            (response.status === 206 || response.headers.get('content-range'))
          )
            throw new Error('获取到的音频不完整')
          const declared = Number(response.headers.get('content-length'))
          const maxSize = 200 * 1024 * 1024
          if (declared > maxSize || !response.body)
            throw new Error('媒体文件过大或无法读取')
          const reader = response.body.getReader()
          const chunks = []
          let total = 0
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > maxSize) {
                await reader.cancel()
                throw new Error('媒体文件过大')
              }
              chunks.push(value)
            }
          } finally {
            reader.releaseLock()
          }
          const length = response.headers.get('content-length')
          if (
            message.mediaKind === 'audio' &&
            length !== null &&
            !response.headers.get('content-encoding') &&
            Number(length) !== total
          )
            throw new Error('获取到的音频不完整')
          blob = new Blob(chunks, {
            type: response.headers.get('content-type')?.split(';')[0] || '',
          })
        }
        if (blob.size > 200 * 1024 * 1024) throw new Error('媒体文件过大')
        if (message.mediaKind === 'image')
          await globalThis.__inkloomImagePreflight.validate(blob)
        const started = await chrome.runtime.sendMessage({
          kind: 'BLOB_META',
          transferId: message.transferId,
          mime: blob.type,
          size: blob.size,
        })
        if (!started?.ok) throw new Error(started?.error || '无法开始传输')
        startedTransfer = true
        let sequence = 0
        for (let start = 0; start < blob.size; start += 192 * 1024) {
          const bytes = new Uint8Array(
            await blob.slice(start, start + 192 * 1024).arrayBuffer()
          )
          const result = await chrome.runtime.sendMessage({
            kind: 'BLOB_CHUNK',
            transferId: message.transferId,
            sequence,
            data: encode(bytes),
          })
          if (!result?.ok) throw new Error(result?.error || '发送媒体失败')
          sequence += 1
        }
        const result = await chrome.runtime.sendMessage({
          kind: 'BLOB_END',
          transferId: message.transferId,
        })
        if (!result?.ok) throw new Error(result?.error || '发送失败')
        if (globalThis.__inkloomPickerBlobUrl === message.url) {
          URL.revokeObjectURL(message.url)
          delete globalThis.__inkloomPickerBlobUrl
        }
        sendResponse(result)
      } catch (error) {
        if (startedTransfer || message.kind === 'READ_BLOB')
          await chrome.runtime
            .sendMessage({ kind: 'BLOB_FAIL', transferId: message.transferId })
            .catch(() => {})
        sendResponse({
          ok: false,
          error: error?.message || '读取媒体失败',
          ...(cachedAudio && !startedTransfer
            ? { code: 'CACHED_AUDIO_UNAVAILABLE' }
            : {}),
          ...(unavailableVideo ? { code: 'VIDEO_BLOB_UNAVAILABLE' } : {}),
        })
      }
    })()
    return true
  })
})()
