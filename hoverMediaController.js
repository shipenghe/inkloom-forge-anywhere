// The media entry is independent of automatic video capture. It only installs
// on already granted websites, or in a tab explicitly opened from the popup.
;(() => {
  const ID = 'inkloom-hover-video'
  const FILES = [
    'i18n-data.js',
    'i18n.js',
    'mediaFallback.js',
    'videoCandidates.js',
    'hoverVideo.js',
  ]
  const inFlight = new Map()
  let queue = Promise.resolve()

  function serial(task) {
    const pending = queue.then(task, task)
    queue = pending.catch(() => {})
    return pending
  }
  function webOrigin(raw) {
    try {
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol)) return null
      return `${url.protocol}//${url.hostname}/*`
    } catch {
      return null
    }
  }
  function matchesFor(origins) {
    const matches = new Set()
    for (const pattern of origins || []) {
      if (pattern === '<all_urls>') {
        matches.add('http://*/*')
        matches.add('https://*/*')
      } else if (typeof pattern === 'string') {
        if (/^https?:\/\/[^/]+\/.*$/.test(pattern)) matches.add(pattern)
        else if (/^\*:\/\/[^/]+\/.*$/.test(pattern)) {
          matches.add(pattern.replace('*:', 'http:'))
          matches.add(pattern.replace('*:', 'https:'))
        }
      }
    }
    return [...matches].sort()
  }
  async function isGranted(raw) {
    const origin = webOrigin(raw)
    return (
      !!origin && !!(await chrome.permissions.contains({ origins: [origin] }))
    )
  }
  async function inject(tabId) {
    if (!Number.isInteger(tabId)) return false
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!webOrigin(tab?.url)) return false
      // activeTab can authorize this probe even when there is no persistent
      // host grant. Chrome rejects it before execution on inaccessible pages.
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => typeof globalThis.__forgeHoverVideoCleanup === 'function',
      })
      const current = results?.find((result) => result.frameId === 0)
      if (current?.result === true) return true
      if (!current?.documentId) return false
      await chrome.scripting.executeScript({
        target: { tabId, documentIds: [current.documentId] },
        files: FILES,
      })
      return true
    } catch {
      // Browser pages, revoked permissions and navigated documents are normal.
      return false
    }
  }
  function injectTab(tabId) {
    if (inFlight.has(tabId)) return inFlight.get(tabId)
    const pending = inject(tabId).finally(() => inFlight.delete(tabId))
    inFlight.set(tabId, pending)
    return pending
  }
  async function reconcileRegistration(matches) {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [ID],
    })
    const current = existing.find((script) => script.id === ID)
    if (
      current &&
      JSON.stringify([...(current.matches || [])].sort()) ===
        JSON.stringify(matches) &&
      JSON.stringify(current.js) === JSON.stringify(FILES) &&
      (current.runAt || 'document_idle') === 'document_idle' &&
      (current.world || 'ISOLATED') === 'ISOLATED' &&
      current.allFrames !== true &&
      current.persistAcrossSessions !== false
    )
      return
    if (current) await chrome.scripting.unregisterContentScripts({ ids: [ID] })
    if (matches.length)
      await chrome.scripting.registerContentScripts([
        {
          id: ID,
          matches,
          js: FILES,
          world: 'ISOLATED',
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ])
  }
  async function recoverInternal(revoked = false) {
    let origins = []
    let firstError
    try {
      origins = (await chrome.permissions.getAll()).origins || []
    } catch (error) {
      firstError = error
      revoked = true
    }
    try {
      await reconcileRegistration(matchesFor(origins))
    } catch (error) {
      firstError ||= error
    }
    const tabs = await chrome.tabs.query({}).catch(() => [])
    await Promise.allSettled(
      tabs.map(async (tab) => {
        if (!Number.isInteger(tab.id)) return
        const granted =
          !firstError && (await isGranted(tab.url).catch(() => false))
        if (granted) await injectTab(tab.id)
        else if (revoked)
          await chrome.tabs
            .sendMessage(tab.id, { kind: 'HOVER_MEDIA_STOP' }, { frameId: 0 })
            .catch(() => {})
      })
    )
    if (firstError) throw firstError
  }
  function recover() {
    return serial(() => recoverInternal())
  }
  function onTabUpdated(tabId, changeInfo) {
    // Dynamic scripts cover newly loaded granted pages. This also restores an
    // explicitly authorized activeTab document after a same-origin navigation;
    // the probe leaves an existing SPA document and its open entry untouched.
    if (changeInfo.status === 'complete') return injectTab(tabId)
    return Promise.resolve(false)
  }
  globalThis.forgeMediaEntryController = { recover, injectTab, onTabUpdated }
  chrome.permissions.onAdded?.addListener(() => {
    void recover().catch(() => {})
  })
  chrome.permissions.onRemoved?.addListener(() => {
    void serial(() => recoverInternal(true)).catch(() => {})
  })
})()
