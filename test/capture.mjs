// Host capture hook test: mounts the real DSH Cordis build, installs the
// attachment wrapper from lib/host/index.js, and proves that the *original*
// PNG bytes are captured under the normalized attachment id before they are
// normalized away. Offline: no ComfyUI, no network.
// Run: node test/capture.mjs
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Context, Service } from '@deepseek-ai/cordis'
import { installPnginfoCapture, pnginfoCaptureState } from '../lib/host/index.js'
import { readCapturedRecipe, sha256Hex } from '../lib/pnginfo.js'

const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), 'pnginfo-capture-home-'))

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
function makePng(entries) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(512, 0)
  header.writeUInt32BE(512, 4)
  header[8] = 8
  header[9] = 0
  const pixels = Buffer.concat([Buffer.from([0]), Buffer.alloc(512 * 512, 0x80)])
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    ...entries.map(([keyword, text]) => textChunk(keyword, text)),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const apiGraph = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'krea2/test.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a calm blue portrait' } },
  3: { class_type: 'KSampler', inputs: { seed: 7, steps: 8, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple', positive: [2, 0] } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
}
const pngBytes = makePng([
  ['prompt', JSON.stringify(apiGraph)],
  ['workflow', JSON.stringify({ nodes: [{ id: 1 }, { id: 2 }], links: [] })],
])

// --- a service shaped like @deepseek-ai/dsh-attachment-local -----------------
class FakeAttachments extends Service {
  constructor(ctx) {
    super(ctx, 'attachments')
  }

  async saveImages(inputs) {
    return inputs.map(input => ({
      attachmentId: `sha256:${sha256Hex(input.data)}`,
      name: input.name,
      mediaType: 'image/png',
      width: 512,
      height: 512,
    }))
  }

  async saveImage(input) {
    const [ref] = await this.saveImages([input])
    return ref
  }
}

const ctx = new Context()
new FakeAttachments(ctx)
installPnginfoCapture(ctx)

check('hook reports installed', pnginfoCaptureState.installed === true, pnginfoCaptureState.storeDir)
check('hook records the store dir', typeof pnginfoCaptureState.storeDir === 'string' && pnginfoCaptureState.storeDir.includes('drawing-pnginfo'), pnginfoCaptureState.storeDir)

const refs = await ctx.attachments.saveImages([
  { data: pngBytes, name: 'ComfyUI_temp_abc_00002_.png', mediaType: 'image/png' },
  { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), name: 'plain.png', mediaType: 'image/png' },
])
check('saveImages still returns the provider refs', refs.length === 2 && refs[0].attachmentId.startsWith('sha256:'), refs[0]?.attachmentId)
check('capture counted', pnginfoCaptureState.captured === 1, String(pnginfoCaptureState.captured))
check('capture recorded the name', pnginfoCaptureState.lastName === 'ComfyUI_temp_abc_00002_.png', String(pnginfoCaptureState.lastName))
const captured = readCapturedRecipe(refs[0].attachmentId)
check('recipe readable by attachment id', Boolean(captured) && captured.attachmentId === refs[0].attachmentId)
check('recipe keeps prompt json', typeof captured?.prompt === 'string' && JSON.parse(captured.prompt)[3].inputs.seed === 7)
check('recipe keeps workflow node count', captured?.workflowNodeCount === 2, String(captured?.workflowNodeCount))
check('recipe keeps the full UI workflow', typeof captured?.workflow === 'string' && Array.isArray(JSON.parse(captured.workflow).nodes))
check('store file exists', existsSync(path.join(pnginfoCaptureState.storeDir, `${refs[0].attachmentId.slice('sha256:'.length)}.json`)))

// --- singular saveImage (used by read_image) --------------------------------
const single = await ctx.attachments.saveImage({ data: pngBytes, name: 'single.png', mediaType: 'image/png' })
check('saveImage wrapper captures too', readCapturedRecipe(single.attachmentId)?.name === 'single.png')

// --- idempotence and non-PNG ------------------------------------------------
const before = pnginfoCaptureState.captured
installPnginfoCapture(ctx)
check('second install does not double-wrap', pnginfoCaptureState.captured === before)
await ctx.attachments.saveImages([{ data: Buffer.from('not a png at all'), name: 'x.bin', mediaType: 'image/png' }])
check('non-PNG bytes are ignored', pnginfoCaptureState.captured === before)

// --- wrapper survives a failing provider call -------------------------------
const original = Object.getPrototypeOf(ctx.attachments).saveImages
Object.getPrototypeOf(ctx.attachments).saveImages = async () => {
  throw new Error('provider boom')
}
const failed = await ctx.attachments.saveImages([{ data: pngBytes }]).then(() => false, error => error.message === 'provider boom')
Object.getPrototypeOf(ctx.attachments).saveImages = original
check('provider errors still propagate unchanged', failed)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ALL CAPTURE CHECKS PASSED')
