;(() => {
  const repository = 'shipenghe/inkloom-forge-anywhere'
  const latestReleaseUrl = `https://api.github.com/repos/${repository}/releases/latest`
  const releasesUrl = `https://github.com/${repository}/releases`
  const cacheKey = 'forgeReleaseCheck'
  const popupCacheTtl = 5 * 60 * 1000
  let pendingCheck

  async function fetchRelease() {
    const response = await fetch(latestReleaseUrl, {
      credentials: 'omit',
      cache: 'no-cache',
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
    const downloadUrl = `${releasesUrl}/download/${tag}/${fileName}`
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

  async function fetchAndCacheRelease() {
    const release = await fetchRelease().catch(() => null)
    if (!release) return null
    await chrome.storage.local
      .set({ [cacheKey]: { release, checkedAt: Date.now() } })
      .catch(() => {})
    return release
  }

  async function readRelease(recheck) {
    if (!recheck && !pendingCheck) {
      const saved = await chrome.storage.local.get(cacheKey).catch(() => ({}))
      const cached = saved[cacheKey]
      if (
        !pendingCheck &&
        cached?.release &&
        Date.now() - cached.checkedAt < popupCacheTtl
      )
        return cached.release
    }
    pendingCheck ||= fetchAndCacheRelease().finally(() => {
      pendingCheck = undefined
    })
    return pendingCheck
  }

  function isNewer(latestVersion, installedVersion) {
    const installed = installedVersion.split('.').map(Number)
    for (const [index, part] of latestVersion.split('.').entries()) {
      const difference = Number(part) - (installed[index] ?? 0)
      if (difference) return difference > 0
    }
    return false
  }

  globalThis.checkForgeRelease = async (recheck = false) => {
    const release = await readRelease(recheck)
    if (!release) return null
    return {
      ...release,
      releaseUrl: `${releasesUrl}/tag/v${release.version}`,
      available: isNewer(release.version, chrome.runtime.getManifest().version),
    }
  }
})()
