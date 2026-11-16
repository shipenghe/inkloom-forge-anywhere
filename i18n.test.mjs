import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
const read = (name) => readFile(new URL(name, import.meta.url), 'utf8')
const [data, source, optionsSource] = await Promise.all([
  read('i18n-data.js'),
  read('i18n.js'),
  read('options.js'),
])
function storage(initial = {}) {
  const values = { ...initial },
    listeners = []
  let fail = false
  return {
    values,
    setFail(value) {
      fail = value
    },
    emit(value) {
      values.languagePreference = value
      for (const fn of listeners)
        fn({ languagePreference: { newValue: value } }, 'local')
    },
    api: {
      local: {
        get: async () => ({ ...values }),
        set: async (next) => {
          if (fail) throw new Error('storage failed')
          Object.assign(values, next)
          for (const fn of listeners)
            fn(
              { languagePreference: { newValue: next.languagePreference } },
              'local'
            )
        },
      },
      onChanged: {
        addListener(fn) {
          listeners.push(fn)
        },
      },
    },
  }
}
function load(locale = 'en-US', saved = storage(), extra = {}) {
  const context = vm.createContext({
    chrome: { i18n: { getUILanguage: () => locale }, storage: saved.api },
    ...extra,
  })
  vm.runInContext(data, context)
  vm.runInContext(source, context)
  return { i18n: context.ForgeI18n, context, saved }
}
test('auto uses Simplified Chinese for Chinese variants and English for other browsers', async () => {
  for (const locale of ['zh-CN', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh_SG', 'zh']) {
    const { i18n } = load(locale)
    await i18n.ready
    assert.equal(i18n.locale(), 'zh_CN')
    assert.equal(i18n.text('发送到画布'), '发送到画布')
  }
  for (const locale of ['en-US', 'en-GB', 'ja', 'fr', 'ar']) {
    const { i18n } = load(locale)
    await i18n.ready
    assert.equal(i18n.locale(), 'en')
    assert.equal(i18n.text('发送到画布'), 'Send to canvas')
  }
})
test('manual selection persists, updates existing contexts and can return to auto', async () => {
  const saved = storage(),
    a = load('zh-TW', saved).i18n,
    b = load('zh-TW', saved).i18n
  await Promise.all([a.ready, b.ready])
  let notices = 0
  b.subscribe(() => notices++)
  await a.setPreference('en')
  assert.equal(b.text('发送到画布'), 'Send to canvas')
  assert.equal(saved.values.languagePreference, 'en')
  const reopened = load('zh-TW', saved).i18n
  await reopened.ready
  assert.equal(reopened.locale(), 'en')
  await a.setPreference('zh_CN')
  assert.equal(b.text('视频尚未准备好'), '视频尚未准备好')
  await a.setPreference('auto')
  assert.equal(b.locale(), 'zh_CN')
  assert.ok(notices >= 3)
})
test('a late initial storage read cannot overwrite a newer preference event', async () => {
  let resolve, onChange
  const saved = {
    api: {
      local: {
        get: () =>
          new Promise((r) => {
            resolve = r
          }),
      },
      onChanged: {
        addListener(fn) {
          onChange = fn
        },
      },
    },
  }
  const { i18n } = load('en-US', saved)
  onChange({ languagePreference: { newValue: 'zh_CN' } }, 'local')
  resolve({ languagePreference: 'en' })
  await i18n.ready
  assert.equal(i18n.locale(), 'zh_CN')
})
test('language does not modify source messages and preserves clip coordinates', async () => {
  const { i18n } = load()
  await i18n.ready
  const original = '未捕获视频片段，请刷新网页后重试'
  assert.equal(i18n.text(original), 'Video not prepared yet. Refresh the page')
  assert.equal(original, '未捕获视频片段，请刷新网页后重试')
  assert.equal(i18n.text('发送完成 · 视频片段'), 'Sent · Video clip')
  assert.equal(
    i18n.text('片段 00:20–00:30 · 无声'),
    'Clip 00:20–00:30 · No audio'
  )
  assert.equal(i18n.text('全片 00:00–01:02:03'), 'Full video 00:00–01:02:03')
  assert.equal(
    i18n.text('视频片段已交给画布（无声）'),
    'Video clip sent to canvas (No audio)'
  )
  assert.equal(
    i18n.text('无法获取媒体（HTTP 403）'),
    'Couldn’t fetch media (HTTP 403)'
  )
})
test('invalid saved settings follow browser; a failed save leaves the active preference unchanged', async () => {
  const saved = storage({ languagePreference: 'invalid' }),
    { i18n } = load('en', saved)
  await i18n.ready
  assert.equal(i18n.locale(), 'en')
  saved.setFail(true)
  await assert.rejects(i18n.setPreference('zh_CN'))
  assert.equal(i18n.locale(), 'en')
  await assert.rejects(i18n.setPreference('fr'))
})
async function openOptions(release = null) {
  const nodes = Object.fromEntries(
    [
      'language',
      'settings',
      'status',
      'installed-version',
      'version-detail',
      'update-link',
    ].map((id) => [
      id,
      {
        value: '',
        textContent: '',
        hidden: true,
        dataset: {},
        events: {},
        setAttribute(name, value) {
          this[name] = value
        },
        addEventListener(event, fn) {
          this.events[event] = fn
        },
      },
    ])
  )
  const document = {
    documentElement: {},
    getElementById: (id) => nodes[id],
    querySelectorAll: () => [],
  }
  const { i18n, context, saved } = load('en', storage(), { document })
  context.chrome.runtime = {
    getManifest: () => ({ version: '1.0.14' }),
    sendMessage: async () => ({ ok: true, release }),
  }
  vm.runInContext(optionsSource, context)
  await i18n.ready
  await new Promise((r) => setImmediate(r))
  return { nodes, saved }
}

test('options save immediately, sync their labels, and retain the last saved value on failure', async () => {
  const { nodes, saved } = await openOptions()
  assert.equal(nodes.settings.hidden, false)
  assert.equal(nodes.language.value, 'auto')
  nodes.language.value = 'zh_CN'
  await nodes.language.events.change()
  assert.equal(nodes.status.textContent, '设置已保存')
  assert.equal(nodes.language.disabled, false)
  saved.setFail(true)
  nodes.language.value = 'en'
  await nodes.language.events.change()
  assert.equal(nodes.language.value, 'zh_CN')
  assert.equal(nodes.status.textContent, '无法保存设置，请重试')
})

test('options show a direct ZIP link only when a newer release is available', async () => {
  const current = await openOptions({ version: '1.0.14', available: false })
  assert.equal(current.nodes['installed-version'].textContent, 'v1.0.14')
  assert.equal(current.nodes['update-link'].hidden, true)
  assert.equal(current.nodes['version-detail'].hidden, true)

  const downloadUrl =
    'https://github.com/shipenghe/inkloom-forge-anywhere/releases/download/v1.0.15/Forge-Anywhere-v1.0.15.zip'
  const { nodes, saved } = await openOptions({
    version: '1.0.15',
    available: true,
    downloadUrl,
  })
  const link = nodes['update-link']
  assert.equal(link.hidden, false)
  assert.equal(link.href, downloadUrl)
  assert.equal(link['aria-label'], 'Download update v1.0.15')
  assert.equal(nodes['version-detail'].textContent, 'Latest release v1.0.15')
  saved.emit('zh_CN')
  assert.equal(nodes['version-detail'].textContent, '最新发布 v1.0.15')

  const failed = await openOptions()
  assert.equal(failed.nodes['update-link'].hidden, true)
  assert.equal(
    failed.nodes['version-detail'].textContent,
    'Couldn’t check for updates'
  )
})
test('packaged catalogs cover the same keys and all declared HTML labels', async () => {
  const [en, zh, tw] = await Promise.all(
    ['en', 'zh_CN', 'zh_TW'].map(async (lang) =>
      JSON.parse(await read(`_locales/${lang}/messages.json`))
    )
  )
  assert.deepEqual(Object.keys(en), Object.keys(zh))
  assert.deepEqual(tw, zh)
  for (const file of ['popup.html', 'options.html']) {
    const html = await read(file)
    for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g))
      assert.ok(en[match[1]]?.message, `${file}: ${match[1]}`)
  }
  for (const [key, value] of Object.entries(en))
    assert.ok(
      !/\p{Script=Han}/u.test(value.message) ||
        ['简体中文', 'Language / 语言'].includes(value.message),
      `Untranslated English label: ${key}`
    )
})
