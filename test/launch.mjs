// Unit tests for launch detection and the drawing_setup apply path.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectLaunch, describeLaunch } from '../lib/launch.js'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-launch-'))

// portable layout: main.py + .ext/python.exe
const portable = path.join(tmp, 'ComfyUI')
mkdirSync(path.join(portable, '.ext'), { recursive: true })
writeFileSync(path.join(portable, 'main.py'), 'print("comfy")')
writeFileSync(path.join(portable, '.ext', 'python.exe'), 'fake')

const found = detectLaunch({ comfyRoot: portable, env: {}, includeCommon: false })
check('portable install is found', found.ok === true && found.comfyRoot === portable)
check('interpreter comes from .ext', found.command === path.join(portable, '.ext', 'python.exe'), found.command)
check('main.py is in the args', found.args[0] === 'main.py', found.args.join(' '))
check('describeLaunch names the source', describeLaunch(found).includes('.ext') || describeLaunch(found).includes('comfyRoot'), describeLaunch(found))

// models root parent is used when no comfyRoot is given
const viaModels = detectLaunch({ modelsRoot: path.join(portable, 'models'), env: {}, includeCommon: false })
check('models root parent is used', viaModels.ok === true && viaModels.comfyRoot === portable)

// venv layout
const venvRoot = path.join(tmp, 'venv-install')
mkdirSync(path.join(venvRoot, 'venv', 'Scripts'), { recursive: true })
writeFileSync(path.join(venvRoot, 'main.py'), '')
writeFileSync(path.join(venvRoot, 'venv', 'Scripts', 'python.exe'), 'fake')
const venv = detectLaunch({ comfyRoot: venvRoot, env: {}, includeCommon: false })
check('venv interpreter is found', venv.ok === true && venv.command.includes(path.join('venv', 'Scripts')), venv.command)

// main.py without any interpreter
const noPython = path.join(tmp, 'no-python')
mkdirSync(noPython, { recursive: true })
writeFileSync(path.join(noPython, 'main.py'), '')
const missing = detectLaunch({ comfyRoot: noPython, env: {}, includeCommon: false })
check('missing interpreter is explained', missing.ok === false && String(missing.reason).includes('Python'), missing.reason)

// nothing at all
const empty = mkdtempSync(path.join(tmp, 'empty-'))
const none = detectLaunch({ comfyRoot: empty, env: {}, includeCommon: false })
check('unknown install is reported', none.ok === false && none.comfyRoot === null, none.reason)

// ---------------------------------------------------------------- apply writes the host row
const toolsMod = await import('../lib/tools.js')
const registered = []
const edits = []
const configEditor = {
  entries: () => [
    { id: 'drawing-console', name: 'dsh-drawing-tools' },
    { id: 'dsh-ui-appearance', name: 'dsh-ui-appearance' },
  ],
  edit: async (entry, change) => {
    edits.push({ entry, config: change({ launch: { enabled: false } }, {}) })
  },
}
const ctx = {
  get: (name) => {
    if (name === 'configEditor') return configEditor
    if (name === 'workingDirectory') return { get: () => process.cwd() }
    return undefined
  },
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
}
toolsMod.apply(ctx, { origin: 'http://127.0.0.1:8188' })
const setup = registered.find((definition) => definition.name === 'drawing_setup')
check('drawing_setup is registered', setup !== undefined)
const applied = await setup.execute({ action: 'apply', comfyDir: portable }, {})
check('apply writes the host entry', edits.length === 1 && edits[0].entry.id === 'drawing-console', JSON.stringify(edits.map((edit) => edit.entry)))
check('apply enables launch with the detected interpreter', edits[0]?.config?.launch?.enabled === true && edits[0]?.config?.launch?.command === path.join(portable, '.ext', 'python.exe'))
check('apply keeps cwd', edits[0]?.config?.launch?.cwd === portable)
check('apply text mentions the entry point', applied.text.includes('侧边栏'))

rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL LAUNCH CHECKS PASSED' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
