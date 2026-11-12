// Rebuild the checked-in extension bundle with the repository's pinned mediabunny.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const dir = fileURLToPath(new URL('.', import.meta.url))
await build({
  entryPoints: [dir + 'mseRemuxEntry.mjs'],
  outfile: dir + 'mseRemux.bundle.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'none',
  banner: {
    js: '/*! Includes mediabunny 1.29.1 (MPL-2.0); see mseRemux.LICENSE.txt. */',
  },
})
