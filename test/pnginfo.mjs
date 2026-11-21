// Offline contract test for drawing_pnginfo: builds a tiny PNG with ComfyUI
// text chunks, mounts the tool on a stub Cordis ctx, and checks the recipe it
// reports. No ComfyUI server and no network needed.
// Run: node test/pnginfo.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  attachmentHash,
  captureImageBytes,
  captureStoreStatus,
  defaultImageRoots,
  findCapturedByName,
  findImageByName,
  inspectImageMetadata,
  parseA1111Parameters,
  readCapturedRecipe,
  pnginfoStoreDir,
  readPngInfo,
  sha256Hex,
  summarizeComfyPrompt,
  summarizeWorkflow,
} from '../lib/pnginfo.js'
import { apply, jsonSafe, parseLoraArg, toComfyName } from '../lib/tools.js'

// Keep every capture written by this test inside one throwaway DSH home.
process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), 'pnginfo-home-'))

const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

// --- minimal PNG writer ------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}
function textChunk(keyword, text) {
  return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]))
}
function makePng(entries, width = 1, height = 1) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 0
  const pixels = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * height, 0x80)])
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    ...entries.map(([keyword, text]) => textChunk(keyword, text)),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- a small ComfyUI API graph ----------------------------------------------
const apiGraph = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2\\redcraft22INT8INT4.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl-4b-bf16.safetensors', type: 'krea2' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen-image-vae.safetensors' } },
  4: { class_type: 'LoraLoaderModelOnly', inputs: { model: [1, 0], lora_name: 'style.safetensors', strength_model: 0.8 } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: 'a calm blue underwater portrait, soft light', clip: [2, 0] } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, low quality', clip: [2, 0] } },
  7: {
    class_type: 'KSampler',
    inputs: { model: [4, 0], positive: [5, 0], negative: [6, 0], seed: 42, steps: 8, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1 },
  },
  8: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  9: { class_type: 'VAEDecode', inputs: { samples: [7, 0], vae: [3, 0] } },
  10: { class_type: 'SaveImage', inputs: { images: [9, 0], filename_prefix: 'test' } },
  11: { class_type: 'CR Text', inputs: { text: 'blue palette, film grain' } },
}
const workflowGraph = {
  version: 0.4,
  nodes: [
    { id: 1, type: 'UNETLoader' },
    { id: 2, type: 'KSampler' },
    { id: 3, type: 'SaveImage' },
  ],
  links: [[1, 0, 2, 0]],
  groups: [],
}
const pngBytes = makePng([
  ['prompt', JSON.stringify(apiGraph)],
  ['workflow', JSON.stringify(workflowGraph)],
  ['parameters', 'a calm blue portrait\nNegative prompt: worst quality\nSteps: 20, CFG scale: 7, Sampler: euler, Schedule type: normal, Seed: 7, Size: 768x1024'],
], 512, 512)

// --- parser ------------------------------------------------------------------
const info = readPngInfo(pngBytes)
check('detects PNG', info.isPng && info.mediaType === 'png')
check('reads IHDR size', info.width === 512 && info.height === 512, `${info.width}x${info.height}`)
check('reads all text keywords', ['prompt', 'workflow', 'parameters'].every(key => info.text.has(key)), [...info.text.keys()].join(','))

const meta = inspectImageMetadata(pngBytes)
check('parses prompt JSON', Boolean(meta.comfyPrompt) && Object.keys(meta.comfyPrompt).length === 11)
const summary = summarizeComfyPrompt(meta.comfyPrompt)
check('model unet', summary.model.unet === 'krea2\\redcraft22INT8INT4.safetensors')
check('model clip/vae', summary.model.clip === 'qwen3vl-4b-bf16.safetensors' && summary.model.vae === 'qwen-image-vae.safetensors')
check('LoRA node', summary.loras.some(lora => lora.name === 'style.safetensors' && lora.strength === 0.8), JSON.stringify(summary.loras))
check('sampler params', summary.params.seed === 42 && summary.params.steps === 8 && summary.params.cfg === 1 && summary.params.sampler === 'er_sde' && summary.params.scheduler === 'simple')
check('latent size', summary.size.width === 512 && summary.size.height === 512)
check('positive prompt resolved through KSampler link', summary.positive === 'a calm blue underwater portrait, soft light')
check('negative prompt resolved through KSampler link', summary.negative === 'worst quality, low quality')

const a1111 = parseA1111Parameters(meta.a1111 && 'a calm blue portrait\nNegative prompt: worst quality\nSteps: 20, CFG scale: 7, Sampler: euler, Schedule type: normal, Seed: 7, Size: 768x1024')
check('A1111 positive', a1111.positive === 'a calm blue portrait')
check('A1111 negative', a1111.negative === 'worst quality')
check('A1111 params', a1111.params.steps === 20 && a1111.params.cfg === 7 && a1111.params.seed === 7 && a1111.size.width === 768)

