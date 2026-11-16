;(() => {
  const repository = 'shipenghe/inkloom-forge-anywhere'
  const latestReleaseUrl = `https://api.github.com/repos/${repository}/releases/latest`
  const cacheKey = 'forgeReleaseCheck'
  const successTtl = 4 * 60 * 60 * 1000
  let pendingCheck

  async function fetchRelease() {
    const response = await fetch(latestReleaseUrl, {
      credentials: 'omit',
    })
    if (!response.ok) return null
    const { tag_name: tag, draft, prerelease, assets } = await response.json()
    if (
      draft ||
      prerelease ||
      typeof tag !== 'string' ||
      !/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(tag)
    )
      return null

    const fileName = `Forge-Anywhere-${tag}.zip`
    const downloadUrl = `https://github.com/${repository}/releases/download/${tag}/${fileName}`
    if (
      !Array.isArray(assets) ||
      !assets.some(
        (asset) =>
          asset.name === fileName &&
          asset.state === 'uploaded' &&
          asset.browser_download_url === downloadUrl
      )
    )
      return null
    return { version: tag.slice(1), downloadUrl }
  }

  async function cachedRelease() {
    const saved = await chrome.storage.local.get(cacheKey).catch(() => ({}))
    const cached = saved[cacheKey]
    if (cached?.release && cached.expiresAt > Date.now()) return cached.release

    const release = await fetchRelease().catch(() => null)
    if (!release) return null
    const expiresAt = Date.now() + successTtl
    await chrome.storage.local
      .set({ [cacheKey]: { release, expiresAt } })
      .catch(() => {})
    return release
  }

  function isNewer(latestVersion, installedVersion) {
    const installed = installedVersion.split('.').map(Number)
    for (const [index, part] of latestVersion.split('.').entries()) {
      const difference = Number(part) - (installed[index] ?? 0)
      if (difference) return difference > 0
    }
    return false
  }

  globalThis.checkForgeRelease = async () => {
    pendingCheck ||= cachedRelease().finally(() => {
      pendingCheck = undefined
    })
    const release = await pendingCheck
    if (!release) return null
    return {
      ...release,
      available: isNewer(release.version, chrome.runtime.getManifest().version),
    }
  }
})()
