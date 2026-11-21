// ComfyUI client for the DSH "AI 绘画" agent.
//
// Deliberately dependency-free (node builtins + global fetch) so it can be
// exercised with plain `node test/*.mjs` without the DSH runtime.
//
// Verified against the live ComfyUI 0.44.0 instance on 2026-11-06 via
// GET /object_info. Node/input names below are the ones ComfyUI actually
// advertises, not guesses:
//
//   classic : CheckpointLoaderSimple → CLIPTextEncode ×2 → EmptyLatentImage
//             → KSampler → VAEDecode → SaveImage
//   anima   : UNETLoader(unet_name, weight_dtype="default")
//             + CLIPLoader(clip_name=qwen_3_06b_base, type="stable_diffusion")
//             + VAELoader(qwen_image_vae) + CLIPTextEncode ×2
//             + EmptyLatentImage → KSampler(30/4/euler/simple) → VAEDecode → SaveImage
//             (turbo 版 8 步 / CFG 1)
//   krea2   : UnetLoaderGGUF(unet_name=krea2_turbo-Q4_K_M.gguf)     [ComfyUI-GGUF]
//             + CLIPLoader(qwen3vl_4b_fp8_scaled, type="krea2")
//             + VAELoader(qwen_image_vae)
//             + CLIPTextEncode(positive) + ConditioningZeroOut(positive)  ← 官方模板
//             + EmptyLatentImage → KSampler(8/1/euler/simple) → VAEDecode → SaveImage
//             … Krea-2 官方模板的负面分支是 ConditioningZeroOut，因为 CFG=1 时
//             negative 不参与计算；所以我们不做第二个文本编码（省时间/显存）。
//   moss    : UNETLoader(moss_image_sft_int8_convrot, weight_dtype="default")
//             + CLIPLoader(qwen3.5_9b_w4a8_gptq, type="moss_image")
//             + VAELoader(flux2-vae_small) + CLIPTextEncode pos/neg
//             + EmptyFlux2LatentImage ← 不是 EmptyLatentImage；宽高必须 16 的倍数
//             + KSampler(25/2.5/er_sde/simple) → VAEDecode → SaveImage
//             … 官方模板的 Prompt 扩写 LLM(TextGenerate) 与 SLG 第一版都不启用，
//             直接把用户 prompt 送进 CLIPTextEncode。
//
// The UI-format workflow templates (definitions.subgraphs[0].nodes) were used as
// the authoritative reference for these graphs; API graphs are assembled here
// from the live /object_info node definitions.

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendIndex, datePath, ensureRoot, imagePathFor, normalizeOutputRoot } from './output.js'
import { randomInt } from 'node:crypto'

// All defaults are environment-driven so a fresh checkout runs for any user:
//   COMFY_ORIGIN         ComfyUI HTTP API base
//   COMFY_MODELS_ROOT    optional models root; never guessed
//   COMFY_MODELS_ROOT    model files root
//   COMFY_OUTPUT_DIR     where generated images are downloaded
//   COMFY_WORKFLOWS_DIR  legacy workflow template dir
export const DEFAULT_ORIGIN = process.env.COMFY_ORIGIN || 'http://127.0.0.1:8188'
// 这里刻意不提供默认模型目录：ComfyUI 装在哪、模型放在哪都可能不同，
// 路径只能来自用户配置/环境变量，或由运行中的 ComfyUI 自报（见 discoverLayout）。
// 路径以 ComfyUI 自报为准：不再从环境变量推断模型根。
export const DEFAULT_MODELS_ROOT = null
export const DEFAULT_OUTPUT_DIR = process.env.COMFY_OUTPUT_DIR || path.join(os.homedir(), 'dsh-drawing', 'output')
export const DEFAULT_WORKFLOWS_DIR = process.env.COMFY_WORKFLOWS_DIR || path.join(os.homedir(), 'dsh-drawing', 'workflows')
export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_POLL_INTERVAL_MS = 1_000

/** Per-family description + defaults. `defaults` is merged over DEFAULTS. */
export const FAMILIES = {
  classic: {
    id: 'classic',
    label: '传统 SD Checkpoint',
    loader: 'CheckpointLoaderSimple',
    modelFolder: 'checkpoints',
    defaultModel: 'sd15-anylora-bakedvae-fp16.safetensors',
    description: 'SD1.5 checkpoint（AnyLoRA 二次元 / DreamShaper 通用写实）。出图最快。',
    defaults: {
      steps: 25,
      cfg: 7,
      sampler: 'euler',
      scheduler: 'normal',
      width: 768,
      height: 768,
      negative: 'lowres, bad anatomy, worst quality, low quality, blurry, jpeg artifacts',
    },
  },
  anima: {
    id: 'anima',
    label: 'Anima 2B 动漫/插画',
    loader: 'UNETLoader',
    modelFolder: 'diffusion_models',
    defaultModel: 'anima-aesthetic-v1.1.safetensors',
    textEncoder: 'qwen3-0.6b-base.safetensors',
    clipType: 'stable_diffusion',
    vae: 'qwen-image-vae.safetensors',
    description: 'Anima 2B 动漫插画模型（CLIPLoader type=stable_diffusion）。turbo 版 8 步 / CFG 1。',
    defaults: {
      steps: 30,
      cfg: 4,
      sampler: 'euler',
      scheduler: 'simple',
      width: 1024,
      height: 1024,
      negative: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia',
    },
  },
  krea2: {
    id: 'krea2',
    label: 'Krea-2 Turbo 12B (GGUF Q4)',
    loader: 'UnetLoaderGGUF',
    modelFolder: 'diffusion_models',
    defaultModel: 'krea2_turbo-Q4_K_M.gguf',
    textEncoder: 'qwen3vl-4b-fp8-scaled.safetensors',
    clipType: 'krea2',
    vae: 'qwen-image-vae.safetensors',
    description: 'Krea-2 Turbo 12B GGUF Q4 量化（ComfyUI-GGUF 的 UnetLoaderGGUF）。8 步 / CFG 1；CFG=1 时负面词不生效。',
    defaults: {
      steps: 8,
      cfg: 1,
      sampler: 'euler',
      scheduler: 'simple',
      width: 1024,
      height: 1024,
      negative: '',
    },
  },
  moss: {
    id: 'moss',
    label: 'MOSS-Image 5B (中英文字排版)',
    loader: 'UNETLoader',
    modelFolder: 'diffusion_models',
    defaultModel: 'moss-image-sft-int8-convrot.safetensors',
    textEncoder: 'qwen3.5-9b-w4a8-gptq.safetensors',
    clipType: 'moss_image',
    vae: 'flux2-vae-small.safetensors',
    description: 'MOSS-Image 5B，中英文排版/文字渲染强。负面前缀官方推荐 nsfw, worst quality, bad anatomy, watermark, jpeg artifact。',
    defaults: {
      steps: 25,
      cfg: 2.5,
      sampler: 'er_sde',
      scheduler: 'simple',
      width: 1024,
      height: 1024,
      negative: 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact',
    },
  },
  generic: {
    id: 'generic',
    label: '通用扩散模型（自备 CLIP + VAE）',
    loader: 'UNETLoader',
    modelFolder: 'diffusion_models',
    // 没有写死的伴生文件：调用方必须显式给 textEncoder 与 vae。
    requiresCompanions: true,
    description: '任意 UNET/扩散模型：必须同时给 textEncoder 与 vae（.gguf 自动走 UnetLoaderGGUF）。给装进来的、没有内置族的模型用。',
    defaults: {
      steps: 20,
      cfg: 3.5,
      sampler: 'euler',
      scheduler: 'simple',
      width: 1024,
      height: 1024,
      negative: 'low quality, worst quality, watermark',
    },
  },
}

