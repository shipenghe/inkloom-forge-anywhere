import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const script = readFileSync(
  new URL('./mseCaptureBridge.js', import.meta.url),
  'utf8'
)
function setup({
  allow = true,
  badMetadata = false,
  badTiming = false,
  selectError = null,
  automatic = false,
  hasMedia = true,
} = {}) {
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  })
  vm.runInContext(
    `
    globalThis.window = globalThis
    globalThis.callbacks = new Set()
    window.addEventListener = (type, cb) => { if (type === 'message') callbacks.add(cb) }
    window.removeEventListener = (type, cb) => { if (type === 'message') callbacks.delete(cb) }
    globalThis.crypto = { randomUUID: () => String(Math.random()).repeat(4) }
    globalThis.runtimeCalls = 0
    globalThis.hasMedia = ${hasMedia}
    globalThis.requestKinds = []
    globalThis.lastAuthorization = null
    globalThis.chrome = {runtime:{id:'ext',onMessage:{addListener(fn){globalThis.receive=fn}},sendMessage: async (message) => { lastAuthorization = message; runtimeCalls++; return {ok:${allow}} }}}
    globalThis.announce = () => { hasMedia = true; for (const cb of callbacks) cb({source:window,data:{__inkloomMse:'available'}}) }
    window.postMessage = (data) => queueMicrotask(() => {
      requestKinds.push(data.kind)
      let value
      if (data.kind === 'STATUS') value = {nonce:'1234567890123456', ...(${automatic} ? {auto:true, hasMedia} : {})}
      if (data.kind === 'SELECT') value = {tracks:1}
      if (data.kind === 'SNAPSHOT') value = ${
        badMetadata
          ? "{tracks:[{mime:'video/mp4',parts:[9,9,9],timestampOffset:2,appendWindowStart:0,appendWindowEnd:null}],size:28}"
          : `{tracks:[{mime:'video/mp4',parts:[9,9,9],timestampOffset:2,appendWindowStart:0,appendWindowEnd:${
              badTiming ? '-1' : 'null'
            }}],size:27}`
      }
      if (data.kind === 'READ') value = new Uint8Array(Math.min(data.length,9-data.offset)).fill(7)
      const error = data.kind === 'SELECT' ? ${JSON.stringify(
        selectError
      )} : null
      for (const cb of callbacks) cb({source:window,data:{__inkloomMse:'response',id:data.id,ok:!error,value,error}})
    })
  `,
    Object.assign(context, { queueMicrotask })
  )
  vm.runInContext(script, context)
  const send = (message, id = 'ext') =>
    new Promise((resolve) => context.receive(message, { id }, resolve))
  send.count = () => context.runtimeCalls
  send.announce = () => context.announce()
  send.requests = () => Array.from(context.requestKinds)
  send.authorization = () => context.lastAuthorization
  return send
}

test('requires background authorization before selecting or reading', async () => {
  const send = setup()
  assert.equal((await send({ kind: 'MSE_SELECT', url: 'blob:one' })).ok, false)
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, true)
  assert.equal((await send({ kind: 'MSE_SELECT', url: 'blob:one' })).ok, true)
  assert.equal(
    (await send({ kind: 'MSE_READ', track: 0, part: 0, offset: 0, length: 1 }))
      .ok,
    false
  )
  const snapshot = await send({ kind: 'MSE_SNAPSHOT' })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.value.tracks[0].timestampOffset, 2)
  assert.equal(snapshot.value.tracks[0].appendWindowEnd, null)
  assert.equal(
    (await send({ kind: 'MSE_READ', track: 0, part: 2, offset: 1, length: 2 }))
      .value,
    'Bwc='
  )
  assert.equal(
    (
      await send({
        kind: 'MSE_READ',
        track: 0,
        part: 2,
        offset: 1,
        length: 192 * 1024 + 1,
      })
    ).ok,
    false
  )
  assert.equal((await send({ kind: 'MSE_STOP' })).ok, true)
  assert.equal((await send({ kind: 'MSE_SNAPSHOT' })).ok, false)
  const invalidTiming = setup({ badTiming: true })
  assert.equal((await invalidTiming({ kind: 'MSE_STATUS' })).ok, true)
  assert.equal(
    (await invalidTiming({ kind: 'MSE_SELECT', url: 'blob:one' })).ok,
    true
  )
  assert.equal((await invalidTiming({ kind: 'MSE_SNAPSHOT' })).ok, false)
})

test('rejects wrong sender, denied authorization and forged metadata', async () => {
  assert.equal((await setup()({ kind: 'MSE_STATUS' }, 'different')).ok, false)
  assert.equal(
    (await setup({ allow: false })({ kind: 'MSE_STATUS' })).ok,
    false
  )
  const send = setup({ badMetadata: true })
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, true)
  assert.equal((await send({ kind: 'MSE_SELECT', url: 'blob:one' })).ok, true)
  assert.equal((await send({ kind: 'MSE_SNAPSHOT' })).ok, false)
})

test('automatic and repeated status requests share one authorization', async () => {
  const send = setup()
  const results = await Promise.all([
    send({ kind: 'MSE_STATUS' }),
    send({ kind: 'MSE_STATUS' }),
  ])
  assert.equal(
    results.every((result) => result.ok),
    true
  )
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, true)
  assert.equal(send.count(), 1)
})

test('automatic mode waits for a media source before asking for a capture slot', async () => {
  const send = setup({ automatic: true, hasMedia: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(send.count(), 0)
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, false)
  send.announce()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(send.count(), 1)
  assert.equal(send.authorization().auto, true)
  assert.equal((await send({ kind: 'MSE_STATUS' })).value.auto, true)
  assert.equal((await send({ kind: 'MSE_RELEASE' })).ok, true)
  assert.ok(send.requests().includes('RELEASE'))
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, true)
})

test('automatic authorization denial stops the capture in the page', async () => {
  const send = setup({ automatic: true, hasMedia: true, allow: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(send.requests().includes('STOP'))
  assert.equal((await send({ kind: 'MSE_STATUS' })).ok, false)
})

test('preserves actionable player association and initialization errors', async () => {
  for (const error of [
    '无法关联该视频的播放器，可能使用不支持的播放方式',
    '播放器尚未加载媒体轨道，请先播放视频后重试',
  ]) {
    const send = setup({ selectError: error })
    await send({ kind: 'MSE_STATUS' })
    const result = await send({ kind: 'MSE_SELECT', url: 'blob:one' })
    assert.equal(result.ok, false)
    assert.equal(result.error, error)
  }
})
