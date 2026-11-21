// Tool-layer smoke test: mounts tools.js on a stub Cordis ctx and exercises all
// seven drawing_* tools end to end against the live ComfyUI instance.
// Run: node test/tools-smoke.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, jsonSafe, name } from '../lib/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
const outputDir = process.env.COMFY_OUTPUT_DIR || path.join(here, '..', '..', '..', 'drawing', 'output')
const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}
// The harness rejects tool outputs that JSON.stringify would lose (undefined keys,
// non-finite numbers), so assert the exact condition here.
const isLosslessJson = value => {
  if (value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(isLosslessJson)
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false
    return Object.values(value).every(isLosslessJson)
  }
  return true
}

// The executor rejects tool results that JSON.stringify would not round-trip:
// optional arguments leave `undefined` keys behind, and floats may be -0/NaN.
const sanitized = jsonSafe({
  text: 'ok',
  missingParam: undefined,
  params: { denoise: -0, cfg: NaN, seconds: Infinity, seed: 7, lora: undefined },
  images: [{ path: 'a.png' }, undefined],
})
check('jsonSafe drops undefined object keys', !('missingParam' in sanitized) && !('lora' in sanitized.params))
check('jsonSafe normalizes non-finite numbers', sanitized.params.denoise === 0 && sanitized.params.cfg === null && sanitized.params.seconds === null)
check('jsonSafe fills arrays with null', sanitized.images[1] === null)
check('jsonSafe output is lossless JSON', isLosslessJson(sanitized))

// --- stub Cordis context -----------------------------------------------------
const registered = []
const ctx = {
  effect(fn) {
    return fn()
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
}

apply(ctx, {
  origin,
  outputDir,
  workflowsDir: path.join(here, 'fixtures'),
  timeoutSeconds: 300,
})

check('plugin name', name === 'dsh-drawing-tools/tools', name)
check('inject tools', inject.includes('tools'))
const expected = ['drawing_status', 'drawing_models', 'drawing_guide', 'drawing_generate', 'drawing_queue', 'drawing_history', 'drawing_workflow', 'drawing_pnginfo']
const names = registered.map(definition => definition.name)
check('registers 8 tools', names.length === 8 && expected.every(expectedName => names.includes(expectedName)), names.join(', '))
for (const definition of registered) {
  check(`schema ${definition.name}`, Boolean(definition.description) && typeof definition.parameters === 'object' && typeof definition.output?.schema === 'object')
}
const generateDef = registered.find(definition => definition.name === 'drawing_generate')
check('drawing_generate requires prompt', generateDef.parameters.required?.includes('prompt'))
check('drawing_generate accepts lora string or object', generateDef.parameters.properties?.lora?.oneOf?.length === 2)
check('drawing_generate not concurrency safe', generateDef.isConcurrencySafe({ prompt: 'x' }) === false)
const queueDef = registered.find(definition => definition.name === 'drawing_queue')
check('drawing_queue action required', queueDef.parameters.required?.includes('action'))
check('drawing_status concurrency safe', registered.find(definition => definition.name === 'drawing_status').isConcurrencySafe({}) === true)

const run = async (toolName, args, exec = {}) => {
  const definition = registered.find(item => item.name === toolName)
  const value = await definition.execute(args, exec)
  const content = definition.output.render(args, value)
  return { value, content, text: content.map(block => block.text ?? '').join('\n') }
}

// --- drawing_status ---------------------------------------------------------
const status = await run('drawing_status', {})
check('status text online', /ComfyUI: 在线/.test(status.text), status.text.split('\n')[0])
check('status lists families', /classic/.test(status.text) && /moss/.test(status.text))

// --- drawing_models ---------------------------------------------------------
const models = await run('drawing_models', { kind: 'diffusion_models' })
check('models diffusion list', /krea2_turbo-Q4_K_M\.gguf/.test(models.text) && /moss_image_sft_int8_convrot/.test(models.text))
check('models recommends params', /推荐: steps=8 cfg=1/.test(models.text))

// --- drawing_guide ----------------------------------------------------------
const guide = await run('drawing_guide', { family: 'moss' })
check('guide moss prompt rules', /16 的正整数倍/.test(guide.text) && /Layout/.test(guide.text), guide.value.path)
check('guide moss prefixed', /family=moss/.test(guide.text) && guide.value.family === 'moss')
check('guide moss file exists', existsSync(guide.value.path) && path.isAbsolute(guide.value.path))
const guideIndex = await run('drawing_guide', {})
check('guide index lists all families', ['classic', 'anima', 'krea2', 'moss'].every(f => guideIndex.text.includes(f)))

// --- drawing_generate (one cheap classic image) -----------------------------
const generated = await run(
  'drawing_generate',
  {
    prompt: 'a single ripe red apple on a white table, studio photo, soft shadow',
    family: 'classic',
    width: 512,
    height: 512,
    steps: 8,
    cfg: 7,
    seed: 99,
    timeoutSeconds: 300,
  },
  { agent: { session: { header: { cwd: here } } } },
)
check('generate returns image', generated.value.images?.length === 1, generated.value.images?.[0]?.path)
check('generate output lossless JSON', isLosslessJson(generated.value), JSON.stringify(Object.keys(generated.value.params || {})))
check('generate params omit empty lora', !('lora' in (generated.value.params || {})) && !('initImage' in (generated.value.params || {})))
check('generate absolute path exists', Boolean(generated.value.images?.[0]?.path) && path.isAbsolute(generated.value.images[0].path) && existsSync(generated.value.images[0].path))
check('generate text says show_image', /show_image/.test(generated.text) && /absolute|绝对路径/.test(generated.text))
check('generate render has path', generated.text.includes(generated.value.images[0].path))

// --- drawing_pnginfo on the image just generated --------------------------
const pnginfo = await run('drawing_pnginfo', { path: generated.value.images[0].path }, { agent: { session: { header: { cwd: here } } } })
check('pnginfo reads generated PNG', pnginfo.value.hasPrompt === true && /正向提示词/.test(pnginfo.text))
check('pnginfo recovers generate seed', pnginfo.value.params?.seed === 99, String(pnginfo.value.params?.seed))
check('pnginfo recovers checkpoint', /\.safetensors$/i.test(pnginfo.value.model?.unet ?? ''), pnginfo.value.model?.unet)

// --- drawing_queue ----------------------------------------------------------
const queueStatus = await run('drawing_queue', { action: 'status' })
check('queue status text', /ComfyUI 队列/.test(queueStatus.text), queueStatus.text.split('\n')[0])

// --- drawing_history --------------------------------------------------------
const history = await run('drawing_history', { limit: 5 })
check('history text', /最近 \d+ 条完成记录/.test(history.text))
check('history includes local path', history.text.includes(path.resolve(outputDir)))
check('history mentions show_image', /show_image/.test(history.text))

// --- drawing_workflow -------------------------------------------------------
const listed = await run('drawing_workflow', { action: 'list' })
check('workflow list shows api fixture', /api-sd15-txt2img\.json/.test(listed.text) && /API 格式/.test(listed.text))
const ran = await run('drawing_workflow', { action: 'run', name: 'api-sd15-txt2img.json', timeoutSeconds: 300 })
check('workflow run image', ran.value.images?.length === 1 && existsSync(ran.value.images[0].path), ran.value.images?.[0]?.path)
check('workflow run says show_image', /show_image/.test(ran.text))

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ALL TOOL CHECKS PASSED')