/** Generic defaults; per-family FAMILIES[*].defaults are merged over these. */
export const DEFAULTS = {
  origin: DEFAULT_ORIGIN,
  modelsRoot: DEFAULT_MODELS_ROOT,
  outputDir: DEFAULT_OUTPUT_DIR,
  workflowsDir: DEFAULT_WORKFLOWS_DIR,
  family: 'classic',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  width: 1024,
  height: 1024,
  steps: 25,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'normal',
  negative: '',
  batch: 1,
  denoise: 1,
}

const FAMILY_IDS = Object.keys(FAMILIES)
const KNOWN_FAMILY = new Set(FAMILY_IDS)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function base(origin) {
  const value = String(origin || DEFAULT_ORIGIN).trim() || DEFAULT_ORIGIN
  return value.replace(/\/+$/, '')
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Local-time compact timestamp, e.g. 20261106-113500. */
function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

/** Local-time date folder, e.g. 2026-11-06. */
function dateFolder(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function errorDetail(error) {
  if (!error) return 'unknown error'
  const cause = error.cause
  const causeText = cause?.code || cause?.message
  return [error.message, causeText && causeText !== error.message ? `(${causeText})` : '']
    .filter(Boolean)
    .join(' ')
}

function shortJson(value, limit = 2_000) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

async function requestJson(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!response.ok) {
      const error = new Error(`ComfyUI HTTP ${response.status} ${url}: ${shortJson(data ?? text)}`)
      error.status = response.status
      error.data = data
      throw error
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODEL_NOTES = {
  'sd15-anylora-bakedvae-fp16.safetensors': '二次元 SD1.5 checkpoint（内置 VAE），用 CheckpointLoaderSimple 加载',
  'sd15-dreamshaper-8.safetensors': '通用写实 SD1.5 checkpoint，用 CheckpointLoaderSimple 加载',
  'anima-aesthetic-v1.1.safetensors': 'Anima 2B 美学版（推荐），CLIPLoader type=stable_diffusion，30 步 / CFG 4 / euler / simple',
  'anima-turbo-v1.1.safetensors': 'Anima 2B turbo 加速版，8 步 / CFG 1 / euler / simple',
  'krea2_turbo-Q4_K_M.gguf': 'Krea-2 Turbo 12B GGUF Q4（UnetLoaderGGUF），8 步 / CFG 1 / euler / simple',
  'moss-image-sft-int8-convrot.safetensors': 'MOSS-Image 5B SFT int8，25 步 / CFG 2.5 / er_sde / simple，官方模板用 EmptyFlux2LatentImage',
  'qwen3-0.6b-base.safetensors': 'Anima 文本编码器，CLIPLoader type=stable_diffusion',
  'qwen3vl-4b-fp8-scaled.safetensors': 'Krea-2 文本编码器，CLIPLoader type=krea2',
  'qwen3.5-9b-w4a8-gptq.safetensors': 'MOSS-Image 文本编码器，CLIPLoader type=moss_image',
  'qwen-image-vae.safetensors': 'Anima / Krea-2 共用 VAE',
  'flux2-vae-small.safetensors': 'MOSS-Image VAE（FLUX.2 small）',
}

const FOLDER_SPECS = [
  { folder: 'checkpoints', node: 'CheckpointLoaderSimple', field: 'ckpt_name', diskDir: 'checkpoints' },
  { folder: 'diffusion_models', node: 'UNETLoader', field: 'unet_name', diskDir: 'diffusion_models' },
  { folder: 'diffusion_models', node: 'UnetLoaderGGUF', field: 'unet_name', diskDir: 'diffusion_models' },
  { folder: 'text_encoders', node: 'CLIPLoader', field: 'clip_name', diskDir: 'text_encoders' },
  { folder: 'vae', node: 'VAELoader', field: 'vae_name', diskDir: 'vae' },
  { folder: 'loras', node: 'LoraLoaderModelOnly', field: 'lora_name', diskDir: 'lora' },
]

// ComfyUI exposes a few non-file pseudo entries in loader dropdowns.
const NON_FILE_MODEL_VALUES = new Set(['pixel_space'])

/** Infer the family from a model filename; unknown names fall back by folder. */
export function inferFamilyFromModel(name, folder) {
  if (!name) return folder === 'checkpoints' ? 'classic' : 'other'
  const value = String(name).toLowerCase()
  if (value.includes('krea2') || value.includes('krea-2')) return 'krea2'
  if (value.includes('moss')) return 'moss'
  if (value.includes('anima')) return 'anima'
  if (folder === 'checkpoints') return 'classic'
  if (value.includes('qwen3-0.6b') || value.includes('qwen_3_06b')) return 'anima'
  if (value.includes('qwen3vl-4b') || value.includes('qwen3vl_4b')) return 'krea2'
  if (value.includes('qwen3.5-9b') || value.includes('qwen3.5_9b')) return 'moss'
  if (value.includes('qwen-image-vae') || value.includes('qwen_image_vae')) return 'anima' // shared with krea2
  if (value.includes('flux2-vae')) return 'moss'
  return 'other'
}

function modelNotes(name, folder) {
  if (MODEL_NOTES[name]) return MODEL_NOTES[name]
  if (folder === 'loras') return 'LoRA；缺失时用 drawing_download 搜索并安装（自动落到 loras 目录）'
  return ''
}

function fileSizeGB(modelsRoot, diskDir, name) {
  if (typeof modelsRoot !== 'string' || modelsRoot === '') return null
  try {
    const file = path.join(modelsRoot, diskDir, name)
    const info = statSync(file)
    if (!info.isFile()) return null
    return round(info.size / 1024 ** 3, 2)
  } catch {
    return null
  }
}

/**
 * List the models ComfyUI actually exposes (via /object_info), annotated with
 * family + size + notes. Never throws for a missing optional folder.
 *
 * @param {string} [origin]
 * @param {{ modelsRoot?: string, objectInfoTimeoutMs?: number }} [options]
 * @returns {Promise<Array<{folder:string,name:string,family:string,sizeGB:number|null,notes:string}>>}
 */
export async function listModels(origin = DEFAULT_ORIGIN, options = {}) {
  const objectInfo = await requestJson(
    `${base(origin)}/object_info`,
    {},
    clampInt(options.objectInfoTimeoutMs, 1_000, 120_000, 60_000),
  )
  const modelsRoot = options.modelsRoot || DEFAULT_MODELS_ROOT || null
  const seen = new Set()
  const models = []
  for (const spec of FOLDER_SPECS) {
    const values = objectInfo?.[spec.node]?.input?.required?.[spec.field]?.[0]
    if (!Array.isArray(values)) continue
    for (const name of values) {
      if (typeof name !== 'string' || !name) continue
      if (NON_FILE_MODEL_VALUES.has(name)) continue
      const key = `${spec.folder}\u0000${name}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push({
        folder: spec.folder,
        name,
        family: inferFamilyFromModel(name, spec.folder),
        sizeGB: fileSizeGB(modelsRoot, spec.diskDir, name),
        notes: modelNotes(name, spec.folder),
      })
    }
  }
  const familyOrder = { classic: 0, anima: 1, krea2: 2, moss: 3, other: 4 }
  models.sort(
    (a, b) =>
      (familyOrder[a.family] ?? 9) - (familyOrder[b.family] ?? 9) ||
      a.folder.localeCompare(b.folder) ||
      a.name.localeCompare(b.name),
  )
  return models
}

// ---------------------------------------------------------------------------
// Layout discovery
// ---------------------------------------------------------------------------

/** ComfyUI 自己报告的目录表（/internal/folder_paths），按 origin 缓存。 */
const folderPathsCache = new Map()

/**
 * 问运行中的 ComfyUI：你的模型/节点目录在哪。
 * 老版本或非标准实现没有这个端点时返回 null，调用方退回配置值或默认猜测。
 * @returns {Promise<Record<string, string[]> | null>}
 */
export async function folderPaths(origin = DEFAULT_ORIGIN, options = {}) {
  const key = String(origin)
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : 60_000
  const hit = folderPathsCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < maxAgeMs) return hit.value
  let value = null
  try {
    const response = await fetch(`${base(origin)}/internal/folder_paths`, {
      signal: AbortSignal.timeout(Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5_000),
    })
    if (response.ok) {
      const parsed = await response.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
    }
  } catch {
    // 端点不存在/服务未启动：静默降级，下面由调用方处理 null。
  }
  folderPathsCache.set(key, { at: Date.now(), value })
  return value
}

/** 从 folder_paths 推出 ComfyUI 根与 models 根；推不出来就返回 null。 */
export async function discoverLayout(origin = DEFAULT_ORIGIN, options = {}) {
  const paths = await folderPaths(origin, options)
  if (paths === null) return null
  const dirsOf = (name) => (Array.isArray(paths[name]) ? paths[name].filter((item) => typeof item === 'string' && item !== '') : [])
  const modelParents = []
  for (const name of ['checkpoints', 'diffusion_models', 'vae', 'loras', 'text_encoders']) {
    for (const dir of dirsOf(name)) {
      const parent = path.dirname(dir)
      if (parent && parent !== '.' && !modelParents.includes(parent)) modelParents.push(parent)
    }
  }
  // 标准布局里模型目录的父目录就叫 models；额外路径（extra_model_paths.yaml）可能不在 ComfyUI 树下。
  const modelsRoot = modelParents.find((item) => /[\\/]models$/i.test(item)) ?? modelParents[0] ?? null
  const comfyRoot = modelsRoot === null ? null : path.dirname(modelsRoot)
  return {
    modelsRoot,
    comfyRoot,
    dirs: paths,
    /** 某个模型文件夹建议放的位置（用于错误提示）。 */
    suggestedDir: (name) => dirsOf(name)[0] ?? null,
  }
}

// ---------------------------------------------------------------------------
// Status / queue
// ---------------------------------------------------------------------------

function summarizeQueueItem(item) {
  if (!Array.isArray(item)) return { raw: shortJson(item, 300) }
  const [number, promptId, prompt, extraData] = item
  return {
    number: typeof number === 'number' ? number : null,
    promptId: typeof promptId === 'string' ? promptId : null,
    family: familyFromGraph(prompt),
    clientId: typeof extraData?.client_id === 'string' ? extraData.client_id : null,
  }
}

function familyFromGraph(graph) {
  if (!graph || typeof graph !== 'object') return null
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object') continue
    const inputs = node.inputs || {}
    const candidates = [inputs.ckpt_name, inputs.unet_name, inputs.clip_name, inputs.lora_name]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const family = inferFamilyFromModel(candidate)
      if (family !== 'other') return family
      if (node.class_type === 'CheckpointLoaderSimple') return 'classic'
    }
    if (node.class_type === 'CheckpointLoaderSimple') return 'classic'
    if (node.class_type === 'UnetLoaderGGUF') return 'krea2'
  }
  return null
}

/**
 * ComfyUI online status: version, VRAM, queue depth. Offline returns
 * `{ online: false, error }` instead of throwing.
 */
export async function status(origin = DEFAULT_ORIGIN) {
  const url = `${base(origin)}/system_stats`
  try {
    const stats = await requestJson(url, {}, 8_000)
    let queueRunning = 0
    let queuePending = 0
    let queueSummary = null
    try {
      const queueState = await requestJson(`${base(origin)}/queue`, {}, 8_000)
      queueRunning = Array.isArray(queueState?.queue_running) ? queueState.queue_running.length : 0
      queuePending = Array.isArray(queueState?.queue_pending) ? queueState.queue_pending.length : 0
      queueSummary = {
        running: (queueState?.queue_running || []).map(summarizeQueueItem),
        pending: (queueState?.queue_pending || []).map(summarizeQueueItem),
      }
    } catch {
      // Status must remain usable even if /queue is briefly unavailable.
    }
    const device = Array.isArray(stats?.devices) ? stats.devices[0] : undefined
    return {
      online: true,
      version: stats?.system?.comfyui_version ?? null,
      vramTotalGB: device?.vram_total ? round(device.vram_total / 1024 ** 3, 1) : null,
      vramFreeGB: device?.vram_free ? round(device.vram_free / 1024 ** 3, 1) : null,
      queueRunning,
      queuePending,
      queue: queueSummary,
      device: device?.name ?? null,
      url: base(origin),
    }
  } catch (error) {
    return { online: false, error: errorDetail(error), url: base(origin) }
  }
}

/**
 * Queue management.
 * @param {string} [origin]
 * @param {'status'|'interrupt'|'clear'} [action]
 */
export async function queue(origin = DEFAULT_ORIGIN, action = 'status') {
  const normalized = String(action || 'status').toLowerCase()
  if (normalized === 'status') {
    const state = await requestJson(`${base(origin)}/queue`, {}, 15_000)
    return {
      action: 'status',
      runningCount: Array.isArray(state?.queue_running) ? state.queue_running.length : 0,
      pendingCount: Array.isArray(state?.queue_pending) ? state.queue_pending.length : 0,
      running: (state?.queue_running || []).map(summarizeQueueItem),
      pending: (state?.queue_pending || []).map(summarizeQueueItem),
    }
  }
  if (normalized === 'interrupt') {
    await requestJson(
      `${base(origin)}/interrupt`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      15_000,
    )
    return { action: 'interrupt', ok: true, message: '已请求中断当前正在执行的任务（不会清空排队任务）。' }
  }
  if (normalized === 'clear') {
    await requestJson(
      `${base(origin)}/queue`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clear: true }) },
      15_000,
    )
    return { action: 'clear', ok: true, message: '已清空排队中的任务（正在执行的那一个不受影响）。' }
  }
  throw new Error(`queue action 必须是 status / interrupt / clear，收到: ${action}`)
}

// ---------------------------------------------------------------------------
// Parameter resolution
// ---------------------------------------------------------------------------

/** Recommended sampling/size defaults for a family (and turbo variant). */
export function recommendedParams(family = 'classic', model) {
  const id = normalizeFamily(family)
  const defaults = { ...DEFAULTS, ...FAMILIES[id].defaults }
  const result = {
    steps: defaults.steps,
    cfg: defaults.cfg,
    sampler: defaults.sampler,
    scheduler: defaults.scheduler,
    width: defaults.width,
    height: defaults.height,
    negative: defaults.negative,
  }
  if (id === 'anima' && typeof model === 'string' && /turbo/i.test(model)) {
    result.steps = 8
    result.cfg = 1
  }
  return result
}

function normalizeFamily(family) {
  if (family === undefined || family === null || family === '') return DEFAULTS.family
  const value = String(family).trim().toLowerCase()
  if (!KNOWN_FAMILY.has(value)) {
    throw new Error(`未知模型族 "${family}"；可选: ${FAMILY_IDS.join(' / ')}`)
  }
  return value
}

function inferRequestedFamily(family, model) {
  if (family !== undefined && family !== null && family !== '') return normalizeFamily(family)
  if (typeof model === 'string' && model.trim()) {
    const inferred = inferFamilyFromModel(model)
    if (KNOWN_FAMILY.has(inferred)) return inferred
  }
  return DEFAULTS.family
}

function resolveGenerateParams(params) {
  const raw = params && typeof params === 'object' ? params : {}
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) throw new Error('prompt 不能为空；请提供要生成的画面描述。')

  const modelOverride = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined
  const family = inferRequestedFamily(raw.family, modelOverride)
  const familyInfo = FAMILIES[family]
  // generic 没有默认模型，也没有默认伴生文件：三者都得显式给。
  if (family === 'generic') {
    for (const [key, label] of [['model', 'model'], ['textEncoder', 'textEncoder'], ['vae', 'vae']]) {
      if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
        throw new Error(`family=generic 需要显式提供 ${label}（通用的 UNET 图没有默认值）；用 drawing_models 查真实文件名。`)
      }
    }
  }
  const model = modelOverride || familyInfo.defaultModel
  const recommended = recommendedParams(family, model)
  const multiple = family === 'moss' ? 16 : 8

  const widthRaw = clampInt(raw.width, 64, 2048, recommended.width)
  const heightRaw = clampInt(raw.height, 64, 2048, recommended.height)
  const width = Math.max(multiple, Math.round(widthRaw / multiple) * multiple)
  const height = Math.max(multiple, Math.round(heightRaw / multiple) * multiple)
  const negative =
    typeof raw.negative === 'string' ? raw.negative : family === 'krea2' ? '' : recommended.negative

  const paramsResolved = {
    prompt,
    negative,
    family,
    model,
    width,
    height,
    steps: clampInt(raw.steps, 1, 150, recommended.steps),
    cfg: round(clampNumber(raw.cfg, 0, 30, recommended.cfg), 2),
    sampler: typeof raw.sampler === 'string' && raw.sampler.trim() ? raw.sampler.trim() : recommended.sampler,
    scheduler:
      typeof raw.scheduler === 'string' && raw.scheduler.trim() ? raw.scheduler.trim() : recommended.scheduler,
    seed: Number.isFinite(Number(raw.seed)) ? Math.max(0, Math.trunc(Number(raw.seed))) : randomInt(0, 2 ** 31 - 1),
    batch: clampInt(raw.batch, 1, 4, 1),
    denoise: round(clampNumber(raw.denoise, 0, 1, (raw.initImage || raw.initImageName) ? 0.6 : 1), 2),
    initImage: typeof raw.initImage === 'string' && raw.initImage.trim() ? raw.initImage.trim() : undefined,
    initImageName: typeof raw.initImageName === 'string' && raw.initImageName.trim() ? raw.initImageName.trim() : undefined,
    lora: normalizeLoraList(raw.lora),
    // 只有 generic 用得上；其它族忽略这两个字段。
    textEncoder: typeof raw.textEncoder === 'string' && raw.textEncoder.trim() ? raw.textEncoder.trim() : undefined,
    vae: typeof raw.vae === 'string' && raw.vae.trim() ? raw.vae.trim() : undefined,
    clipType: typeof raw.clipType === 'string' && raw.clipType.trim() ? raw.clipType.trim() : 'stable_diffusion',
    timeoutMs: clampInt(
      raw.timeoutMs ?? (raw.timeoutSeconds !== undefined ? Number(raw.timeoutSeconds) * 1000 : undefined),
      5_000,
      3_600_000,
      DEFAULTS.timeoutMs,
    ),
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir.trim() : DEFAULT_OUTPUT_DIR,
    modelsRoot: typeof raw.modelsRoot === 'string' && raw.modelsRoot.trim() ? raw.modelsRoot.trim() : DEFAULT_MODELS_ROOT,
  }
  return paramsResolved
}

/**
 * Normalize the lora argument: one entry or a stack.
 * Each entry: { name, strength, strengthClip? }.
 */
export function normalizeLoraList(lora) {
  if (!lora) return []
  const items = Array.isArray(lora) ? lora : [lora]
  const out = []
  for (const item of items) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name !== '') out.push({ name, strength: 1, strengthClip: 1 })
      continue
    }
    if (item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.trim() !== '') {
      const strength = round(clampNumber(item.strength ?? item.strengthModel, -10, 10, 1), 2)
      const strengthClip = round(clampNumber(item.strengthClip ?? item.strength, -10, 10, strength), 2)
      out.push({ name: item.name.trim(), strength, strengthClip })
      continue
    }
    throw new Error('lora 需要是模型名、{ name, strength }，或它们的数组（多 LoRA 会按顺序叠加）')
  }
  return out
}

/** Kept for callers that still pass a single lora. */
function normalizeLora(lora) {
  return normalizeLoraList(lora)[0]
}

// ---------------------------------------------------------------------------
// Workflow graph builders (API format: node_id -> { class_type, inputs })
// ---------------------------------------------------------------------------

function commonSampler({ modelRef, positive, negative, latent, seed, steps, cfg, sampler, scheduler, denoise }) {
  return {
    class_type: 'KSampler',
    inputs: {
      model: modelRef,
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      positive,
      negative,
      latent_image: latent,
      denoise,
    },
  }
}

/** 每类节点的输出槽（UI 工作流与链路校验共用）。 */
const NODE_OUTPUTS = {
  CheckpointLoaderSimple: [
    { name: 'MODEL', type: 'MODEL' },
    { name: 'CLIP', type: 'CLIP' },
    { name: 'VAE', type: 'VAE' },
  ],
  UNETLoader: [{ name: 'MODEL', type: 'MODEL' }],
  UnetLoaderGGUF: [{ name: 'MODEL', type: 'MODEL' }],
  CLIPLoader: [{ name: 'CLIP', type: 'CLIP' }],
  VAELoader: [{ name: 'VAE', type: 'VAE' }],
  LoraLoader: [
    { name: 'MODEL', type: 'MODEL' },
    { name: 'CLIP', type: 'CLIP' },
  ],
  CLIPTextEncode: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
  ConditioningZeroOut: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
  EmptyLatentImage: [{ name: 'LATENT', type: 'LATENT' }],
  EmptyFlux2LatentImage: [{ name: 'LATENT', type: 'LATENT' }],
  LoadImage: [
    { name: 'IMAGE', type: 'IMAGE' },
    { name: 'MASK', type: 'MASK' },
  ],
  VAEEncode: [{ name: 'LATENT', type: 'LATENT' }],
  KSampler: [{ name: 'LATENT', type: 'LATENT' }],
  VAEDecode: [{ name: 'IMAGE', type: 'IMAGE' }],
  SaveImage: [],
}

/** 需要按固定顺序写进 widgets_values 的字段（ComfyUI 的 UI 格式要求这个顺序）。 */
const NODE_WIDGETS = {
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  UnetLoaderGGUF: ['unet_name'],
  CLIPLoader: ['clip_name', 'type'],
  VAELoader: ['vae_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  CLIPTextEncode: ['text'],
  ConditioningZeroOut: [],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  LoadImage: ['image'],
  VAEEncode: [],
  KSampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  VAEDecode: [],
  SaveImage: ['filename_prefix'],
}

const NODE_SIZE = {
  SaveImage: [320, 300],
  KSampler: [320, 260],
  CheckpointLoaderSimple: [320, 100],
  LoraLoader: [320, 130],
  CLIPTextEncode: [420, 160],
  default: [280, 100],
}

/**
 * Turn the API graph into a ComfyUI UI workflow (the format the canvas loads and
 * the one embedded in saved PNGs), so a run is visible and re-openable there.
 */
export function toUiWorkflow(graph, { title = 'DSH drawing' } = {}) {
  const nodes = []
  const links = []
  const ids = Object.keys(graph).map(Number).sort((left, right) => left - right)
  const order = new Map(ids.map((id, index) => [id, index]))
  const inputName = new Map()
  const outputLink = new Map()
  const nodeById = new Map()

  for (const rawId of ids) {
    const node = graph[String(rawId)]
    const spec = NODE_OUTPUTS[node.class_type]
    if (spec === undefined) throw new Error(`UI 工作流不认识节点类型 ${node.class_type}`)
    const widgets = NODE_WIDGETS[node.class_type] ?? []
    const inputKeys = Object.entries(node.inputs ?? {})
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key)
    const ui = {
      id: rawId,
      type: node.class_type,
      pos: [40 + (order.get(rawId) % 4) * 360, 60 + Math.floor(order.get(rawId) / 4) * 260],
      size: NODE_SIZE[node.class_type] ?? NODE_SIZE.default,
      flags: {},
      order: order.get(rawId),
      mode: 0,
      inputs: inputKeys.map((key) => ({ name: key, type: null, link: null })),
      outputs: spec.map((output) => ({ name: output.name, type: output.type, links: [], slot_index: spec.indexOf(output) })),
      properties: { 'Node name for S&R': node.class_type },
      widgets_values: widgets.map((key) => node.inputs?.[key] ?? null),
      title,
    }
    nodes.push(ui)
    nodeById.set(rawId, ui)
    inputName.set(rawId, inputKeys)
    outputLink.set(rawId, ui.outputs.map(() => []))
  }

  let linkId = 1
  for (const rawId of ids) {
    const node = graph[String(rawId)]
    const ui = nodeById.get(rawId)
    const keys = inputName.get(rawId)
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(value)) continue
      const [sourceId, sourceSlot] = value
      const source = nodeById.get(Number(sourceId))
      if (source === undefined) throw new Error(`UI 工作流引用了不存在的节点 ${sourceId}`)
      const targetSlot = keys.indexOf(key)
      const type = NODE_OUTPUTS[graph[String(sourceId)].class_type][sourceSlot]?.type ?? null
      ui.inputs[targetSlot].type = type
      ui.inputs[targetSlot].link = linkId
      source.outputs[sourceSlot].links.push(linkId)
      links.push([linkId, Number(sourceId), sourceSlot, rawId, targetSlot, type])
      linkId += 1
    }
  }

  return {
    last_node_id: ids.length === 0 ? 0 : Math.max(...ids),
    last_link_id: linkId - 1,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { dsh: { generator: 'dsh-drawing-tools' } },
    version: 0.4,
  }
}

/**
 * Build the API-format graph for one family.
 *
 * LoRA: `p.lora` is an array accepted by normalizeLoraList; each entry becomes a
 * LoraLoader in order (MODEL and CLIP both chained), which is what ComfyUI's own
 * canvas produces when you stack LoRAs.
 *
 * @returns {{ graph: Record<string, {class_type: string, inputs: Record<string, unknown>}>, saveNodeId: string, prefix: string }}
 */
export function buildWorkflow(family, params) {
  const p = params
  // ComfyUI 自己那份也放进日期子目录，避免它的 output 根目录被平铺。
  const prefix = `dsh-drawing/${datePath()}/${p.stamp || timestamp()}_${p.family || family}`
  const graph = {}
  let nextId = 1
  const add = (class_type, inputs) => {
    const id = String(nextId)
    nextId += 1
    graph[id] = { class_type, inputs }
    return id
  }

  let modelRef
  let clipRef
  let vaeRef

  if (family === 'classic') {
    const loader = add('CheckpointLoaderSimple', { ckpt_name: p.model })
    modelRef = [loader, 0]
    clipRef = [loader, 1]
    vaeRef = [loader, 2]
  } else {
    const info = family === 'generic'
      ? { textEncoder: p.textEncoder, clipType: p.clipType || 'stable_diffusion', vae: p.vae }
      : FAMILIES[family]
    const useGguf = family === 'krea2' || (family === 'generic' && /\.gguf$/i.test(String(p.model ?? '')))
    const loader = useGguf
      ? add('UnetLoaderGGUF', { unet_name: p.model })
      : add('UNETLoader', { unet_name: p.model, weight_dtype: 'default' })
    const clip = add('CLIPLoader', { clip_name: info.textEncoder, type: info.clipType })
    const vae = add('VAELoader', { vae_name: info.vae })
    modelRef = [loader, 0]
    clipRef = [clip, 0]
    vaeRef = [vae, 0]
  }

  for (const entry of normalizeLoraList(p.lora)) {
    const id = add('LoraLoader', {
      model: modelRef,
      clip: clipRef,
      lora_name: entry.name,
      strength_model: entry.strength,
      strength_clip: entry.strengthClip,
    })
    modelRef = [id, 0]
    clipRef = [id, 1]
  }

  const positiveId = add('CLIPTextEncode', { text: p.prompt, clip: clipRef })
  const negativeRef = family === 'krea2'
    // Official Krea-2 template: no negative text encode, zero out the positive
    // conditioning because CFG=1 makes the unconditional branch unused.
    ? [add('ConditioningZeroOut', { conditioning: [positiveId, 0] }), 0]
    : [add('CLIPTextEncode', { text: p.negative, clip: clipRef }), 0]

  const latentClass = family === 'moss' ? 'EmptyFlux2LatentImage' : 'EmptyLatentImage'
  let latentRef = [add(latentClass, { width: p.width, height: p.height, batch_size: p.batch }), 0]

  if (p.initImageName) {
    const image = add('LoadImage', { image: p.initImageName })
    latentRef = [add('VAEEncode', { pixels: [image, 0], vae: vaeRef }), 0]
  }

  const samplerId = add('KSampler', {
    model: modelRef,
    seed: p.seed,
    steps: p.steps,
    cfg: p.cfg,
    sampler_name: p.sampler,
    scheduler: p.scheduler,
    positive: [positiveId, 0],
    negative: negativeRef,
    latent_image: latentRef,
    denoise: p.denoise,
  })
  const decodeId = add('VAEDecode', { samples: [samplerId, 0], vae: vaeRef })
  const saveNodeId = add('SaveImage', { images: [decodeId, 0], filename_prefix: prefix })

  return { graph, saveNodeId, prefix }
}

// ---------------------------------------------------------------------------
// ComfyUI submission / polling / download
// ---------------------------------------------------------------------------

function formatPromptRejection(data, httpStatus, rawText) {
  const lines = []
  const error = data && typeof data === 'object' ? data.error : undefined
  if (error) {
    lines.push(`${error.type || 'error'}: ${error.message || shortJson(error)}`)
    if (error.details) lines.push(`details: ${shortJson(error.details, 1_500)}`)
  }
  const nodeErrors = data && typeof data === 'object' ? data.node_errors : undefined
  if (nodeErrors && typeof nodeErrors === 'object') {
    for (const [nodeId, value] of Object.entries(nodeErrors)) {
      const nodeLabel = `${nodeId}${value?.class_type ? ` (${value.class_type})` : ''}`
      const errors = Array.isArray(value?.errors) ? value.errors : []
      const messages = errors.map(item => item?.message || item?.type || shortJson(item, 300))
      if (messages.length) lines.push(`节点 ${nodeLabel}: ${messages.join('; ')}`)
      else lines.push(`节点 ${nodeLabel}: ${shortJson(value, 500)}`)
    }
  }
  if (!lines.length) lines.push(shortJson(rawText ?? data, 2_000))
  const suffix = httpStatus && httpStatus >= 400 ? `（HTTP ${httpStatus}）` : ''
  return `ComfyUI 拒绝执行工作流${suffix}：\n${lines.join('\n')}`
}

async function submitPrompt(origin, graph, clientId, uiWorkflow = null) {
  // 带上 UI 版工作流：ComfyUI 会把它存进 PNG，拖回画布即可打开整张图；
  // 队列里的条目也带有同一份图。
  const body = { prompt: graph, client_id: clientId }
  if (uiWorkflow !== null) body.extra_data = { extra_pnginfo: { workflow: uiWorkflow } }
  const response = await fetch(`${base(origin)}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  if (!response.ok || (data && typeof data === 'object' && data.error)) {
    const error = new Error(formatPromptRejection(data, response.status, text))
    error.data = data
    throw error
  }
  if (!data || typeof data !== 'object' || typeof data.prompt_id !== 'string') {
    throw new Error(`ComfyUI /prompt 未返回 prompt_id: ${shortJson(data ?? text)}`)
  }
  return data
}

function formatHistoryError(entry) {
  const lines = []
  const messages = entry?.status?.messages
  if (Array.isArray(messages)) {
    for (const item of messages) {
      if (!Array.isArray(item)) continue
      const [type, data] = item
      if (type === 'execution_error') {
        const node = data?.node_id ? `节点 ${data.node_id}${data.node_type ? ` (${data.node_type})` : ''}` : ''
        lines.push(`${type}${node ? ` ${node}` : ''}: ${data?.exception_message || shortJson(data, 1_500)}`)
      } else if (type === 'execution_interrupted') {
        lines.push('执行被中断（execution_interrupted）')
      } else if (type !== 'execution_start' && type !== 'execution_cached') {
        lines.push(`${type}: ${shortJson(data, 800)}`)
      }
    }
  }
  if (!lines.length) lines.push(shortJson(entry?.status ?? entry, 2_000))
  return `ComfyUI 执行失败：\n${lines.join('\n')}`
}

function historyEntryDone(entry) {
  if (!entry || typeof entry !== 'object') return false
  const status = entry.status || {}
  if (status.completed === true) return true
  if (status.status_str === 'success') return true
  if (entry.outputs && Object.keys(entry.outputs).length && status.status_str !== 'error' && status.completed !== false) {
    return true
  }
  return false
}

function historyEntryFailed(entry) {
  if (!entry || typeof entry !== 'object') return false
  const status = entry.status || {}
  if (status.status_str === 'error') return true
  if (status.completed === false && status.status_str === 'error') return true
  const messages = Array.isArray(status.messages) ? status.messages : []
  return messages.some(item => Array.isArray(item) && item[0] === 'execution_error')
}

/**
 * Poll /history/{prompt_id} until completion, failure, or total timeout.
 * Returns `{ promptId, entry, seconds, timedOut }`; throws with ComfyUI's raw
 * error text on execution failure.
 */
async function waitForPrompt(origin, promptId, { timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const started = Date.now()
  const url = `${base(origin)}/history/${encodeURIComponent(promptId)}`
  for (;;) {
    const elapsed = Date.now() - started
    if (elapsed > timeoutMs) {
      return { promptId, entry: undefined, seconds: round(elapsed / 1000, 1), timedOut: true }
    }
    let entry
    try {
      const payload = await requestJson(url, {}, 20_000)
      entry = payload && typeof payload === 'object' ? payload[promptId] : undefined
    } catch (error) {
      // Transient network/HTTP blips while the job runs: keep waiting until the
      // total timeout, but remember the last error for the timeout message.
      entry = undefined
    }
    if (historyEntryFailed(entry)) {
      throw new Error(formatHistoryError(entry))
    }
    if (historyEntryDone(entry)) {
      return { promptId, entry, seconds: round((Date.now() - started) / 1000, 1), timedOut: false }
    }
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      return { promptId, entry: undefined, seconds: round((Date.now() - started) / 1000, 1), timedOut: true }
    }
    await delay(Math.min(pollIntervalMs, Math.max(250, remaining)))
  }
}

function viewUrl(origin, image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  })
  return `${base(origin)}/view?${params.toString()}`
}

/** Extract SaveImage outputs from a history entry, preserving node order. */
function extractImages(entry) {
  const outputs = entry?.outputs
  if (!outputs || typeof outputs !== 'object') return []
  const images = []
  for (const value of Object.values(outputs)) {
    if (!value || typeof value !== 'object') continue
    if (!Array.isArray(value.images)) continue
    for (const image of value.images) {
      if (image && typeof image.filename === 'string') {
        images.push({
          filename: image.filename,
          subfolder: image.subfolder || '',
          type: image.type || 'output',
        })
      }
    }
  }
  return images
}

async function downloadImage(origin, image, destination) {
  const response = await fetch(viewUrl(origin, image), { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    throw new Error(`下载 ComfyUI 图片失败 HTTP ${response.status}: ${image.filename}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  return { path: destination, bytes: bytes.length }
}

async function uploadInputImage(origin, filePath) {
  if (!existsSync(filePath)) throw new Error(`initImage 文件不存在: ${filePath}`)
  const info = statSync(filePath)
  if (!info.isFile()) throw new Error(`initImage 不是文件: ${filePath}`)
  const bytes = await readFile(filePath)
  const uploadName = `dsh_init_${Date.now()}_${path.basename(filePath).replace(/[^\w.-]+/g, '_')}`
  const form = new FormData()
  form.append('image', new Blob([bytes]), uploadName)
  form.append('overwrite', 'true')
  const response = await fetch(`${base(origin)}/upload/image`, { method: 'POST', body: form })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  if (!response.ok || !data?.name) {
    throw new Error(`上传 initImage 到 ComfyUI 失败（HTTP ${response.status}）: ${shortJson(data ?? text)}`)
  }
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
}

/**
 * 图生图的初始图：本机路径上传后成为 ComfyUI input 名，或直接给已在 input 里的名字。
 * 两条入口分开，写错的路径不会再被静默当成文件名。
 */
async function resolveInitImage(origin, initImage, initImageName) {
  if (typeof initImageName === 'string' && initImageName.trim()) return initImageName.trim()
  if (typeof initImage !== 'string' || !initImage.trim()) return undefined
  const candidate = path.resolve(initImage.trim())
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(`initImage 文件不存在: ${candidate}`)
  }
  return uploadInputImage(origin, candidate)
}

/** Write a sidecar JSON so history() can map ComfyUI prompts to local files. */
async function writeMeta(metaPath, meta) {
  try {
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  } catch {
    // Metadata is a convenience only; never fail a generation over it.
  }
}

/**
 * 把 UI 工作流写进 ComfyUI 的 Workflows 列表（/userdata/workflows）。
 * 失败不算错误：这是"在 ComfyUI 里能看见"的增强，不阻塞出图。
 * @returns {Promise<boolean>}
 */
async function saveUserWorkflow(origin, name, workflow) {
  try {
    // ComfyUI 的 userdata 路由要求整个 `workflows/<file>` 作为一个编码过的段：
    const response = await fetch(`${base(origin)}/userdata/${encodeURIComponent(`workflows/${name}`)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflow),
    })
    return response.ok
  } catch {
    return false
  }
}

/** UI 工作流构建失败时不影响出图：返回 null，调用方跳过。 */
function safeUiWorkflow(graph, title) {
  try {
    return toUiWorkflow(graph, { title })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

/**
 * Generate images from a prompt.
 *
 * @param {string} [origin] ComfyUI origin, e.g. http://127.0.0.1:8188
 * @param {object} params
 * @param {string} params.prompt required positive prompt
 * @param {string} [params.negative] negative prompt (krea2 ignores it when CFG=1)
 * @param {'classic'|'anima'|'krea2'|'moss'} [params.family] defaults to classic (or inferred from model)
 * @param {string} [params.model] model filename from drawing_models
 * @param {number} [params.width] default per family (multiple of 8, moss 16)
 * @param {number} [params.height]
 * @param {number} [params.steps]
 * @param {number} [params.cfg]
 * @param {string} [params.sampler]
 * @param {string} [params.scheduler]
 * @param {number} [params.seed]
 * @param {number} [params.batch] 1..4
 * @param {string|{name:string,strength?:number}} [params.lora]
 * @param {string} [params.initImage] local path (uploaded) or ComfyUI input name; enables img2img
 * @param {number} [params.denoise] 0..1, defaults 0.6 with initImage, else 1
 * @param {number} [params.timeoutMs] total wait budget, default 600000
 * @param {number} [params.timeoutSeconds] convenience alternative to timeoutMs
 * @param {string} [params.outputDir] override local output root
 * @returns {Promise<{promptId:string, images:Array<{path:string,filename:string,subfolder:string,url:string}>, family:string, model:string, params:object, seconds:number, timedOut?:boolean}>}
 */
export async function generate(origin = DEFAULT_ORIGIN, params = {}) {
  const resolved = resolveGenerateParams(params)
  const started = Date.now()
  const stamp = timestamp()
  const model = resolved.model
  const family = resolved.family
  const initImageName = await resolveInitImage(origin, resolved.initImage, resolved.initImageName)
  const built = buildWorkflow(family, { ...resolved, stamp, initImageName })
  const uiWorkflow = safeUiWorkflow(built.graph, built.prefix)
  const workflowName = `dsh-drawing-${stamp}.json`
  // 固定 client_id：ComfyUI 队列里能看出这是 DSH 提交的。
  const clientId = 'dsh-drawing-tools'
  const submitted = await submitPrompt(origin, built.graph, clientId, uiWorkflow)
  const promptId = submitted.prompt_id
  const workflowSaved = uiWorkflow !== null ? await saveUserWorkflow(origin, workflowName, uiWorkflow) : false

  const wait = await waitForPrompt(origin, promptId, {
    timeoutMs: resolved.timeoutMs,
    pollIntervalMs: DEFAULTS.pollIntervalMs,
  })
  if (wait.timedOut) {
    return {
      promptId,
      images: [],
      family,
      model,
      params: publicParams(resolved),
      seconds: wait.seconds,
      timedOut: true,
      origin: base(origin),
      clientId,
      workflowName,
      workflowSaved,
      message: `等待超时（${Math.round(resolved.timeoutMs / 1000)}s），任务仍在 ComfyUI 队列/执行中（ComfyUI 的 Queue 面板与画布都能看到它）。可稍后用 drawing_queue / drawing_history 查询，promptId=${promptId}`,
    }
  }

  const remoteImages = extractImages(wait.entry)
  if (!remoteImages.length) {
    throw new Error(
      `ComfyUI 已完成但没有返回图片（promptId=${promptId}）：${shortJson(wait.entry?.outputs ?? wait.entry, 2_000)}`,
    )
  }

  const outRoot = normalizeOutputRoot(resolved.outputDir) || DEFAULT_OUTPUT_DIR
  await ensureRoot(path.join(outRoot, datePath()))
  const images = []
  for (let index = 0; index < remoteImages.length; index += 1) {
    const image = remoteImages[index]
    // 规范路径：<root>/<YYYY>/<MM>/<DD>/<HHMMSS>_<family>_<模型slug>_s<seed>_<序号>.png
    const slot = imagePathFor({ root: outRoot, family, model, seed: resolved.seed, index: index + 1 })
    await mkdir(slot.directory, { recursive: true })
    const destination = slot.path
    const downloaded = await downloadImage(origin, image, destination)
    const imageRecord = {
      path: downloaded.path,
      filename: image.filename,
      subfolder: image.subfolder,
      url: viewUrl(origin, image),
      bytes: downloaded.bytes,
    }
    images.push(imageRecord)
    const record = {
      promptId,
      family,
      model,
      createdAt: new Date().toISOString(),
      seconds: wait.seconds,
      localPath: downloaded.path,
      remote: { filename: image.filename, subfolder: image.subfolder, type: image.type },
      params: publicParams(resolved),
      comfyUrl: base(origin),
      workflowName,
      source: 'generate',
    }
    await writeMeta(`${destination}.json`, record)
    // 总索引：所有生成在一处可查（JSONL，追加写，不会因并发丢数据）。
    await appendIndex(outRoot, record)
  }

  return {
    promptId,
    images,
    family,
    model,
    params: publicParams(resolved),
    seconds: round((Date.now() - started) / 1000, 1),
    queueSeconds: wait.seconds,
    clientId,
    origin: base(origin),
    workflowName,
    workflowSaved,
    uiWorkflow,
    outputDir: `${outRoot}/${datePath()}`,
  }
}

function publicParams(resolved) {
  const params = {
    prompt: resolved.prompt,
    negative: resolved.negative,
    width: resolved.width,
    height: resolved.height,
    steps: resolved.steps,
    cfg: resolved.cfg,
    sampler: resolved.sampler,
    scheduler: resolved.scheduler,
    seed: resolved.seed,
    batch: resolved.batch,
    denoise: resolved.denoise,
  }
  if (resolved.lora) params.lora = resolved.lora
  if (resolved.initImage) params.initImage = resolved.initImage
  return params
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function collectLocalMeta(root) {
  const found = []
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await readFile(entryPath, 'utf8'))
        if (meta && typeof meta.promptId === 'string' && meta.localPath) {
          found.push({ ...meta, metaPath: entryPath })
        }
      } catch {
        // ignore malformed sidecars
      }
    }
  }
  await walk(root)
  return found
}

/**
 * Recent completed ComfyUI jobs (newest first) plus any locally downloaded
 * files that can be matched through their sidecar metadata.
 *
 * @param {string} [origin]
 * @param {number} [limit]
 * @param {{ outputDir?: string }} [options]
 */
export async function history(origin = DEFAULT_ORIGIN, limit = 20, options = {}) {
  const maxItems = clampInt(limit, 1, 100, 20)
  const payload = await requestJson(`${base(origin)}/history?max_items=${maxItems}`, {}, 30_000)
  const entries = payload && typeof payload === 'object' ? Object.entries(payload) : []
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR
  const localMeta = await collectLocalMeta(outputDir)
  const byPrompt = new Map()
  for (const meta of localMeta) {
    if (!byPrompt.has(meta.promptId)) byPrompt.set(meta.promptId, [])
    byPrompt.get(meta.promptId).push(meta)
  }

  const records = entries.map(([promptId, entry]) => {
    const images = extractImages(entry)
    const local = byPrompt.get(promptId) || []
    const merged = images.map(image => {
      const match = local.find(item => item.remote?.filename === image.filename)
      return {
        filename: image.filename,
        subfolder: image.subfolder,
        url: viewUrl(origin, image),
        path: match?.localPath && existsSync(match.localPath) ? match.localPath : null,
      }
    })
    const number = Array.isArray(entry?.prompt) && typeof entry.prompt[0] === 'number' ? entry.prompt[0] : null
    const localFirst = local[0]
    return {
      promptId,
      number,
      family: localFirst?.family ?? familyFromGraph(entry?.prompt?.[2]) ?? null,
      model: localFirst?.model ?? null,
      seconds: localFirst?.seconds ?? null,
      createdAt: localFirst?.createdAt ?? (Array.isArray(entry?.prompt) ? null : null),
      images: merged.length
        ? merged
        : local.map(item => ({
            filename: item.remote?.filename ?? path.basename(item.localPath),
            subfolder: item.remote?.subfolder ?? '',
            url: item.remote?.filename
              ? viewUrl(origin, { filename: item.remote.filename, subfolder: item.remote.subfolder })
              : null,
            path: existsSync(item.localPath) ? item.localPath : null,
          })),
      status: entry?.status?.status_str ?? (entry?.status?.completed ? 'success' : null),
    }
  })
  records.sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
  return records.slice(0, maxItems)
}

// ---------------------------------------------------------------------------
// Saved workflows
// ---------------------------------------------------------------------------

function isApiWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value)
  if (!entries.length) return false
  return entries.every(node => node && typeof node === 'object' && typeof node.class_type === 'string')
}

