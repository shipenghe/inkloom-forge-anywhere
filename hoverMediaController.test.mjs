import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const code = await readFile(
  new URL('./hoverMediaController.js', import.meta.url),
  'utf8'
)
function fixture({ origins = [], tabs = [] } = {}) {
  const scripts = []
  const calls = []
  const documents = new Map(tabs.map((tab) => [tab.id, `doc-${tab.id}`]))
  const installed = new Set()
  const activeTabs = new Set()
  let unregisterFails = false
  let removed
  let added
  function granted(raw) {
    let url
    try {
      url = new URL(raw)
    } catch {
      return false
    }
    return origins.some((pattern) => {
      if (pattern === '<all_urls>')
        return ['http:', 'https:'].includes(url.protocol)
      const match = pattern.match(/^(https?|\*):\/\/([^/]+)\//)
      if (!match || (match[1] !== '*' && `${match[1]}:` !== url.protocol))
        return false
      return (
        match[2] === '*' ||
        match[2] === url.hostname ||
        (match[2].startsWith('*.') &&
          (url.hostname === match[2].slice(2) ||
            url.hostname.endsWith(match[2].slice(1))))
      )
    })
  }
  const chrome = {
    permissions: {
      getAll: async () => ({ origins: origins.slice() }),
      contains: async ({ origins: patterns }) => patterns.every(granted),
      request: async () =>
        assert.fail('media entry must not request permissions'),
      onAdded: {
        addListener: (fn) => {
          added = fn
        },
      },
      onRemoved: {
        addListener: (fn) => {
          removed = fn
        },
      },
    },
    tabs: {
      get: async (id) => tabs.find((tab) => tab.id === id),
      query: async () => tabs.slice(),
      reload: async () => assert.fail('media entry must not reload pages'),
      sendMessage: async (...args) => {
        calls.push(['sendMessage', ...args])
        return { ok: true }
      },
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) =>
        scripts.filter((script) => ids.includes(script.id)),
      unregisterContentScripts: async ({ ids }) => {
        calls.push(['unregister', ids])
        if (unregisterFails) throw new Error('unregister failed')
        for (const id of ids) {
          const i = scripts.findIndex((script) => script.id === id)
          if (i >= 0) scripts.splice(i, 1)
        }
      },
      registerContentScripts: async (values) => {
        scripts.push(...values)
        calls.push(['register', values])
      },
      executeScript: async (value) => {
        calls.push(['execute', value])
        const id = value.target.tabId
        const tab = tabs.find((tab) => tab.id === id)
        if (!granted(tab?.url) && !activeTabs.has(id))
          throw new Error('no grant')
        if (value.func)
          return [
            {
              frameId: 0,
              documentId: documents.get(id),
              result: installed.has(documents.get(id)),
            },
          ]
        assert.equal(
          value.target.documentIds[0],
          documents.get(id),
          'inject the probed document'
        )
        installed.add(documents.get(id))
        return [{ frameId: 0, documentId: documents.get(id) }]
      },
    },
  }
  const sandbox = { chrome, URL }
  vm.runInNewContext(code, sandbox)
  return {
    api: sandbox.forgeMediaEntryController,
    scripts,
    calls,
    installed,
    documents,
    activeTabs,
    added: () => added(),
    removed: () => removed(),
    setOrigins: (next) => {
      origins = next
    },
    failUnregister: () => {
      unregisterFails = true
    },
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const filesInjected = (f) =>
  f.calls.filter((call) => call[0] === 'execute' && call[1].files)

test('without persistent grants recovery registers nothing and never touches web pages', async () => {
  const f = fixture({ tabs: [{ id: 1, url: 'https://example.com/' }] })
  await f.api.recover()
  assert.equal(f.scripts.length, 0)
  assert.equal(filesInjected(f).length, 0)
  assert.equal(
    f.calls.some((call) => call[0] === 'execute'),
    false
  )
})

test('registration only uses granted web origins and injects existing allowed pages independently of MSE', async () => {
  const f = fixture({
    origins: ['https://media.example/*', 'file:///*'],
    tabs: [
      { id: 1, url: 'https://media.example/watch' },
      { id: 2, url: 'https://other.example/' },
      { id: 3, url: 'chrome://extensions' },
    ],
  })
  await f.api.recover()
  assert.equal(f.scripts.length, 1)
  assert.deepEqual(plain(f.scripts[0].matches), ['https://media.example/*'])
  assert.deepEqual(plain(f.scripts[0].js), [
    'i18n-data.js',
    'i18n.js',
    'mediaFallback.js',
    'videoCandidates.js',
    'hoverVideo.js',
  ])
  assert.equal(f.scripts[0].world, 'ISOLATED')
  assert.equal(f.scripts[0].runAt, 'document_idle')
  assert.equal(f.scripts[0].allFrames, false)
  assert.equal(f.scripts[0].persistAcrossSessions, true)
  assert.equal(filesInjected(f).length, 1)
  assert.equal(filesInjected(f)[0][1].target.tabId, 1)
  await f.api.recover()
  assert.equal(f.scripts.length, 1)
  assert.equal(
    filesInjected(f).length,
    1,
    'an existing entry is not replaced on recovery'
  )
})

test('all_urls and wildcard schemes stay restricted to normal web pages', async () => {
  const f = fixture({
    origins: ['<all_urls>', '*://*.example.com/*'],
    tabs: [
      { id: 1, url: 'https://a.example.com/' },
      { id: 2, url: 'file:///test' },
    ],
  })
  await f.api.recover()
  assert.deepEqual(
    plain(f.scripts[0].matches),
    [
      'http://*/*',
      'http://*.example.com/*',
      'https://*/*',
      'https://*.example.com/*',
    ].sort()
  )
  assert.equal(filesInjected(f).length, 1)
})

test('explicit activeTab injection works without persisting or requesting new grants', async () => {
  const f = fixture({
    tabs: [
      { id: 1, url: 'https://active.example/' },
      { id: 2, url: 'chrome://extensions' },
    ],
  })
  f.activeTabs.add(1)
  assert.deepEqual(
    await Promise.all([f.api.injectTab(1), f.api.injectTab(1)]),
    [true, true]
  )
  assert.equal(filesInjected(f).length, 1)
  assert.equal(f.scripts.length, 0)
  assert.equal(await f.api.injectTab(2), false)
  assert.equal(await f.api.injectTab(99), false)
  assert.equal(filesInjected(f).length, 1)
})

test('SPA changes and completed same-document events preserve the visible media entry', async () => {
  const f = fixture({
    origins: ['https://media.example/*'],
    tabs: [{ id: 1, url: 'https://media.example/watch' }],
  })
  await f.api.injectTab(1)
  await f.api.onTabUpdated(1, { url: 'https://media.example/next' })
  assert.equal(filesInjected(f).length, 1)
  await f.api.onTabUpdated(1, { status: 'complete' })
  assert.equal(filesInjected(f).length, 1)
  f.documents.set(1, 'doc-reloaded')
  await f.api.onTabUpdated(1, { status: 'complete' })
  assert.equal(filesInjected(f).length, 2)
  assert.deepEqual(plain(filesInjected(f)[1][1].target.documentIds), [
    'doc-reloaded',
  ])
})

test('upgrades the old video-only entry without changing MSE or unrelated registrations', async () => {
  const f = fixture({ origins: ['https://media.example/*'] })
  f.scripts.push(
    {
      id: 'inkloom-hover-video',
      matches: ['http://*/*', 'https://*/*'],
      js: ['videoCandidates.js', 'hoverVideo.js'],
    },
    { id: 'inkloom-mse-auto-main' },
    { id: 'unrelated' }
  )
  await f.api.recover()
  assert.equal(
    f.scripts.filter((script) => script.id === 'inkloom-hover-video').length,
    1
  )
  assert.equal(
    f.scripts.filter((script) => script.id === 'inkloom-mse-auto-main').length,
    1
  )
  assert.equal(
    f.scripts.filter((script) => script.id === 'unrelated').length,
    1
  )
  assert.deepEqual(plain(f.calls.find((call) => call[0] === 'unregister')[1]), [
    'inkloom-hover-video',
  ])
})

test('permission changes update matches and remove entries from revoked or now-hidden tabs', async () => {
  const f = fixture({
    origins: ['https://one.example/*', 'https://two.example/*'],
    tabs: [
      { id: 1, url: 'https://one.example/' },
      { id: 2, url: 'https://two.example/' },
      { id: 3 },
    ],
  })
  await f.api.recover()
  f.setOrigins(['https://two.example/*'])
  f.removed()
  await f.api.recover()
  assert.deepEqual(plain(f.scripts[0].matches), ['https://two.example/*'])
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === 'sendMessage' &&
        call[1] === 1 &&
        call[2].kind === 'HOVER_MEDIA_STOP'
    )
  )
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === 'sendMessage' &&
        call[1] === 3 &&
        call[2].kind === 'HOVER_MEDIA_STOP'
    )
  )
  assert.equal(
    f.calls.some((call) => call[0] === 'sendMessage' && call[1] === 2),
    false
  )
  f.setOrigins(['https://one.example/*', 'https://two.example/*'])
  f.added()
  await f.api.recover()
  assert.deepEqual(plain(f.scripts[0].matches), [
    'https://one.example/*',
    'https://two.example/*',
  ])
})

test('revocation still stops loaded controls if registration cleanup fails', async () => {
  const f = fixture({
    origins: ['https://media.example/*'],
    tabs: [{ id: 1, url: 'https://media.example/' }],
  })
  await f.api.recover()
  f.setOrigins([])
  f.failUnregister()
  f.removed()
  await assert.rejects(f.api.recover(), /unregister failed/)
  assert.ok(
    f.calls.some(
      (call) =>
        call[0] === 'sendMessage' &&
        call[1] === 1 &&
        call[2].kind === 'HOVER_MEDIA_STOP'
    )
  )
})
