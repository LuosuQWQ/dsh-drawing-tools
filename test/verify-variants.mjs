// Verify Anima variants: turbo model override (8 steps / CFG 1) and the
// official blueprint's er_sde sampler (docs recommend euler).
// Run: node test/verify-variants.mjs
import { readFile } from 'node:fs/promises'
import { generate } from '../lib/comfy-client.js'

const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const turbo = await generate(origin, {
  prompt: 'anime portrait of a girl with silver hair, cherry blossoms, soft light',
  family: 'anima',
  model: 'anima-turbo-v1.1.safetensors',
  width: 512,
  height: 512,
  seed: 11,
})
check('anima turbo defaults steps=8 cfg=1', turbo.params.steps === 8 && turbo.params.cfg === 1, JSON.stringify({ steps: turbo.params.steps, cfg: turbo.params.cfg }))
check('anima turbo image', turbo.images.length === 1 && (await readFile(turbo.images[0].path))[0] === 0x89, turbo.images[0]?.path)

const erSde = await generate(origin, {
  prompt: 'anime portrait of a girl with silver hair, cherry blossoms, soft light',
  family: 'anima',
  width: 512,
  height: 512,
  seed: 11,
  sampler: 'er_sde',
})
check('anima er_sde accepted', erSde.params.sampler === 'er_sde' && erSde.images.length === 1, erSde.images[0]?.path)
check('anima er_sde image', (await readFile(erSde.images[0].path))[0] === 0x89)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('VARIANT CHECKS PASSED')
