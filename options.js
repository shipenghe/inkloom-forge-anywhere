;(() => {
  const i18n = globalThis.ForgeI18n
  const select = document.getElementById('language')
  const panel = document.getElementById('settings')
  const status = document.getElementById('status')
  const version = document.getElementById('installed-version')
  const versionDetail = document.getElementById('version-detail')
  const updateLink = document.getElementById('update-link')
  const latestBadge = document.getElementById('latest-badge')
  let statusMessage = ''
  let release
  const installedVersion = chrome.runtime.getManifest().version
  version.textContent = `v${installedVersion}`

  function renderVersion() {
    const latest = release ? `v${release.version}` : ''
    const latestLabel = latest
      ? `${i18n.message('latestRelease')} ${latest}`
      : ''
    version.title = latestLabel
    versionDetail.textContent =
      release === null
        ? i18n.message('updateCheckUnavailable')
        : release?.version !== installedVersion
        ? latestLabel
        : ''
    versionDetail.hidden = !versionDetail.textContent
    latestBadge.hidden = release?.version !== installedVersion
    updateLink.hidden = !release?.available
    if (release?.available) {
      updateLink.href = release.downloadUrl
      updateLink.title = `${i18n.message('downloadUpdate')} ${latest}`
      updateLink.setAttribute('aria-label', updateLink.title)
    }
  }

  function render() {
    i18n.applyDOM()
    select.value = i18n.preference()
    status.textContent = i18n.text(statusMessage)
    renderVersion()
  }
  i18n.subscribe(render)
  updateLink.addEventListener('click', () => {
    if (release?.available && release.releaseUrl)
      void chrome.tabs.create({ url: release.releaseUrl }).catch(() => {})
  })
  select.addEventListener('change', async () => {
    select.disabled = true
    statusMessage = ''
    status.textContent = ''
    try {
      await i18n.setPreference(select.value)
      statusMessage = '设置已保存'
      status.dataset.kind = 'success'
    } catch {
      statusMessage = '无法保存设置，请重试'
      status.dataset.kind = 'error'
    } finally {
      render()
      select.disabled = false
    }
  })
  void i18n.ready.then(() => {
    render()
    select.disabled = false
    panel.hidden = false
    panel.setAttribute('aria-busy', 'false')
  })
  void chrome.runtime
    .sendMessage({ kind: 'CHECK_EXTENSION_UPDATE' })
    .then(
      (result) => {
        release = result?.ok ? result.release : null
      },
      () => {
        release = null
      }
    )
    .then(() => i18n.ready)
    .then(renderVersion)
})()