/**
 * List *.json files under drawing/workflows.
 * @param {{ workflowsDir?: string }} [options]
 */
export async function listWorkflows(options = {}) {
  const root = options.workflowsDir || DEFAULT_WORKFLOWS_DIR
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const workflows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const filePath = path.join(root, entry.name)
    let info
    try {
      info = statSync(filePath)
    } catch {
      continue
    }
    let format = 'invalid'
    let nodeCount = null
    try {
      const text = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(text)
      if (isApiWorkflow(parsed)) {
        format = 'api'
        nodeCount = Object.keys(parsed).length
      } else if (Array.isArray(parsed?.nodes)) {
        format = 'ui'
        nodeCount = parsed.nodes.length
      }
    } catch {
      format = 'invalid'
    }
    workflows.push({
      name: entry.name,
      path: filePath,
      sizeKB: round(info.size / 1024, 1),
      modifiedAt: info.mtime.toISOString(),
      format,
      nodeCount,
    })
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name))
  return workflows
}

/**
 * Run a saved API-format workflow JSON (or a parsed API graph).
 *
 * UI-format workflow JSON (a `nodes` array) is rejected with a clear message;
 * convert it with ComfyUI's "Export (API)" first.
 *
 * @param {string} [origin]
 * @param {object|string} graph API graph object, JSON string, or path to a .json file
 * @param {{ timeoutMs?: number, outputDir?: string, filenamePrefix?: string, name?: string, download?: boolean, workflowsDir?: string }} [options]
 */
