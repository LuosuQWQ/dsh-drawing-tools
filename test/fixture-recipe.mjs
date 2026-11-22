// Offline check for the committed replication fixture: test/fixtures/anima-cam-recipe.png
// It is the ORIGINAL ComfyUI PNG (not a re-encoded copy), so anyone can open it,
// read the recipe and try to reproduce the image.
// Run: node test/fixture-recipe.mjs
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPngInfo, summarizeComfyPrompt } from '../lib/pnginfo.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'test/fixtures/anima-cam-recipe.png')
// 原始文件的 sha256：重新保存/压缩这张图会让断言失败，防止元数据被洗掉。
const FIXTURE_SHA256 = '2bb77d7f0d63a201724f4e26e35be195fba06a27218f3e7c59df718b9feffe5f'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const bytes = readFileSync(file)
const info = readPngInfo(bytes)
check('fixture is a PNG', info.isPng === true)
check('fixture has a prompt text chunk', info.text.has('prompt'))
check('fixture has no re-encoded workflow chunk', !info.text.has('workflow'))
check('fixture keeps the original pixel size', info.width === 1024 && info.height === 1536, `${info.width}x${info.height}`)
check('fixture keeps the original bytes', createHash('sha256').update(bytes).digest('hex') === FIXTURE_SHA256, createHash('sha256').update(bytes).digest('hex'))
check('fixture stays small enough to commit', statSync(file).size < 2_000_000, `${Math.round(statSync(file).size / 1024)} KB`)

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
