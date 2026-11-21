// Smoke test: ComfyUI status + model inventory (no generation).
// Run: node test/check-connection.mjs
import { status, listModels } from '../lib/comfy-client.js'

const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'

const state = await status(origin)
console.log('--- status ---')
console.log(JSON.stringify(state, null, 2))
if (!state.online) process.exit(1)

const models = await listModels(origin)
console.log('\n--- models ---')
for (const model of models) {
  console.log(
    `${model.family.padEnd(8)} ${model.folder.padEnd(16)} ${String(model.sizeGB ?? '?').padStart(6)} GB  ${model.name}`,
  )
}
const families = [...new Set(models.map(model => model.family))]
console.log(`\n${models.length} models, families: ${families.join(', ')}`)
for (const expected of ['classic', 'anima', 'krea2', 'moss']) {
  if (!families.includes(expected)) {
    console.error(`MISSING FAMILY: ${expected}`)
    process.exitCode = 1
  }
}
