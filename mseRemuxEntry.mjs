import { remuxCapturedVideo } from './mseRemux.mjs'
import { inspectVideoFile } from './videoPreview.mjs'
globalThis.__inkloomMseRemux = { remuxCapturedVideo }
globalThis.__forgeInspectVideo = inspectVideoFile
