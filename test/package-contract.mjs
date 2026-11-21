// Package contract: the client module id must equal the package name.
//
// @deepseek-ai/dsh-client-modules resolves `"<package>/client"` from the bundle's
// exports map, then claims the module by the id the browser artifact registers.
// When the two disagree the whole client half silently never activates: the host
// half keeps working (tools, routes), but the sidebar entry and overlay toasts
// disappear with no error anywhere. This is checked here so a rename cannot do
// that again.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const clientPath = path.join(root, 'lib', 'client.js')
const client = readFileSync(clientPath, 'utf8')

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

check('exports["./client"] points at the client bundle', pkg.exports?.['./client'] === './lib/client.js', pkg.exports?.['./client'])

const idMatch = /window\.__ModuleLoader__\.load\(\{\s*(?:\/\/[^\n]*\n\s*)*id:\s*['"]([^'"]+)['"]/.exec(client)
check('client bundle registers an id', idMatch !== null)
check('client module id equals the package name', idMatch?.[1] === pkg.name, `id=${idMatch?.[1]} package=${pkg.name}`)

const nameMatch = /return \{\s*name:\s*['"]([^'"]+)['"]/.exec(client)
check('exported client name equals the package name', nameMatch?.[1] === pkg.name, `name=${nameMatch?.[1]}`)

check('declares dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))
check('package.json files[] ships lib/', (pkg.files ?? []).includes('lib'))

for (const marker of ['sidebar.footer.action', 'shell.overlay']) {
  const slotFile = marker === 'sidebar.footer.action' ? 'lib/client.js' : 'lib/client.js'
  check(`registers into ${marker}`, readFileSync(path.join(root, slotFile), 'utf8').includes(`'${marker}'`))
}

check('host half entry exists', typeof pkg.main === 'string' && existsSync(path.join(root, pkg.main)))

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall package-contract checks passed')
