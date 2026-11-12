;(() => {
  const i18n = globalThis.ForgeI18n
  const select = document.getElementById('language')
  const panel = document.getElementById('settings')
  const status = document.getElementById('status')
  let statusMessage = ''
  function render() {
    i18n.applyDOM()
    select.value = i18n.preference()
    status.textContent = i18n.text(statusMessage)
  }
  i18n.subscribe(render)
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
})()
