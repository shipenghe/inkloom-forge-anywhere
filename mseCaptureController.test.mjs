import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const code = await readFile(
  new URL('./mseCaptureController.js', import.meta.url),
  'utf8'
)

async function fixture({ allowed = true, auto = false } = {}) {
  const state = {},
    local = auto === null ? {} : { autoCaptureEnabled: auto },
    scripts = [],
    calls = [],
    timers = []
  let documentAlive = true
  let permissionRemoved
  let registrationFails = false
  let unregistrationFails = false
  let localWriteFails = false
  let sessionRemoveFails = false
  const chrome = {
    runtime: { id: 'extension-id' },
    action: { setBadgeText: async (value) => calls.push(['badge', value]) },
    permissions: {
      contains: async (p) => {
        calls.push(['permission', p])
        return allowed
      },
      onRemoved: {
        addListener(fn) {
          permissionRemoved = fn
        },
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: local[key] }),
        set: async (obj) => {
          if (localWriteFails) throw new Error('local write failed')
          Object.assign(local, obj)
        },
      },
      session: {
        get: async (key) => ({ [key]: state[key] }),
        set: async (obj) => Object.assign(state, obj),
        remove: async (key) => {
          if (sessionRemoveFails && Array.isArray(key))
            throw new Error('session remove failed')
          for (const name of Array.isArray(key) ? key : [key])
            delete state[name]
        },
      },
    },
    tabs: {
      get: async (id) => ({ id, url: 'https://media.example:8443/watch' }),
      query: async () => [{ id: 77 }],
      reload: async (id) => calls.push(['reload', id]),
      sendMessage: async (...args) => {
        calls.push(['sendMessage', ...args])
        if (args[1]?.kind === 'MSE_STATUS') return { ok: documentAlive }
        return { ok: true }
      },
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids } = {}) =>
        ids
          ? scripts.filter((script) => ids.includes(script.id))
          : scripts.slice(),
      registerContentScripts: async (newScripts) => {
        if (registrationFails) throw new Error('registration failed')
        scripts.push(...newScripts)
        calls.push(['register', newScripts])
      },
      unregisterContentScripts: async ({ ids }) => {
        if (unregistrationFails) throw new Error('unregistration failed')
        for (const id of ids) {
          const i = scripts.findIndex((s) => s.id === id)
          if (i >= 0) scripts.splice(i, 1)
        }
      },
      executeScript: async (arg) => {
        calls.push(['executeScript', arg])
        if (arg.target.documentIds)
          return documentAlive
            ? [
                {
                  documentId: arg.target.documentIds[0],
                  result: 'https://media.example:8443',
                },
              ]
            : []
      },
    },
  }
  const sandbox = {
    chrome,
    URL,
    Date,
    crypto: { randomUUID: () => 'test-nonce' },
    setTimeout: (fn) => {
      timers.push(fn)
      return fn
    },
    clearTimeout: (fn) => {
      const i = timers.indexOf(fn)
      if (i >= 0) timers.splice(i, 1)
    },
  }
  vm.runInNewContext(code, sandbox)
  return {
    api: sandbox.inkloomMseController,
    calls,
    scripts,
    timers,
    state,
    local,
    setDocumentAlive(value) {
      documentAlive = value
    },
    setAllowed(value) {
      allowed = value
    },
    setRegistrationFails(value) {
      registrationFails = value
    },
    setUnregistrationFails(value) {
      unregistrationFails = value
    },
    setLocalWriteFails(value) {
      localWriteFails = value
    },
    setSessionRemoveFails(value) {
      sessionRemoveFails = value
    },
    permissionRemoved() {
      permissionRemoved?.()
    },
  }
}

const sender = {
  id: 'extension-id',
  tab: { id: 7 },
  frameId: 0,
  documentId: 'doc-1',
  url: 'https://media.example:8443/watch',
}

test('prepare registers early scripts only after host permission and refreshes one tab', async () => {
  const { api, calls, scripts } = await fixture()
  const capture = await api.prepare(7)
  assert.equal(capture.phase, 'preparing')
  assert.equal(capture.origin, 'https://media.example:8443')
  assert.equal(calls.at(-1)[0], 'reload')
  assert.equal(calls.at(-1)[1], 7)
  assert.equal(scripts.length, 2)
  assert.deepEqual(
    Array.from(scripts, (s) => [s.world, s.runAt]),
    [
      ['MAIN', 'document_start'],
      ['ISOLATED', 'document_start'],
    ]
  )
  const write = calls.find((x) => x[0] === 'executeScript')[1]
  assert.equal(write.target.tabId, 7)
  assert.equal(write.args[0], '__inkloom_mse_prepare_v1')
  assert.equal(write.args[1].nonce, 'test-nonce')
  assert.equal(write.args[2], capture.origin)
})