check('UI workflow summary', summarizeWorkflow(workflowGraph).nodeCount === 3 && summarizeWorkflow(workflowGraph).linkCount === 1)
check('summarize clamps undefined', summarizeComfyPrompt({}).positive === null && summarizeComfyPrompt({}).nodeCount === 0)
const linkedSize = summarizeComfyPrompt({
  1: { class_type: 'ResolutionMasterSimplify', inputs: { width: 1920, height: 1080 } },
  2: { class_type: 'EmptyLatentImage', inputs: { width: ['1', 0], height: ['1', 1], batch_size: 1 } },
})
check('resolves linked latent size', linkedSize.size?.width === 1920 && linkedSize.size?.height === 1080, JSON.stringify(linkedSize.size))

// --- find by name ------------------------------------------------------------
const searchRoot = mkdtempSync(path.join(os.tmpdir(), 'pnginfo-search-'))
mkdirSync(path.join(searchRoot, 'nested'), { recursive: true })
const nestedFile = path.join(searchRoot, 'nested', 'ComfyUI_temp_abc_00001_.png')
writeFileSync(nestedFile, pngBytes)
const found = findImageByName([searchRoot], 'comfyui_temp_abc_00001_.PNG')
check('finds file by name case-insensitively', found.length === 1 && found[0] === nestedFile, found.join(', '))
check('ignores names with separators', findImageByName([searchRoot], 'nested/ComfyUI_temp_abc_00001_.png').length === 0)
const roots = defaultImageRoots(os.tmpdir())
check('default roots include a Downloads folder', roots.some(root => /[\\/]downloads$/i.test(root)), roots.slice(0, 4).join(', '))
check('default roots include the cwd', roots.includes(os.tmpdir()))

// --- tool mount --------------------------------------------------------------
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
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pnginfo-tool-'))
const workflowsDir = path.join(tempRoot, 'workflows')
const outputDir = path.join(tempRoot, 'output')
mkdirSync(workflowsDir, { recursive: true })
mkdirSync(outputDir, { recursive: true })
apply(ctx, { origin: 'http://127.0.0.1:8188', outputDir, workflowsDir, uiWorkflowsDir: path.join(tempRoot, 'ui-workflows'), timeoutSeconds: 300 })

const def = registered.find(definition => definition.name === 'drawing_pnginfo')
check('registers drawing_pnginfo', Boolean(def))
check('tool has schema and description', Boolean(def.description) && typeof def.parameters === 'object' && typeof def.output?.schema === 'object')
check('tool is concurrency safe', def.isConcurrencySafe({}) === true)
check('parseLoraArg colon form', parseLoraArg('style:0.8')?.name === 'style' && parseLoraArg('style:0.8')?.strength === 0.8)
check('parseLoraArg at form', parseLoraArg('Krea2/style/x.safetensors@0.55')?.name === 'Krea2/style/x.safetensors' && parseLoraArg('Krea2/style/x.safetensors@0.55')?.strength === 0.55)
check('parseLoraArg normalizes backslashes', parseLoraArg({ name: 'Krea2\\style\\x.safetensors', strength: 0.5 })?.name === 'Krea2/style/x.safetensors')
check('parseLoraArg plain name', parseLoraArg('plain.safetensors')?.strength === 1)
check('parseLoraArg empty', parseLoraArg('') === null && parseLoraArg(undefined) === null)
check('toComfyName uses platform separator', toComfyName('a/b.safetensors') === (process.platform === 'win32' ? 'a\\b.safetensors' : 'a/b.safetensors'))

const pngPath = path.join(tempRoot, 'ComfyUI_temp_abc_00001_.png')
writeFileSync(pngPath, pngBytes)
const exec = { agent: { session: { header: { cwd: tempRoot } } } }
const result = await def.execute({ path: pngPath }, exec)
check('tool reports prompt', result.hasPrompt && result.file.mediaType === 'png')
check('tool text has prompt heading', /正向提示词/.test(result.text))
check('tool text has params', /seed 42/.test(result.text) && /8 步/.test(result.text) && /512×512/.test(result.text))
check('tool text has LoRA', /style\.safetensors:0\.8/.test(result.text))
check('tool result is lossless JSON', JSON.stringify(result) === JSON.stringify(JSON.parse(JSON.stringify(result))))

const saved = await def.execute({ path: pngPath, save: true }, exec)
check('save writes API workflow', Boolean(saved.savedWorkflowPath) && existsSync(saved.savedWorkflowPath), saved.savedWorkflowPath)
check('saved workflow is the API graph', JSON.parse(readFileSync(saved.savedWorkflowPath, 'utf8'))[7].class_type === 'KSampler')
check('saved UI workflow lands in the ComfyUI dir', Boolean(saved.savedUiWorkflowPath) && saved.savedUiWorkflowPath.includes('ui-workflows') && Array.isArray(JSON.parse(readFileSync(saved.savedUiWorkflowPath, 'utf8')).nodes))

