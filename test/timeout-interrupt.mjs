// Timeout + interrupt coverage: start a slow Krea-2 job with a 5s wait budget,
// confirm generate() returns { timedOut: true, promptId }, then interrupt it and
// verify ComfyUI recovers and a normal generation still works.
// Run: node test/timeout-interrupt.mjs
import { generate, queue, status } from '../lib/comfy-client.js'

const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const timedOut = await generate(origin, {
  prompt: 'a detailed map of an imaginary island, ink drawing, high detail',
  family: 'krea2',
  width: 512,
  height: 512,
  steps: 8,
  seed: 5,
  timeoutMs: 5000,
})
check('slow job times out', timedOut.timedOut === true, `promptId=${timedOut.promptId}`)
check('timeout returns promptId', typeof timedOut.promptId === 'string' && timedOut.promptId.length > 0)
check('timeout returns no local images', Array.isArray(timedOut.images) && timedOut.images.length === 0)
check('timeout keeps resolved params', timedOut.family === 'krea2' && timedOut.params.steps === 8)

const interrupted = await queue(origin, 'interrupt')
check('interrupt accepted', interrupted.ok === true, interrupted.message)

let state = await status(origin)
const deadline = Date.now() + 120_000
while ((state.queueRunning > 0 || state.queuePending > 0) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2000))
  state = await status(origin)
}
check('queue drains after interrupt', state.queueRunning === 0 && state.queuePending === 0, `running=${state.queueRunning} pending=${state.queuePending}`)

const after = await generate(origin, {
  prompt: 'a small blue ceramic cup on a wooden desk, soft light',
  family: 'classic',
  width: 384,
  height: 384,
  steps: 6,
  seed: 3,
})
check('generation works after interrupt', after.images.length === 1, after.images[0]?.path)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('TIMEOUT/INTERRUPT CHECKS PASSED')
