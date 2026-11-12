// Owns the short-lived registration and the single tab allowed to export MSE data.
// The page-visible nonce is a correlation value, never an authorization secret.
;(() => {
  const KEY = '__inkloom_mse_prepare_v1'
  const STATE_KEY = 'mseCapture'
  const SCRIPT_IDS = ['inkloom-mse-main', 'inkloom-mse-bridge']
  const AUTO_SCRIPT_IDS = ['inkloom-mse-auto-main', 'inkloom-mse-auto-bridge']
  const AUTO_FLAG = 'autoCaptureEnabled'
  const AUTO_SESSIONS = 'mseAutoSessions'
  const AUTO_DENIALS = 'mseAutoDenials'
  const AUTO_MAX_PAGES = 4
  const AUTO_ORIGINS = ['http://*/*', 'https://*/*']
  const PREPARE_MS = 15_000
  let queue = Promise.resolve()
  let expiryTimer

  function serial(task) {
    const pending = queue.then(task, task)
    queue = pending.catch(() => {})
    return pending
  }
  async function getState() {
    return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] || null
  }
  async function autoEnabled() {
    return (await chrome.storage.local.get(AUTO_FLAG))[AUTO_FLAG] !== false
  }
  async function getAutoSessions() {
    return (
      (await chrome.storage.session.get(AUTO_SESSIONS))[AUTO_SESSIONS] || {}
    )
  }
  async function getAutoCapture(tabId) {
    if (!Number.isInteger(tabId) || !(await autoEnabled())) return null
    return (await getAutoSessions())[tabId] || null
  }
  async function getAutoDenial(tabId) {
    if (!Number.isInteger(tabId) || !(await autoEnabled())) return null
    const entries =
      (await chrome.storage.session.get(AUTO_DENIALS))[AUTO_DENIALS] || {}
    return entries[tabId] || null
  }
  async function removeAutoDenial(tabId) {
    const entries =
      (await chrome.storage.session.get(AUTO_DENIALS))[AUTO_DENIALS] || {}
    if (!entries[tabId]) return
    delete entries[tabId]
    await chrome.storage.session.set({ [AUTO_DENIALS]: entries })
  }
  async function unregisterAuto() {
    const scripts = await chrome.scripting.getRegisteredContentScripts({
      ids: AUTO_SCRIPT_IDS,
    })
    const ids = scripts
      .map((script) => script.id)
      .filter((id) => AUTO_SCRIPT_IDS.includes(id))
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids })
  }
  async function registerAuto() {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: AUTO_SCRIPT_IDS,
    })
    const ids = new Set(existing.map((script) => script.id))
    if (AUTO_SCRIPT_IDS.every((id) => ids.has(id))) return
    await unregisterAuto()
    await chrome.scripting.registerContentScripts([
      {
        id: AUTO_SCRIPT_IDS[0],
        matches: AUTO_ORIGINS,
        js: ['mseAutoMarker.js', 'mseCaptureMain.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      },
      {
        id: AUTO_SCRIPT_IDS[1],
        matches: AUTO_ORIGINS,
        js: ['mseCaptureBridge.js'],
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ])
  }
  async function stopAutoSessions() {
    const sessions = await getAutoSessions().catch(() => ({}))
    const manual = await getState().catch(() => null)
    // Clear authorizations first, even if a page is gone or unresponsive.
    let cleanupError
    try {
      await chrome.storage.session.remove([AUTO_SESSIONS, AUTO_DENIALS])
    } catch (error) {
      cleanupError = error
    }
    const stops = Object.values(sessions).map((capture) =>
      chrome.tabs
        .sendMessage(
          capture.tabId,
          { kind: 'MSE_STOP' },
          { documentId: capture.documentId }
        )
        .catch(() => {})
    )
    // Documents without a player have hooks but have not registered a session.
    // Stop those too; inaccessible browser pages simply reject the message.
    if (chrome.tabs.query) {
      const tabs = await chrome.tabs.query({}).catch(() => [])
      for (const tab of tabs) {
        if (
          Number.isInteger(tab.id) &&
          !sessions[tab.id] &&
          tab.id !== manual?.tabId
        )
          stops.push(
            chrome.tabs
              .sendMessage(tab.id, { kind: 'MSE_STOP' }, { frameId: 0 })
              .catch(() => {})
          )
      }
    }
    await Promise.allSettled(stops)
    if (cleanupError) throw cleanupError
  }
  async function disableAutoInternal() {
    let firstError
    try {
      await chrome.storage.local.set({ [AUTO_FLAG]: false })
    } catch (error) {
      firstError = error
    }
    try {
      await unregisterAuto()
    } catch (error) {
      firstError ||= error
    }
    try {
      await stopAutoSessions()
    } catch (error) {
      firstError ||= error
    }
    if (firstError) throw firstError
  }
  function setAutoEnabled(enabled) {
    return serial(async () => {
      if (enabled) {
        if (!(await chrome.permissions.contains({ origins: AUTO_ORIGINS })))
          throw new Error('请先授权访问网页')
        // Keep existing automatic sessions; retire any legacy manual session.
        if (!(await autoEnabled()) || (await getState())) await stopInternal()
        // Publish the flag before registration: otherwise a newly loaded page
        // can run the hook and be permanently rejected in the gap.
        await chrome.storage.local.set({ [AUTO_FLAG]: true })
        try {
          await registerAuto()
        } catch (error) {
          await chrome.storage.local.set({ [AUTO_FLAG]: false }).catch(() => {})
          await unregisterAuto().catch(() => {})
          throw error
        }
      } else {
        await disableAutoInternal()
      }
      return !!enabled
    })
  }
  function authorizeAuto(sender, nonce) {
    return serial(async () => {
      if (
        !(await autoEnabled()) ||
        sender.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        sender.frameId !== 0 ||
        typeof sender.documentId !== 'string' ||
        !sender.documentId ||
        (sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
        typeof nonce !== 'string' ||
        !/^[a-zA-Z0-9-]{16,128}$/.test(nonce)
      )
        return false
      let url
      try {
        url = new URL(sender.url)
      } catch {
        return false
      }
      if (!['http:', 'https:'].includes(url.protocol)) return false
      const origins = [`${url.protocol}//${url.hostname}/*`]
      if (!(await chrome.permissions.contains({ origins }))) return false
      // Refuse an authorization queued by a document that was replaced before
      // the service worker processed its message (including same-URL reloads).
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
          func: () => location.origin,
        })
        if (
          result?.[0]?.documentId !== sender.documentId ||
          result[0].result !== url.origin
        )
          return false
      } catch {
        return false
      }
      const sessions = await getAutoSessions()
      const prior = sessions[sender.tab.id]
      if (prior?.documentId === sender.documentId) return prior.nonce === nonce
      if (!prior && Object.keys(sessions).length >= AUTO_MAX_PAGES) {
        const entries =
          (await chrome.storage.session.get(AUTO_DENIALS))[AUTO_DENIALS] || {}
        entries[sender.tab.id] = {
          documentId: sender.documentId,
          reason: 'CAPTURE_LIMIT',
        }
        await chrome.storage.session.set({ [AUTO_DENIALS]: entries })
        return false
      }
      if (prior) {
        await chrome.tabs
          .sendMessage(
            prior.tabId,
            { kind: 'MSE_STOP' },
            { documentId: prior.documentId }
          )
          .catch(() => {})
      }
      const capture = {
        phase: 'active',
        auto: true,
        tabId: sender.tab.id,
        documentId: sender.documentId,
        origin: url.origin,
        nonce,
      }
      const entries =
        (await chrome.storage.session.get(AUTO_DENIALS))[AUTO_DENIALS] || {}
      delete entries[sender.tab.id]
      await chrome.storage.session.set({
        [AUTO_SESSIONS]: { ...sessions, [sender.tab.id]: capture },
        [AUTO_DENIALS]: entries,
      })
      return true
    })
  }
  async function isAuthorizedAuto(sender) {
    const current = await getAutoCapture(sender.tab?.id)
    try {
      return (
        !!current &&
        sender.id === chrome.runtime.id &&
        sender.frameId === 0 &&
        sender.documentId === current.documentId &&
        new URL(sender.url).origin === current.origin &&
        (await chrome.permissions.contains({
          origins: [
            `${new URL(sender.url).protocol}//${
              new URL(sender.url).hostname
            }/*`,
          ],
        }))
      )
    } catch {
      return false
    }
  }
  async function removeAutoCapture(tabId) {
    const sessions = await getAutoSessions()
    if (!sessions[tabId]) return
    delete sessions[tabId]
    await chrome.storage.session.set({ [AUTO_SESSIONS]: sessions })
  }
  async function unregister() {
    const scripts = await chrome.scripting.getRegisteredContentScripts({
      ids: SCRIPT_IDS,
    })
    if (scripts.length)
      await chrome.scripting.unregisterContentScripts({
        ids: scripts.map((script) => script.id),
      })
  }
  async function stopInternal() {
    clearTimeout(expiryTimer)
    const current = await getState()
    const { selection } = await chrome.storage.session.get('selection')
    if (
      selection?.mse &&
      (!current ||
        (selection.tabId === current.tabId &&
          (!current.documentId || selection.documentId === current.documentId)))
    ) {
      await chrome.storage.session.remove('selection')
      await chrome.action.setBadgeText({ text: '' }).catch(() => {})
    }
    await chrome.storage.session.remove(STATE_KEY)
    await unregister()
    if (!current) return
    // Cancellation is best-effort: the document or its permissions may be gone.
    await chrome.tabs
      .sendMessage(current.tabId, { kind: 'MSE_STOP' }, { frameId: 0 })
      .catch(() => {})
    await chrome.scripting
      .executeScript({
        target: { tabId: current.tabId, frameIds: [0] },
        world: 'MAIN',
        func: (key) => sessionStorage.removeItem(key),
        args: [KEY],
      })
      .catch(() => {})
  }
  function stop() {
    return serial(stopInternal)
  }
  function prepare(tabId) {
    return serial(async () => {
      if (await autoEnabled()) throw new Error('自动采集已开启，无需手动开启')
      if (!Number.isInteger(tabId)) throw new Error('找不到当前网页')
      const tab = await chrome.tabs.get(tabId)
      let url
      try {
        url = new URL(tab.url)
      } catch {
        throw new Error('无法在当前页面采集视频')
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('只能在普通网页采集视频')
      const match = `${url.protocol}//${url.hostname}/*`
      if (!(await chrome.permissions.contains({ origins: [match] })))
        throw new Error('请先授权访问当前网页')
      await stopInternal()
      const nonce = crypto.randomUUID()
      const expiresAt = Date.now() + PREPARE_MS
      const capture = {
        tabId,
        origin: url.origin,
        nonce,
        expiresAt,
        phase: 'preparing',
      }
      try {
        await chrome.storage.session.set({ [STATE_KEY]: capture })
        await chrome.scripting.registerContentScripts([
          {
            id: SCRIPT_IDS[0],
            matches: [match],
            js: ['mseCaptureMain.js'],
            runAt: 'document_start',
            world: 'MAIN',
            allFrames: false,
            persistAcrossSessions: false,
          },
          {
            id: SCRIPT_IDS[1],
            matches: [match],
            js: ['mseCaptureBridge.js'],
            runAt: 'document_start',
            world: 'ISOLATED',
            allFrames: false,
            persistAcrossSessions: false,
          },
        ])
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'MAIN',
          func: (key, marker, expectedOrigin) => {
            if (location.origin !== expectedOrigin)
              throw new Error('网页已切换，请重新开启采集')
            sessionStorage.setItem(key, JSON.stringify(marker))
          },
          args: [KEY, { nonce, expiresAt }, url.origin],
        })
        await chrome.tabs.reload(tabId)
        expiryTimer = setTimeout(() => {
          void serial(async () => {
            const current = await getState()
            if (current?.nonce === nonce && current.phase === 'preparing')
              await stopInternal()
          })
        }, PREPARE_MS + 100)
        return capture
      } catch (error) {
        await stopInternal()
        throw error
      }
    })
  }
  function authorize(sender, nonce) {
    return serial(async () => {
      const current = await getState()
      let origin
      try {
        origin = new URL(sender.url).origin
      } catch {
        return false
      }
      if (
        !current ||
        current.phase !== 'preparing' ||
        current.expiresAt < Date.now() ||
        current.nonce !== nonce ||
        sender.id !== chrome.runtime.id ||
        sender.tab?.id !== current.tabId ||
        sender.frameId !== 0 ||
        origin !== current.origin ||
        !sender.documentId
      )
        return false
      clearTimeout(expiryTimer)
      await chrome.storage.session.set({
        [STATE_KEY]: {
          ...current,
          phase: 'active',
          documentId: sender.documentId,
        },
      })
      // The current document retains its scripts; stop installing on other pages.
      await unregister()
      return true
    })
  }
  async function isAuthorized(sender) {
    const current = await getState()
    if (!current || current.phase !== 'active') return false
    try {
      return (
        sender.id === chrome.runtime.id &&
        sender.tab?.id === current.tabId &&
        sender.frameId === 0 &&
        sender.documentId === current.documentId &&
        new URL(sender.url).origin === current.origin
      )
    } catch {
      return false
    }
  }
  function recover() {
    return serial(async () => {
      const current = await getState()
      if (
        !current ||
        (current.phase === 'preparing' && current.expiresAt < Date.now())
      )
        await stopInternal()
      if (await autoEnabled()) {
        if (await chrome.permissions.contains({ origins: AUTO_ORIGINS })) {
          if (current) await stopInternal()
          await registerAuto()
        } else await disableAutoInternal()
      } else {
        try {
          await unregisterAuto()
        } finally {
          await stopAutoSessions()
        }
      }
    })
  }
  function onTabRemoved(tabId) {
    return serial(async () => {
      await removeAutoCapture(tabId)
      await removeAutoDenial(tabId)
      const current = await getState()
      if (current?.tabId === tabId) await stopInternal()
    })
  }
  function onTabUpdated(tabId, changeInfo) {
    return serial(async () => {
      if (changeInfo.status === 'loading' || changeInfo.url)
        await removeAutoDenial(tabId)
      const automatic = (await getAutoSessions())[tabId]
      if (automatic && (changeInfo.url || changeInfo.status === 'complete')) {
        let sameOrigin = true
        try {
          if (changeInfo.url)
            sameOrigin = new URL(changeInfo.url).origin === automatic.origin
        } catch {
          sameOrigin = false
        }
        let alive = false
        if (sameOrigin) {
          try {
            const reply = await chrome.tabs.sendMessage(
              tabId,
              { kind: 'MSE_STATUS' },
              { documentId: automatic.documentId }
            )
            alive = reply?.ok === true
          } catch {}
        }
        if (!alive) await removeAutoCapture(tabId)
      }
      const current = await getState()
      if (current?.tabId !== tabId) return
      let originChanged = false
      if (changeInfo.url) {
        try {
          originChanged = new URL(changeInfo.url).origin !== current.origin
        } catch {
          originChanged = true
        }
      }
      if (originChanged) {
        await stopInternal()
        return
      }
      if (
        current.phase === 'active' &&
        (changeInfo.status === 'loading' ||
          changeInfo.status === 'complete' ||
          changeInfo.url)
      ) {
        // SPA history changes can report both a new URL and "loading" even
        // though the original document is still running. Probe the precise
        // document instead of treating the tab-level event as a navigation.
        let alive = false
        try {
          const reply = await chrome.tabs.sendMessage(
            tabId,
            { kind: 'MSE_STATUS' },
            { documentId: current.documentId }
          )
          alive = reply?.ok === true
        } catch {}
        if (!alive) await stopInternal()
      }
    })
  }
  globalThis.inkloomMseController = {
    prepare,
    authorize,
    isAuthorized,
    getState,
    recover,
    stop,
    onTabRemoved,
    onTabUpdated,
    setAutoEnabled,
    autoEnabled,
    authorizeAuto,
    getAutoCapture,
    getAutoDenial,
    isAuthorizedAuto,
  }
  chrome.permissions.onRemoved?.addListener(() => {
    void serial(async () => {
      if (
        (await autoEnabled()) &&
        !(await chrome.permissions.contains({ origins: AUTO_ORIGINS }))
      ) {
        await disableAutoInternal()
      }
    }).catch(() => {})
  })
})()
