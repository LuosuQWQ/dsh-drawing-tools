// Read a model file's own metadata: the .safetensors JSON header.
//
// Wild LoRAs often arrive with no source record at all, but kohya and ModelSpec
// write training metadata into the header: base model, trigger phrase, training
// tags, network rank/alpha. It costs one small read, never loads the weights.
import fs from 'node:fs/promises'

const MAX_HEADER_BYTES = 20 * 1024 * 1024
const SAFE_EXT = /\.(safetensors|sft)$/i

const splitList = (value) =>
  String(value)
    .split(/[,|\n]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')

/** 读 .safetensors 头；不是 safetensors、头损坏或过大时返回 null。 */
export async function readSafetensorsHeader(filePath, { maxHeaderBytes = MAX_HEADER_BYTES } = {}) {
  if (typeof filePath !== 'string' || !SAFE_EXT.test(filePath)) return null
  let handle
  try {
    handle = await fs.open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const lengthBuffer = Buffer.alloc(8)
    const lengthRead = await handle.read(lengthBuffer, 0, 8, 0)
    if (lengthRead.bytesRead !== 8) return null
    const headerLength = Number(lengthBuffer.readBigUInt64LE(0))
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > maxHeaderBytes) return null
    const headerBuffer = Buffer.alloc(headerLength)
    const headerRead = await handle.read(headerBuffer, 0, headerLength, 8)
    if (headerRead.bytesRead !== headerLength) return null
    const header = JSON.parse(headerBuffer.toString('utf8'))
    const meta = header.__metadata__ !== null && typeof header.__metadata__ === 'object' ? header.__metadata__ : {}
    return { meta, tensorCount: Math.max(0, Object.keys(header).length - 1) }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** ss_tag_frequency 是 {数据集: {标签: 次数}}；取全库出现最多的标签。 */
function topTrainingTags(raw, limit = 12) {
  if (typeof raw !== 'string' || raw === '') return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const totals = new Map()
  for (const dataset of Object.values(parsed)) {
    if (dataset === null || typeof dataset !== 'object') continue
    for (const [tag, count] of Object.entries(dataset)) {
      const name = tag.trim()
      if (name === '' || typeof count !== 'number') continue
      totals.set(name, (totals.get(name) ?? 0) + count)
    }
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }))
}

/**
 * 把头部元数据翻译成插件认识的字段。没有可识别信息时返回 null。
 */
export function describeSafetensorsHeader(meta) {
  if (meta === null || typeof meta !== 'object' || Object.keys(meta).length === 0) return null
  const baseModel = meta['ss_base_model_version'] || meta['modelspec.architecture'] || meta['ss_sd_model_name'] || null
  const title = meta['modelspec.title'] || meta['ss_output_name'] || null
  const triggerPhrase = typeof meta['modelspec.trigger_phrase'] === 'string' ? meta['modelspec.trigger_phrase'].trim() : ''
  const specTags = splitList(meta['modelspec.tags'] ?? '')
  const trainingTags = topTrainingTags(meta['ss_tag_frequency'])
  // 通用标签几乎出现在所有训练集里，不能当触发词；过滤掉后剩下的更可能是角色/风格词。
  const GENERIC_TAGS = new Set([
    '1girl', '1boy', '2girls', 'multiple girls', 'solo', 'solo focus', 'looking at viewer', 'long hair', 'short hair',
    'medium hair', 'ponytail', 'twintails', 'smile', 'blush', 'open mouth', 'closed mouth', 'breasts', 'large breasts',
    'swimsuit', 'bikini', 'dress', 'shirt', 'skirt', 'standing', 'sitting', 'simple background', 'white background',
    'masterpiece', 'best quality', 'high quality', 'absurdres', 'highres', 'long hair, ponytail',
  ])
  const tagCandidates = trainingTags
    .filter((entry) => !GENERIC_TAGS.has(entry.tag.toLowerCase().replace(/_/g, ' ')))
    .map((entry) => entry.tag.replace(/[，,、;；:：\s]+$/u, '').trim())
    .filter((tag) => tag !== '' && tag.length <= 40)
    .slice(0, 5)
  const dim = Number(meta['ss_network_dim'])
  const alpha = Number(meta['ss_network_alpha'])
  const result = {
    source: 'safetensors-header',
    baseModel,
    title,
    triggerWords: triggerPhrase === '' ? [] : splitList(triggerPhrase),
    triggerHints: [],
    tags: specTags.slice(0, 12),
    trainingTags,
    tagCandidates,
    networkDim: Number.isFinite(dim) && dim > 0 ? dim : null,
    networkAlpha: Number.isFinite(alpha) && alpha > 0 ? alpha : null,
    // LoRA 没有普适强度；0.8 是社区常用起点，来源里明确写了别的再覆盖。
    recommendedStrength: null,
    resolution: typeof meta['ss_resolution'] === 'string' ? meta['ss_resolution'] : null,
    clipSkip: meta['ss_clip_skip'] ?? null,
    numTrainImages: Number(meta['ss_num_train_images']) || null,
  }
  result.recommendedStrength = 0.8
  if (result.networkAlpha !== null && result.networkDim !== null && result.networkDim > 0) {
    result.alphaRatio = Number((result.networkAlpha / result.networkDim).toFixed(3))
  }
  const nothingUseful = [result.baseModel, result.title, result.triggerWords.length, result.tags.length, result.trainingTags.length, result.tagCandidates.length].every((value) => !value)
  return nothingUseful ? null : result
}

/** 路径 + 读取 + 翻译，失败一律当作"没有"（野生文件很多是坏的/非 safetensors）。 */
export async function inspectModelFile(filePath) {
  try {
    const parsed = await readSafetensorsHeader(filePath)
    return parsed === null ? null : describeSafetensorsHeader(parsed.meta)
  } catch {
    return null
  }
}