export async function runWorkflow(origin = DEFAULT_ORIGIN, graph, options = {}) {
  let parsed = graph
  let sourceName = options.name || 'workflow'
  if (typeof graph === 'string') {
    const trimmed = graph.trim()
    const candidate = path.resolve(trimmed)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      sourceName = path.basename(candidate, path.extname(candidate))
      parsed = JSON.parse(await readFile(candidate, 'utf8'))
    } else {
      parsed = JSON.parse(trimmed)
    }
  }
  if (!isApiWorkflow(parsed)) {
    if (Array.isArray(parsed?.nodes)) {
      throw new Error('这是 ComfyUI 的 UI 格式工作流，不是 API 格式。请用 ComfyUI 的 “导出 (API)” 得到 API 格式 JSON 后再运行。')
    }
    throw new Error('工作流不是有效的 API 格式（应为 { "节点ID": { "class_type": ..., "inputs": ... } }）')
  }

  const runUiWorkflow = safeUiWorkflow(parsed, `dsh-workflow-${sourceName}`)
  const runClientId = 'dsh-drawing-tools'
  const submitted = await submitPrompt(origin, parsed, runClientId, runUiWorkflow)
  const promptId = submitted.prompt_id
  const wait = await waitForPrompt(origin, promptId, {
    timeoutMs: clampInt(options.timeoutMs, 5_000, 3_600_000, DEFAULTS.timeoutMs),
    pollIntervalMs: DEFAULTS.pollIntervalMs,
  })
  const remoteImages = wait.entry ? extractImages(wait.entry) : []
  if (wait.timedOut) {
    return { promptId, images: [], seconds: wait.seconds, timedOut: true, name: sourceName }
  }
  if (!remoteImages.length) {
    throw new Error(`工作流执行完成但没有输出图片（promptId=${promptId}）：${shortJson(wait.entry?.outputs, 2_000)}`)
  }
  if (options.download === false) {
    return { promptId, seconds: wait.seconds, name: sourceName, images: remoteImages.map(image => viewUrl(origin, image)) }
  }
  const stamp = timestamp()
  const runRoot = normalizeOutputRoot(options.outputDir) || DEFAULT_OUTPUT_DIR
  await ensureRoot(path.join(runRoot, datePath()))
  const images = []
  for (let index = 0; index < remoteImages.length; index += 1) {
    const image = remoteImages[index]
    // 和 generate 用同一套规范：日期目录 + 时间_workflow_工作流名_序号。
    const slot = imagePathFor({ root: runRoot, family: 'workflow', model: sourceName, seed: 0, index: index + 1 })
    await mkdir(slot.directory, { recursive: true })
    const downloaded = await downloadImage(origin, image, slot.path)
    const imageRecord = { ...image, path: downloaded.path, url: viewUrl(origin, image), bytes: downloaded.bytes }
    images.push(imageRecord)
    const record = {
      promptId,
      family: 'workflow',
      model: sourceName,
      createdAt: new Date().toISOString(),
      seconds: wait.seconds,
      localPath: downloaded.path,
      remote: { filename: image.filename, subfolder: image.subfolder, type: image.type },
      params: { workflow: sourceName },
      comfyUrl: base(origin),
      source: 'workflow',
    }
    await writeMeta(`${downloaded.path}.json`, record)
    await appendIndex(runRoot, record)
  }
  return { promptId, images, seconds: wait.seconds, name: sourceName, clientId: runClientId, origin: base(origin) }
}