test('ungranted origins never register, mark, or refresh', async () => {
  const { api, calls, scripts } = await fixture({ allowed: false })
  await assert.rejects(api.prepare(7), /授权/)
  assert.equal(scripts.length, 0)
  assert.equal(
    calls.some((c) => c[0] === 'reload' || c[0] === 'executeScript'),
    false
  )
})

test('handshake validates tab, frame, exact origin, document, extension and nonce', async () => {
  const { api, scripts } = await fixture()
  await api.prepare(7)
  for (const bad of [
    { ...sender, id: 'not-extension' },
    { ...sender, tab: { id: 8 } },
    { ...sender, frameId: 2 },
    { ...sender, url: 'https://media.example/watch' },
    { ...sender, documentId: undefined },
  ])
    assert.equal(await api.authorize(bad, 'test-nonce'), false)
  assert.equal(await api.authorize(sender, 'wrong'), false)
  assert.equal((await api.getState()).phase, 'preparing')
  assert.equal(await api.authorize(sender, 'test-nonce'), true)
  assert.equal((await api.getState()).documentId, 'doc-1')
  assert.equal(scripts.length, 0)
  assert.equal(await api.isAuthorized(sender), true)
  assert.equal(
    await api.isAuthorized({ ...sender, documentId: 'doc-2' }),
    false
  )
  assert.equal(await api.isAuthorized({ ...sender, tab: { id: 8 } }), false)
})

test('same-document navigation is preserved, while a replaced document is stopped', async () => {
  const { api, calls, setDocumentAlive } = await fixture()
  await api.prepare(7)
  await api.authorize(sender, 'test-nonce')
  await api.onTabUpdated(9, { status: 'loading' })
  assert.equal(await api.isAuthorized(sender), true)
  await api.onTabUpdated(7, {
    status: 'loading',
    url: 'https://media.example:8443/watch?state=1',
  })
  assert.equal(await api.isAuthorized(sender), true)
  assert.equal(
    calls.find((c) => c[1] === 7 && c[2]?.kind === 'MSE_STATUS')[3].documentId,
    'doc-1'
  )
  setDocumentAlive(false)
  await api.onTabUpdated(7, { status: 'complete' })
  assert.equal(await api.isAuthorized(sender), false)
  assert.equal(await api.getState(), null)
  assert.equal(calls.find((c) => c[2]?.kind === 'MSE_STOP')[2].kind, 'MSE_STOP')
})

test('cross-origin URL immediately stops capture without probing the old document', async () => {
  const { api, calls } = await fixture()
  await api.prepare(7)
  await api.authorize(sender, 'test-nonce')
  await api.onTabUpdated(7, { url: 'https://different.example/watch' })
  assert.equal(await api.getState(), null)
  assert.equal(
    calls.some((call) => call[2]?.kind === 'MSE_STATUS'),
    false
  )
})

test('timeout and target removal unregister and clear pending state', async () => {
  const { api, scripts, timers } = await fixture()
  await api.prepare(7)
  timers[0]()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(await api.getState(), null)
  assert.equal(scripts.length, 0)
  await api.prepare(7)
  await api.onTabRemoved(7)
  assert.equal(await api.getState(), null)
  assert.equal(scripts.length, 0)
})

test('startup recovery removes an expired interrupted preparation', async () => {
  const { api, scripts, state } = await fixture()
  await api.prepare(7)
  state.mseCapture.expiresAt = Date.now() - 1
  await api.recover()
  assert.equal(await api.getState(), null)
  assert.equal(scripts.length, 0)
})

test('stop clears only an MSE selection tied to the stopped capture and its badge', async () => {
  const { api, state, calls } = await fixture()
  await api.prepare(7)
  await api.authorize(sender, 'test-nonce')
  state.selection = { mse: true, tabId: 7, documentId: 'doc-1' }
  await api.stop()
  assert.equal(state.selection, undefined)
  assert.equal(calls.filter((call) => call[0] === 'badge').at(-1)[1].text, '')
})

test('stop preserves a normal selection or an unrelated captured document', async () => {
  const { api, state, calls } = await fixture()
  await api.prepare(7)
  await api.authorize(sender, 'test-nonce')
  state.selection = { mse: true, tabId: 7, documentId: 'other-document' }
  await api.stop()
  assert.equal(state.selection.documentId, 'other-document')
  assert.equal(calls.filter((call) => call[0] === 'badge').length, 0)
  const next = await fixture()
  await next.api.prepare(7)
  next.state.selection = { mediaKind: 'image', tabId: 7 }
  await next.api.stop()
  assert.equal(next.state.selection.mediaKind, 'image')
  assert.equal(next.calls.filter((call) => call[0] === 'badge').length, 0)
})

