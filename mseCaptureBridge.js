// Isolated-world bridge. All values received from MAIN world are untrusted.
;(() => {
  if (globalThis.__inkloomMseBridge) return
  globalThis.__inkloomMseBridge = true
  const MAX_READ = 192 * 1024
  const MAX_TOTAL = 72 * 1024 * 1024
  const MAX_PARTS = 4104
  let metadata = null
  let authorized = false
  let stopped = false
  let authorizedNonce = null
  let authorizedAuto = false
  let authorization = null
  const allowedErrors = new Set([
    '已有正在采集的视频，请先停止',
    '该视频不是受支持的分段视频',
    '无法唯一确定视频，请重新选择',
    '未捕获到播放器，请重新启用采集并刷新页面',
    '无法关联该视频的播放器，可能使用不支持的播放方式',
    '播放器尚未加载媒体轨道，请先播放视频后重试',
    '缺少视频初始化数据，请重新启用采集并刷新页面',
    '视频使用了暂不支持的播放时间配置或格式切换',
    '视频媒体轨道数量过多，暂不支持采集',
    '采集期间视频格式发生切换，请重新采集',
    '采集期间视频播放时间配置发生变化，暂不支持采集',
    '视频使用了暂不支持的媒体格式',
    '视频使用了暂不支持的播放时间配置',
    '请先选择要采集的视频',
    '视频来源已变化，请重新启用采集',
    '尚未获取到足够片段，请继续播放或拖动进度条后重试',
    '采集片段超过内存上限，请缩短播放时间后重试',
    '请先准备采集片段',
    '片段读取参数无效',
    '片段读取位置无效',
  ])
  function request(kind, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        reject(new Error('采集连接超时，请重新启用并刷新页面'))
      }, 2500)
      function onMessage(event) {
        if (
          event.source !== window ||
          event.data?.__inkloomMse !== 'response' ||
          event.data.id !== id
        )
          return
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        if (!event.data.ok) {
          reject(
            new Error(
              allowedErrors.has(event.data.error)
                ? event.data.error
                : '视频采集失败，请重新启用并刷新页面'
            )
          )
          return
        }
        resolve(event.data.value)
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ __inkloomMse: 'request', id, kind, ...fields }, '*')
    })
  }
  function checkedMetadata(value) {
    if (
      !value ||
      !Array.isArray(value.tracks) ||
      value.tracks.length < 1 ||
      value.tracks.length > 4 ||
      !Number.isSafeInteger(value.size) ||
      value.size < 1 ||
      value.size > MAX_TOTAL
    )
      throw new Error('视频片段信息无效，请重新采集')
    let total = 0
    let count = 0
    const tracks = value.tracks.map((track) => {
      if (
        !track ||
        typeof track.mime !== 'string' ||
        track.mime.length > 200 ||
        !/^(audio|video)\/mp4(?:\s*;|$)/i.test(track.mime) ||
        !Number.isFinite(track.timestampOffset) ||
        Math.abs(track.timestampOffset) > 31536000 ||
        !Number.isFinite(track.appendWindowStart) ||
        track.appendWindowStart < 0 ||
        track.appendWindowStart > 31536000 ||
        (track.appendWindowEnd !== null &&
          (!Number.isFinite(track.appendWindowEnd) ||
            track.appendWindowEnd <= track.appendWindowStart ||
            track.appendWindowEnd > 31536000)) ||
        !Array.isArray(track.parts) ||
        track.parts.length < 3
      )
        throw new Error('视频片段信息无效，请重新采集')
      count += track.parts.length
      const parts = track.parts.map((size) => {
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_TOTAL)
          throw new Error('视频片段信息无效，请重新采集')
        total += size
        return size
      })
      return {
        mime: track.mime,
        parts,
        timestampOffset: track.timestampOffset,
        appendWindowStart: track.appendWindowStart,
        appendWindowEnd: track.appendWindowEnd,
      }
    })
    if (count > MAX_PARTS || total !== value.size)
      throw new Error('视频片段信息无效，请重新采集')
    return { tracks, size: total }
  }
  function base64(bytes) {
    let result = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return btoa(result)
  }
  async function handle(message) {
    switch (message.kind) {
      case 'MSE_STATUS': {
        if (stopped) throw new Error('采集已停止')
        if (authorized)
          return {
            nonce: authorizedNonce,
            ...(authorizedAuto ? { auto: true } : {}),
          }
        if (!authorization) {
          authorization = (async () => {
            const value = await request('STATUS')
            if (
              !value ||
              typeof value.nonce !== 'string' ||
              !/^[a-zA-Z0-9-]{16,128}$/.test(value.nonce)
            )
              throw new Error('采集连接无效，请重新启用并刷新页面')
            if (value.auto === true && value.hasMedia !== true)
              throw new Error('播放器尚未加载媒体轨道，请先播放视频后重试')
            const result = await chrome.runtime.sendMessage({
              kind: 'MSE_AUTHORIZE',
              nonce: value.nonce,
              ...(value.auto === true ? { auto: true } : {}),
            })
            if (!result?.ok) {
              if (value.auto === true) {
                stopped = true
                await request('STOP').catch(() => {})
              }
              throw new Error('采集连接未授权，请重新启用并刷新页面')
            }
            if (stopped) throw new Error('采集已停止')
            authorized = true
            authorizedNonce = value.nonce
            authorizedAuto = value.auto === true
            return {
              nonce: value.nonce,
              ...(authorizedAuto ? { auto: true } : {}),
            }
          })().finally(() => {
            authorization = null
          })
        }
        return authorization
      }
      case 'MSE_SELECT': {
        if (!authorized) throw new Error('采集连接未授权')
        if (
          typeof message.url !== 'string' ||
          !message.url.startsWith('blob:') ||
          message.url.length > 4096
        )
          throw new Error('无法识别所选视频')
        const value = await request('SELECT', { url: message.url })
        if (
          !Number.isSafeInteger(value?.tracks) ||
          value.tracks < 1 ||
          value.tracks > 4
        )
          throw new Error('视频轨道信息无效')
        metadata = null
        return { tracks: value.tracks }
      }
      case 'MSE_SNAPSHOT':
        if (!authorized) throw new Error('采集连接未授权')
        metadata = checkedMetadata(await request('SNAPSHOT'))
        return metadata
      case 'MSE_READ': {
        if (!authorized) throw new Error('采集连接未授权')
        const { track, part, offset, length } = message
        if (
          ![track, part, offset, length].every(Number.isSafeInteger) ||
          track < 0 ||
          part < 0 ||
          offset < 0 ||
          length < 1 ||
          length > MAX_READ ||
          !metadata ||
          track >= metadata.tracks.length ||
          part >= metadata.tracks[track].parts.length ||
          offset >= metadata.tracks[track].parts[part]
        )
          throw new Error('视频片段读取参数无效')
        const bytes = await request('READ', { track, part, offset, length })
        const expected = Math.min(
          length,
          metadata.tracks[track].parts[part] - offset
        )
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected)
          throw new Error('视频片段数据无效，请重新采集')
        return base64(bytes)
      }
      case 'MSE_RELEASE':
        if (!authorized) throw new Error('采集连接未授权')
        metadata = null
        await request('RELEASE')
        return null
      case 'MSE_STOP':
      case 'MSE_STOP_CAPTURE':
        metadata = null
        authorized = false
        authorizedNonce = null
        authorizedAuto = false
        stopped = true
        await request('STOP')
        return null
      default:
        throw new Error('未知采集操作')
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      !message ||
      ![
        'MSE_STATUS',
        'MSE_SELECT',
        'MSE_SNAPSHOT',
        'MSE_READ',
        'MSE_RELEASE',
        'MSE_STOP',
        'MSE_STOP_CAPTURE',
      ].includes(message.kind)
    )
      return
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: '采集请求来源无效' })
      return
    }
    handle(message).then(
      (value) => sendResponse({ ok: true, value }),
      (error) =>
        sendResponse({ ok: false, error: error?.message || '视频采集失败' })
    )
    return true
  })
  window.addEventListener(
    'pagehide',
    () => {
      stopped = true
      authorized = false
      metadata = null
    },
    { once: true }
  )
  // A page with no MSE player consumes no background capture slot. The
  // MAIN-world notice is merely a hint; STATUS and background authorization
  // are still checked against this frame's actual identity.
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.data?.__inkloomMse === 'available' &&
      !authorized &&
      !stopped
    )
      void handle({ kind: 'MSE_STATUS' }).catch(() => {})
  })
  // MAIN and isolated document_start scripts can start in either order.
  // The background authorizes with this frame's real tab/document identity.
  ;(async () => {
    for (let attempt = 0; attempt < 4 && !authorized && !stopped; attempt++) {
      try {
        await handle({ kind: 'MSE_STATUS' })
        return
      } catch {
        if (attempt < 3)
          await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  })()
})()
