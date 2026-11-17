import { remuxCapturedVideo } from './mseRemux.mjs'
import { inspectVideoFile } from './videoPreview.mjs'
import { inspectAudioFile } from './audioFile.mjs'
globalThis.__inkloomMseRemux = { remuxCapturedVideo }
globalThis.__forgeInspectVideo = inspectVideoFile
globalThis.__forgeInspectAudio = inspectAudioFile