const autoNonce = '0123456789abcdef'
test('auto capture requires consent and registers persistent scripts without reloading', async () => {
  const denied = await fixture({ allowed: false })
  await assert.rejects(denied.api.setAutoEnabled(true), /授权/)
  assert.equal(denied.scripts.length, 0)
  const f = await fixture()
  assert.equal(await f.api.setAutoEnabled(true), true)
  assert.equal(f.local.autoCaptureEnabled, true)
  assert.equal(f.scripts.length, 2)
  assert.equal(f.scripts[0].js[0], 'mseAutoMarker.js')
  assert.equal(f.scripts[0].runAt, 'document_start')
  assert.equal(f.scripts[0].persistAcrossSessions, true)
  assert.equal(
    f.calls.some((c) => c[0] === 'reload'),
    false
  )
  await assert.rejects(f.api.prepare(7), /自动采集已开启/)
  assert.equal(f.scripts.length, 2)
})

test('automatic enable rolls back if registering scripts fails', async () => {
  const f = await fixture()
  f.setRegistrationFails(true)
  await assert.rejects(f.api.setAutoEnabled(true), /registration failed/)
  assert.equal(f.local.autoCaptureEnabled, false)
  assert.equal(f.scripts.length, 0)
})

test('enabling automatic capture twice preserves an already authorized document', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  assert.equal(await f.api.authorizeAuto(sender, autoNonce), true)
  await f.api.setAutoEnabled(true)
  assert.equal(await f.api.isAuthorizedAuto(sender), true)
  assert.equal(f.scripts.length, 2)
})

test('automatic recovery and disable preserve independently owned media entry scripts', async () => {
  const f = await fixture()
  f.scripts.push({ id: 'inkloom-hover-video', js: ['hoverVideo.js'] })
  await f.api.setAutoEnabled(true)
  await f.api.authorizeAuto(sender, autoNonce)
  await f.api.recover()
  assert.equal(
    f.scripts.filter((script) => script.id === 'inkloom-hover-video').length,
    1
  )
  assert.equal(await f.api.isAuthorizedAuto(sender), true)
  await f.api.setAutoEnabled(false)
  assert.deepEqual(
    f.scripts.map((script) => script.id),
    ['inkloom-hover-video']
  )
  assert.equal(
    f.calls.some(
      (call) => call[0] === 'sendMessage' && /^HOVER_/.test(call[2]?.kind)
    ),
    false
  )
})

test('a new document replaces an old same-tab capture and invalidates its authority', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  assert.equal(await f.api.authorizeAuto(sender, autoNonce), true)
  const replacement = { ...sender, documentId: 'doc-2' }
  assert.equal(await f.api.authorizeAuto(replacement, autoNonce), true)
  assert.equal(await f.api.isAuthorizedAuto(sender), false)
  assert.equal(await f.api.isAuthorizedAuto(replacement), true)
  assert.equal((await f.api.getAutoCapture(7)).documentId, 'doc-2')
  assert.ok(
    f.calls.some(
      (c) =>
        c[0] === 'sendMessage' &&
        c[1] === 7 &&
        c[2]?.kind === 'MSE_STOP' &&
        c[3]?.documentId === 'doc-1'
    )
  )
})

test('automatic disable clears sessions even if unregistering scripts fails', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  await f.api.authorizeAuto(sender, autoNonce)
  f.setUnregistrationFails(true)
  await assert.rejects(f.api.setAutoEnabled(false), /unregistration failed/)
  assert.equal(f.local.autoCaptureEnabled, false)
  assert.equal(await f.api.getAutoCapture(7), null)
  assert.ok(
    f.calls.some(
      (c) => c[0] === 'sendMessage' && c[1] === 7 && c[2]?.kind === 'MSE_STOP'
    )
  )
})

for (const failure of ['local', 'session']) {
  test(`automatic disable still stops pages when ${failure} storage fails`, async () => {
    const f = await fixture()
    await f.api.setAutoEnabled(true)
    await f.api.authorizeAuto(sender, autoNonce)
    if (failure === 'local') f.setLocalWriteFails(true)
    else f.setSessionRemoveFails(true)
    await assert.rejects(f.api.setAutoEnabled(false), /failed/)
    assert.equal(f.scripts.length, 0)
    assert.ok(
      f.calls.some(
        (c) => c[0] === 'sendMessage' && c[1] === 7 && c[2]?.kind === 'MSE_STOP'
      )
    )
  })
}

