// Optional regeneration only: the committed sample avoids an FFmpeg test dependency.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const executable = process.argv[2] || process.env.FFMPEG_BIN || 'ffmpeg'
const output = fileURLToPath(
  new URL('../fixtures/remux-sample.mp4', import.meta.url)
)
const args = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=64x48:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '15',
  '-c:v',
  'libx264',
  '-profile:v',
  'baseline',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '300',
  '-keyint_min',
  '300',
  '-sc_threshold',
  '0',
  '-bf',
  '0',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
  '-movflags',
  '+faststart',
  '-map_metadata',
  '-1',
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
  '-y',
  output,
]
const result = spawnSync(executable, args, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
console.log(output)
