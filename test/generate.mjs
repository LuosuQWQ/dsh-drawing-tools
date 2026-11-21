// Generate one image and validate the downloaded PNG.
// Run: node test/generate.mjs <family> [width] [height] [steps] [cfg] [sampler] [scheduler]
// Example: node test/generate.mjs anima 512 512 30 4 euler simple
import { readFile } from 'node:fs/promises'
import { generate, status, FAMILIES } from '../lib/comfy-client.js'

const [family = 'classic', width = '512', height = '512', steps, cfg, sampler, scheduler] = process.argv.slice(2)
if (!FAMILIES[family]) {
  console.error(`usage: node test/generate.mjs <${Object.keys(FAMILIES).join('|')}> [w] [h] [steps] [cfg] [sampler] [scheduler]`)
  process.exit(1)
}

const origin = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
const before = await status(origin)
console.log('status:', before.online ? `online v${before.version}, queue ${before.queueRunning}/${before.queuePending}, VRAM free ${before.vramFreeGB} GB` : before.error)

const params = {
  prompt:
    family === 'moss'
      ? 'A cozy reading nook with a warm lamp, an open book on a wooden table, soft evening light, photorealistic'
      : 'a red fox sitting in a snowy forest at dusk, soft rim light, detailed fur, cinematic',
  family,
  width: Number(width),
  height: Number(height),
  seed: 123456789,
}
if (steps) params.steps = Number(steps)
if (cfg) params.cfg = Number(cfg)
if (sampler) params.sampler = sampler
if (scheduler) params.scheduler = scheduler

console.log('params:', JSON.stringify({ ...params, prompt: `${params.prompt.slice(0, 40)}…` }))
const result = await generate(origin, params)

if (result.timedOut) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(2)
}
console.log(`\ngenerated in ${result.seconds}s (queue wait ${result.queueSeconds}s), promptId=${result.promptId}`)
for (const image of result.images) {
  const bytes = await readFile(image.path)
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  // PNG IHDR: width/height are big-endian uint32 at bytes 16..24.
  const pngWidth = isPng ? bytes.readUInt32BE(16) : null
  const pngHeight = isPng ? bytes.readUInt32BE(20) : null
  console.log(`  ${image.path}`)
  console.log(`  png=${isPng} ${pngWidth}x${pngHeight} ${(image.bytes / 1024).toFixed(1)} KiB`)
  if (!isPng || !pngWidth || !pngHeight) process.exitCode = 1
}
console.log('resolved params:', JSON.stringify(result.params))
