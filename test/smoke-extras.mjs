// Extra functional coverage: batch, img2img init upload, queue, history,
// listWorkflows + runWorkflow with an API-format fixture.
// Run: node test/smoke-extras.mjs
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWorkflow,
  generate,
  history,
  listWorkflows,
  queue,
  runWorkflow,
  status,
  DEFAULT_OUTPUT_DIR,
} from '../lib/comfy-client.js'

const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
const here = path.dirname(fileURLToPath(import.meta.url))
const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const state = await status(origin)
check('status online', state.online === true, `v${state.version}, queue ${state.queueRunning}/${state.queuePending}`)

// --- queue ---
const q = await queue(origin, 'status')
check('queue status', q.action === 'status' && Number.isInteger(q.runningCount), `running=${q.runningCount} pending=${q.pendingCount}`)
const cleared = await queue(origin, 'clear')
check('queue clear', cleared.ok === true)

// --- batch=2 ---
const batch = await generate(origin, {
  prompt: 'a lighthouse on a rocky coast at sunset, dramatic clouds, wide shot',
  family: 'classic',
  width: 512,
  height: 512,
  steps: 12,
  seed: 42,
  batch: 2,
})
check('batch=2 returns 2 images', batch.images.length === 2, batch.images.map(image => path.basename(image.path)).join(', '))
for (const image of batch.images) {
  const bytes = await readFile(image.path)
  check(`batch image exists+png ${path.basename(image.path)}`, bytes.length > 10_000 && bytes[0] === 0x89 && bytes[1] === 0x50)
}
check('batch output dir is under default root', path.dirname(batch.images[0].path).startsWith(DEFAULT_OUTPUT_DIR))

// --- img2img (upload + VAEEncode + denoise) ---
const init = batch.images[0].path
const img2img = await generate(origin, {
  prompt: 'the same lighthouse at night, starry sky, glowing beam',
  family: 'classic',
  width: 512,
  height: 512,
  steps: 12,
  seed: 7,
  initImage: init,
  denoise: 0.5,
})
check('img2img returns 1 image', img2img.images.length === 1, path.basename(img2img.images[0]?.path ?? 'none'))
check('img2img denoise recorded', img2img.params.denoise === 0.5)

// --- history ---
const records = await history(origin, 10)
check('history returns records', records.length > 0, `${records.length} records`)
const own = records.find(record => record.promptId === img2img.promptId)
check('history contains latest prompt', Boolean(own))
check('history resolves local path', Boolean(own?.images?.[0]?.path && existsSync(own.images[0].path)), own?.images?.[0]?.path ?? 'missing')
check('history family/model from sidecar', own?.family === 'classic' && typeof own?.model === 'string', `${own?.family}/${own?.model}`)

// --- saved workflows ---
const fixtureDir = path.join(here, 'fixtures')
await mkdir(fixtureDir, { recursive: true })
const resolved = {
  prompt: 'a tiny paper boat on a puddle, macro photo, morning light',
  negative: 'lowres, worst quality',
  family: 'classic',
  model: 'sd15-dreamshaper-8.safetensors',
  width: 512,
  height: 512,
  steps: 10,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'normal',
  seed: 2026,
  batch: 1,
  denoise: 1,
  stamp: 'workflow-test',
}
const built = buildWorkflow('classic', resolved)
const fixturePath = path.join(fixtureDir, 'api-sd15-txt2img.json')
await writeFile(fixturePath, `${JSON.stringify(built.graph, null, 2)}\n`, 'utf8')
const emptyList = await listWorkflows({ workflowsDir: path.join(here, 'no-such-dir') })
check('listWorkflows missing dir -> []', Array.isArray(emptyList) && emptyList.length === 0)
const listed = await listWorkflows({ workflowsDir: fixtureDir })
check('listWorkflows api format', listed.length === 1 && listed[0].format === 'api' && listed[0].nodeCount === 7, JSON.stringify(listed[0]))
const ran = await runWorkflow(origin, fixturePath, { timeoutMs: 300_000 })
check('runWorkflow produces png', ran.images.length === 1 && existsSync(ran.images[0].path), ran.images[0]?.path)
let rejectedUi = false
try {
  await runWorkflow(origin, { nodes: [{ type: 'KSampler' }] })
} catch (error) {
  rejectedUi = /UI 格式/.test(error.message)
}
check('runWorkflow rejects UI format', rejectedUi)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ALL EXTRA CHECKS PASSED')
