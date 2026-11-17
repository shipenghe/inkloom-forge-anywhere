// Store the last delivered video in the extension's own origin so the popup
// can play that file without contacting the page or the media server.
;(() => {
  const key = 'latest'
  let opening

  function open() {
    opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('forge-video-playback', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('videos')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch((error) => {
      opening = undefined
      throw error
    })
    return opening
  }

  async function transact(mode, operation) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('videos', mode)
      const request = operation(transaction.objectStore('videos'))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  globalThis.ForgeVideoPlayback = {
    async replace(id, file) {
      await transact('readwrite', (store) =>
        file ? store.put({ id, file }, key) : store.delete(key)
      )
    },
    async read(id) {
      const value = await transact('readonly', (store) => store.get(key))
      return value?.id === id ? value.file : null
    },
  }
})()
