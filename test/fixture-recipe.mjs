// Offline check for the committed replication fixture: test/fixtures/anima-cam-recipe.png
// must stay a real PNG whose `prompt` text chunk still describes the original
// anima recipe. This is what other users open when they try to reproduce the image.
// Run: node test/fixture-recipe.mjs
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPngInfo, summarizeComfyPrompt } from '../lib/pnginfo.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'test/fixtures/anima-cam-recipe.png')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const bytes = readFileSync(file)
const info = readPngInfo(bytes)
check('fixture is a PNG', info.isPng === true)
check('fixture has a prompt text chunk', info.text.has('prompt'))
check('fixture keeps a preview size', info.width === 768 && info.height === 1152, `${info.width}x${info.height}`)
check('fixture stays small enough to commit', statSync(file).size < 1_500_000, `${Math.round(statSync(file).size / 1024)} KB`)

const summary = summarizeComfyPrompt(JSON.parse(info.text.get('prompt')))
check('unet is anima-aesthetic-v1.1', summary.model?.unet === 'anima-aesthetic-v1.1.safetensors', summary.model?.unet)
check('three style LoRAs survive', summary.loras?.length === 3, String(summary.loras?.length))
check('LoRA strengths survive', summary.loras?.map((lora) => lora.strength).join(',') === '0.4,0.5,0.6', summary.loras?.map((lora) => lora.strength).join(','))
check('seed survives', summary.params?.seed === 11111, String(summary.params?.seed))
check('steps and cfg survive', summary.params?.steps === 30 && summary.params?.cfg === 4.5, JSON.stringify(summary.params))
check('recipe size is the original 1024x1536', summary.size?.width === 1024 && summary.size?.height === 1536, JSON.stringify(summary.size))
check('trigger word survives', String(summary.positive ?? '').startsWith('@ypuddinneko'), String(summary.positive ?? '').slice(0, 30))

if (failed > 0) {
  console.error(`\n${failed} fixture check(s) failed`)
  process.exit(1)
}
console.log('\nALL FIXTURE CHECKS PASSED')
