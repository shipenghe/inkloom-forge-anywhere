// Display-only localization. Internal messages and media/user titles stay intact.
;(() => {
  if (globalThis.ForgeI18n) return
  const entries = globalThis.ForgeLocaleMessages || []
  const byKey = new Map(entries.map((row) => [row[0], row]))
  const bySource = new Map(entries.map((row) => [row[1], row]))
  const listeners = new Set()
  const PREFERENCE_KEY = 'languagePreference'
  let preference = 'auto'
  let revision = 0
  const normalize = (value) =>
    ['auto', 'zh_CN', 'en'].includes(value) ? value : 'auto'
  const browserLocale = () => {
    try {
      return chrome.i18n.getUILanguage() || 'en'
    } catch {
      return 'en'
    }
  }
  const locale = () =>
    preference === 'auto'
      ? /^zh(?:[-_]|$)/i.test(browserLocale())
        ? 'zh_CN'
        : 'en'
      : preference
  const message = (key) => {
    const row = byKey.get(key)
    return row ? row[locale() === 'en' ? 2 : 1] : ''
  }
  function text(value) {
    if (typeof value !== 'string' || !value) return value || ''
    if (locale() === 'zh_CN') return value
    const row = bySource.get(value)
    if (row) return row[2]
    // Compose only extension messages. Never apply this function to user titles.
    const sent = value.match(/^(图片|视频片段|视频|音频)已交给画布(（无声）)?$/)
    if (sent)
      return `${text(sent[1])} sent to canvas${sent[2] ? ' (No audio)' : ''}`
    const http = value.match(/^无法获取媒体（HTTP (\d{3})）$/)
    if (http) return `Couldn’t fetch media (HTTP ${http[1]})`
    const range = value.match(/^(全片|片段) ([\d:]+–[\d:]+)$/)
    if (range) return `${text(range[1])} ${range[2]}`
    const restart = value.match(/^(.*)，请重新启用采集并选择视频$/)
    if (restart)
      return `${text(restart[1])}. Start capture again and choose a video`
    if (value.includes(' · ')) return value.split(' · ').map(text).join(' · ')
    if (/\p{Script=Han}/u.test(value)) return 'Something went wrong. Try again'
    return value
  }
  function applyDOM(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]'))
      node.textContent = message(node.getAttribute('data-i18n'))
    for (const attr of ['title', 'aria-label', 'alt'])
      for (const node of root.querySelectorAll(`[data-i18n-${attr}]`))
        node.setAttribute(attr, message(node.getAttribute(`data-i18n-${attr}`)))
    if (root.documentElement)
      root.documentElement.lang = locale() === 'en' ? 'en' : 'zh-CN'
  }
  function notify() {
    for (const listener of listeners) {
      try {
        listener(locale())
      } catch {
        /* One surface must not block another. */
      }
    }
  }
  const initialRevision = revision
  const ready = (async () => {
    try {
      const state = await chrome.storage.local.get(PREFERENCE_KEY)
      if (revision === initialRevision)
        preference = normalize(state[PREFERENCE_KEY])
    } catch {
      /* Follow the browser if saved preferences cannot be read. */
    }
    return locale()
  })()
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[PREFERENCE_KEY]) return
    revision++
    preference = normalize(changes[PREFERENCE_KEY].newValue)
    notify()
  })
  async function setPreference(value) {
    if (!['auto', 'zh_CN', 'en'].includes(value))
      throw new Error('Invalid language')
    await ready
    await chrome.storage.local.set({ [PREFERENCE_KEY]: value })
    // Storage notifications may arrive later in this context. Apply immediately.
    if (preference !== value) {
      revision++
      preference = value
      notify()
    }
  }
  globalThis.ForgeI18n = {
    ready,
    text,
    message,
    applyDOM,
    locale,
    preference: () => preference,
    setPreference,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})()
