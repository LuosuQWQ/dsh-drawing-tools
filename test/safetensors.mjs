// Unit tests for the .safetensors header reader (wild LoRAs have no other metadata).
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSafetensorsHeader, describeSafetensorsHeader, inspectModelFile } from '../lib/safetensors.js'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-safe-'))

/** 写一个最小合法 safetensors：8 字节头部长度 + JSON 头 + 权重占位。 */
function writeSafetensors(file, metadata, tensors = { weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }) {
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata, ...tensors }), 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length), 0)
  writeFileSync(file, Buffer.concat([length, header, Buffer.alloc(4)]))
}

const loraFile = path.join(tmp, 'char.safetensors')
writeSafetensors(loraFile, {
  'ss_base_model_version': 'sdxl_base_v1-0',
  'ss_output_name': 'ayanami style',
  'ss_network_dim': '32',
  'ss_network_alpha': '16',
  'ss_resolution': '(1024, 1024)',
  'ss_tag_frequency': JSON.stringify({
    '10_ayanami': { '1girl': 40, 'solo': 30, 'ayanami (azur lane)': 28, 'long_hair': 20, 'blonde_hair': 12 },
  }),
})

const parsed = await readSafetensorsHeader(loraFile)
check('header parses', parsed !== null && parsed.meta['ss_base_model_version'] === 'sdxl_base_v1-0')
check('tensor count is reported', parsed?.tensorCount === 1, String(parsed?.tensorCount))

const described = describeSafetensorsHeader(parsed?.meta)
check('base model is recognized', described?.baseModel === 'sdxl_base_v1-0', described?.baseModel)
check('training tags are kept', described?.trainingTags.length === 5, String(described?.trainingTags.length))
check('generic tags are filtered from candidates', !described?.tagCandidates.includes('1girl') && !described?.tagCandidates.includes('long_hair'), JSON.stringify(described?.tagCandidates))
check('character tag becomes a candidate', described?.tagCandidates[0] === 'ayanami (azur lane)', JSON.stringify(described?.tagCandidates))
check('alpha ratio is computed', described?.alphaRatio === 0.5, String(described?.alphaRatio))
check('recommended strength is provided', described?.recommendedStrength === 0.8)
check('resolution and clip skip survive', described?.resolution === '(1024, 1024)')

// modelspec.trigger_phrase wins over training tags
const specFile = path.join(tmp, 'spec.safetensors')
writeSafetensors(specFile, {
  'modelspec.architecture': 'flux-1-dev/lora',
  'modelspec.title': 'Ink Wash',
  'modelspec.trigger_phrase': 'ink wash, sumi-e',
  'modelspec.tags': 'style, ink',
})
const spec = await inspectModelFile(specFile)
check('modelspec trigger phrase is used', JSON.stringify(spec?.triggerWords) === JSON.stringify(['ink wash', 'sumi-e']), JSON.stringify(spec?.triggerWords))
check('modelspec architecture becomes base model', spec?.baseModel === 'flux-1-dev/lora', spec?.baseModel)

// bad inputs
const corrupt = path.join(tmp, 'corrupt.safetensors')
writeFileSync(corrupt, Buffer.from('not a safetensors file at all'))
check('corrupt file yields null', (await readSafetensorsHeader(corrupt)) === null)
check('missing file yields null', (await inspectModelFile(path.join(tmp, 'nope.safetensors'))) === null)
const ckpt = path.join(tmp, 'model.ckpt')
writeFileSync(ckpt, 'pickle')
check('pickle checkpoints are skipped', (await inspectModelFile(ckpt)) === null)

// header without useful metadata → null (not a fake "known" record)
const empty = path.join(tmp, 'empty.safetensors')
writeSafetensors(empty, {})
check('empty metadata yields null', (await inspectModelFile(empty)) === null)

rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL SAFETENSORS CHECKS PASSED' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
