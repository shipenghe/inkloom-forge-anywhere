import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { zipSync } from 'fflate'
const root = new URL('../', import.meta.url)
const manifest = JSON.parse(
  await readFile(new URL('manifest.json', root), 'utf8')
)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
if (manifest.version !== pkg.version)
  throw new Error('Package and manifest versions differ')
const files = {}
async function addTree(directory) {
  for (const item of await readdir(new URL(directory, root), {
    withFileTypes: true,
  })) {
    const relative = `${directory}${item.name}`
    if (item.isDirectory()) await addTree(`${relative}/`)
    else
      files[`Forge-Anywhere/${relative}`] = new Uint8Array(
        await readFile(new URL(relative, root))
      )
  }
}
// Runtime files only; source tests, development dependencies and fixtures stay out.
for (const item of await readdir(root, { withFileTypes: true })) {
  if (
    item.isFile() &&
    (item.name.endsWith('.js') ||
      item.name.endsWith('.html') ||
      item.name.endsWith('.css') ||
      [
        'manifest.json',
        'README.md',
        'README.en.md',
        'mseRemux.LICENSE.txt',
        'mseRemux.NOTICE.md',
      ].includes(item.name))
  ) {
    files[`Forge-Anywhere/${item.name}`] = new Uint8Array(
      await readFile(new URL(item.name, root))
    )
  }
}
await addTree('icons/')
await addTree('_locales/')
for (const file of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
]) {
  if (!files[`Forge-Anywhere/${file}`])
    throw new Error(`Missing runtime file: ${file}`)
}
const destination = new URL(
  `dist/Forge-Anywhere-v${manifest.version}.zip`,
  root
)
await mkdir(new URL('dist/', root), { recursive: true })
await writeFile(destination, zipSync(files, { level: 9 }))
console.log(`${destination.pathname} (${Object.keys(files).length} files)`)