test('auto authorizations isolate documents and enforce a global page limit', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  f.state.mseCapture = { phase: 'active', tabId: 200, documentId: 'manual' }
  for (let id = 1; id <= 4; id++) {
    const s = { ...sender, tab: { id }, documentId: `doc-${id}` }
    assert.equal(await f.api.authorizeAuto(s, autoNonce), true)
    assert.equal((await f.api.getAutoCapture(id)).documentId, `doc-${id}`)
    assert.equal(await f.api.isAuthorizedAuto(s), true)
  }
  assert.equal(f.state.mseCapture.documentId, 'manual')
  assert.equal(
    await f.api.authorizeAuto({ ...sender, tab: { id: 5 } }, autoNonce),
    false
  )
  assert.equal((await f.api.getAutoDenial(5)).reason, 'CAPTURE_LIMIT')
  assert.equal(
    await f.api.isAuthorizedAuto({
      ...sender,
      tab: { id: 1 },
      documentId: 'wrong',
    }),
    false
  )
  await f.api.onTabRemoved(1)
  assert.equal(await f.api.getAutoCapture(1), null)
  assert.equal(
    await f.api.authorizeAuto({ ...sender, tab: { id: 5 } }, autoNonce),
    true
  )
  assert.equal(await f.api.getAutoDenial(5), null)
})

test('auto authorization rejects a replaced document and malformed senders', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  for (const bad of [
    { ...sender, id: 'another' },
    { ...sender, frameId: 2 },
    { ...sender, documentLifecycle: 'cached' },
    { ...sender, documentId: undefined },
    { ...sender, url: 'file:///tmp/video' },
  ])
    assert.equal(await f.api.authorizeAuto(bad, autoNonce), false)
  assert.equal(await f.api.authorizeAuto(sender, 'bad'), false)
  f.setDocumentAlive(false)
  assert.equal(await f.api.authorizeAuto(sender, autoNonce), false)
  assert.equal(await f.api.getAutoCapture(7), null)
})

test('auto capture stops pages on disable and recovers persistent registration', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  await f.api.authorizeAuto(sender, autoNonce)
  f.scripts.splice(0)
  await f.api.recover()
  assert.equal(f.scripts.length, 2)
  assert.equal(await f.api.isAuthorizedAuto(sender), true)
  await f.api.setAutoEnabled(false)
  assert.equal(f.local.autoCaptureEnabled, false)
  assert.equal(f.scripts.length, 0)
  assert.equal(await f.api.getAutoCapture(7), null)
  assert.ok(
    f.calls.some(
      (c) => c[0] === 'sendMessage' && c[1] === 7 && c[2]?.kind === 'MSE_STOP'
    )
  )
  assert.ok(
    f.calls.some(
      (c) => c[0] === 'sendMessage' && c[1] === 77 && c[2]?.kind === 'MSE_STOP'
    ),
    'a page without an authorized player still has its hooks removed'
  )
  assert.equal(
    f.calls.some((c) => c[0] === 'sendMessage' && /^HOVER_/.test(c[2]?.kind)),
    false,
    'disabling capture preserves the independently managed media entry'
  )
})

test('revoking host permissions disables capture and clears sessions', async () => {
  const f = await fixture()
  await f.api.setAutoEnabled(true)
  await f.api.authorizeAuto(sender, autoNonce)
  f.setAllowed(false)
  f.permissionRemoved()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.local.autoCaptureEnabled, false)
  assert.equal(f.scripts.length, 0)
  assert.equal(await f.api.getAutoCapture(7), null)
})

test('new installations prepare automatically while an explicit off preference stays off', async () => {
  const fresh = await fixture({ auto: null })
  assert.equal(await fresh.api.autoEnabled(), true)
  await fresh.api.recover()
  assert.equal(fresh.scripts.length, 2)
  assert.equal(
    fresh.calls.some((call) => call[0] === 'reload'),
    false
  )
  assert.equal(await fresh.api.authorizeAuto(sender, autoNonce), true)
  await fresh.api.setAutoEnabled(false)
  await fresh.api.recover()
  assert.equal(await fresh.api.autoEnabled(), false)
  assert.equal(fresh.scripts.length, 0)
  const denied = await fixture({ auto: null, allowed: false })
  await denied.api.recover()
  assert.equal(denied.scripts.length, 0)
  assert.equal(await denied.api.autoEnabled(), false)
})