const jpegPath = path.join(tempRoot, 'normalized-copy.jpg')
writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]))
const jpegResult = await def.execute({ path: jpegPath }, exec)
check('JPEG explains stripped metadata', /不是 PNG/.test(jpegResult.text) && /JPEG/.test(jpegResult.text) && jpegResult.hasPrompt === false, jpegResult.text.split('\n')[1])

const plainPngPath = path.join(tempRoot, 'plain.png')
writeFileSync(plainPngPath, makePng([['Comment', 'not comfyui']]))
const plainResult = await def.execute({ path: plainPngPath }, exec)
check('PNG without recipe is reported', /没有可读的生成配方/.test(plainResult.text) && plainResult.hasPrompt === false)

const byName = await def.execute({ name: 'ComfyUI_temp_abc_00001_.png' }, exec)
check('name lookup resolves inside cwd', byName.file.path === pngPath, byName.file.path)
// --- capture store ----------------------------------------------------------
const captureBytes = makePng([
  ['prompt', JSON.stringify(apiGraph)],
  ['workflow', JSON.stringify(workflowGraph)],
], 512, 512)
const captureHash = sha256Hex(captureBytes)
const captureRef = { attachmentId: `sha256:${captureHash}`, name: 'ComfyUI_temp_abc_00001_.png', mediaType: 'image/png', width: 512, height: 512 }
const sidecar = captureImageBytes(captureBytes, captureRef)
check('capture writes a sidecar', Boolean(sidecar) && existsSync(path.join(pnginfoStoreDir(), `${captureHash}.json`)))
check('capture keeps prompt and workflow count', Boolean(sidecar?.prompt) && sidecar.workflowNodeCount === 3)
check('capture readable by id', readCapturedRecipe(`sha256:${captureHash}`)?.attachmentId === `sha256:${captureHash}`)
check('capture readable by name', findCapturedByName('comfyui_temp_abc_00001_.PNG')?.attachmentId === `sha256:${captureHash}`)
check('capture normalizes hash', attachmentHash(`sha256:${captureHash.toUpperCase()}`) === captureHash)
const storeStatus = captureStoreStatus()
check('capture store status', storeStatus.count >= 1 && storeStatus.dir === pnginfoStoreDir(), `${storeStatus.count} in ${storeStatus.dir}`)
check('capture ignores png without recipe', captureImageBytes(makePng([['Comment', 'hi']]), captureRef) === null)
check('unknown id throws', await def.execute({ sha256: '0'.repeat(64) }, exec).then(() => false, error => /入库记录/.test(error.message)))

// --- tool by sha256, with no file anywhere ----------------------------------
const bySha = await def.execute({ sha256: `sha256:${captureHash}` }, exec)
check('tool resolves by sha256 without a file', bySha.source === 'capture' && /正向提示词/.test(bySha.text) && /seed 42/.test(bySha.text))
check('tool capture has no file path', bySha.file === null && bySha.capture?.attachmentId === `sha256:${captureHash}`)
const savedCapture = await def.execute({ sha256: `sha256:${captureHash}`, save: true }, exec)
check('tool saves API workflow from capture', Boolean(savedCapture.savedWorkflowPath) && existsSync(savedCapture.savedWorkflowPath))
check('tool saves UI workflow from capture', Boolean(savedCapture.savedUiWorkflowPath) && existsSync(savedCapture.savedUiWorkflowPath))

// --- normalized copy maps back to its capture by its own sha256 -------------
const copyBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
const copyHash = sha256Hex(copyBytes)
const copyRef = { attachmentId: `sha256:${copyHash}`, name: 'copy.png', mediaType: 'image/png', width: 512, height: 512 }
check('second capture writes', Boolean(captureImageBytes(captureBytes, copyRef)))
const copyPath = path.join(tempRoot, 'normalized-copy.jpg')
writeFileSync(copyPath, copyBytes)
const byCopy = await def.execute({ path: copyPath }, exec)
check('tool maps normalized copy to capture', byCopy.source === 'capture' && /seed 42/.test(byCopy.text), byCopy.text.split('\n')[1])

// --- optional: a real ComfyUI PNG supplied by the caller ---------------------
// Point COMFY_TEST_PNG at any ComfyUI output PNG to exercise the real-file path.
const realFile = process.env.COMFY_TEST_PNG || ''
if (realFile && existsSync(realFile)) {
  const real = await def.execute({ path: realFile }, exec)
  check('real ComfyUI PNG has prompt+workflow', real.hasPrompt && real.hasWorkflow)
  check('real ComfyUI PNG resolves model', /redcraft22INT8INT4/.test(real.text))
  check('real ComfyUI PNG resolves LoRA tags', /ba_style_krea2_v1(\.safetensors)?:0\.75/.test(real.text))
  check('real ComfyUI PNG resolves seed', /seed 643735660942093/.test(real.text))
} else {
  console.log('SKIP  real ComfyUI PNG fixture (set COMFY_TEST_PNG to a ComfyUI PNG to run)')
}

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ALL PNGINFO CHECKS PASSED')
