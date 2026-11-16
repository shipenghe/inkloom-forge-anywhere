import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('./releaseUpdates.js', import.meta.url),
  'utf8'
)
const repository = 'shipenghe/inkloom-forge-anywhere'
const minute = 60 * 1000

function release(version) {
  const tag = `v${version}`
  const name = `Forge-Anywhere-${tag}.zip`
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        name,
        state: 'uploaded',
        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      },
    ],
  }
}

function fixture(version, remote, storage = {}) {
  const requests = []
  let now = 0
  let installed = version
  const chrome = {
    runtime: { getManifest: () => ({ version: installed }) },
    storage: {
      local: {
        get: async () => storage,
        set: async (data) => Object.assign(storage, data),
      },
    },
  }
  function startWorker() {
    const context = vm.createContext({
      chrome,
      Date: { now: () => now },
      async fetch(url, options) {
        requests.push({ url, options })
        if (remote instanceof Error) throw remote
        return { ok: true, json: async () => remote }
      },
    })
    vm.runInContext(source, context)
    return context.checkForgeRelease
  }
  return {
    check: startWorker(),
    startWorker,
    requests,
    advance: (milliseconds) => {
      now += milliseconds
    },
    publish: (value) => {
      remote = value
    },
    install: (value) => {
      installed = value
    },
  }
}

test('concurrent surfaces share the check and the cache survives worker restart and extension update', async () => {
  const remote = release('1.0.14')
  const f = fixture('1.0.9', remote)
  const [popup, options] = await Promise.all([f.check(), f.check(true)])
  for (const result of [popup, options]) {
    assert.equal(result.available, true)
    assert.equal(result.version, '1.0.14')
    assert.equal(result.downloadUrl, remote.assets[0].browser_download_url)
    assert.equal(
      result.releaseUrl,
      `https://github.com/${repository}/releases/tag/v1.0.14`
    )
  }
  assert.equal(f.requests.length, 1)
  assert.equal(
    f.requests[0].url,
    `https://api.github.com/repos/${repository}/releases/latest`
  )
  assert.equal(f.requests[0].options.credentials, 'omit')
  assert.equal(f.requests[0].options.cache, 'no-cache')
  assert.equal(f.requests[0].options.signal, undefined)

  f.advance(minute)
  f.install('1.0.14')
  const reopened = f.startWorker()
  assert.equal((await reopened()).available, false)
  assert.equal((await reopened()).releaseUrl, popup.releaseUrl)
  assert.equal(f.requests.length, 1)
  f.install('1.0.15')
  assert.equal((await reopened()).available, false)

  f.advance(4 * minute)
  f.publish(release('1.1.0'))
  assert.equal((await reopened()).available, true)
  assert.equal(f.requests.length, 2)
})

test('opening settings rechecks a cached Latest result and refreshes the popup cache', async () => {
  const f = fixture('1.0.16', release('1.0.16'))
  assert.equal((await f.check()).available, false)

  f.publish(release('1.0.17'))
  assert.equal((await f.check()).version, '1.0.16')
  assert.equal(f.requests.length, 1)
  const [settings, popup] = await Promise.all([f.check(true), f.check()])
  assert.equal(settings.version, '1.0.17')
  assert.equal(settings.available, true)
  assert.equal(popup.version, '1.0.17')
  assert.equal((await f.check()).version, '1.0.17')
  assert.equal(f.requests.length, 2)
})

test('drafts, prereleases, and untrusted or missing ZIPs do not trigger updates', async () => {
  const candidate = release('1.0.15')
  for (const remote of [
    { ...candidate, draft: true },
    { ...candidate, prerelease: true },
    { ...candidate, tag_name: 'v1.0.15-beta' },
    { ...candidate, assets: [] },
    { ...candidate, assets: [{ ...candidate.assets[0], state: 'new' }] },
    {
      ...candidate,
      assets: [
        {
          ...candidate.assets[0],
          browser_download_url: 'https://example.com/update.zip',
        },
      ],
    },
  ]) {
    const f = fixture('1.0.14', remote)
    assert.equal(await f.check(), null)
  }
})

test('older cache entries do not block a fresh check after upgrading', async () => {
  const oldCache = {
    forgeReleaseCheck: {
      release: { version: '1.0.14', downloadUrl: '' },
      expiresAt: 240 * minute,
    },
  }
  const f = fixture('1.0.14', new Error('offline'), oldCache)
  assert.equal(await f.check(), null)
  assert.equal(f.requests.length, 1)
  f.publish(release('1.0.15'))
  assert.equal((await f.check()).available, true)
  assert.equal(f.requests.length, 2)
})
