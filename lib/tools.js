// Model-facing tools for local ComfyUI drawing.
//
// Only mounted in the "极简绘画" preset (dsh-drawing-minimal, preset id
// `drawing-minimal`); this bundle no longer declares its own agent. All eight
// tools are prefixed `drawing_` so they read unambiguously in the tool list.
//
// Design notes:
//   - drawing_generate / drawing_workflow are NOT concurrency safe: a 12B model
//     on a 16 GB GPU must not run twice in parallel. The executor skips parallel
//     grouping for them; read-only tools stay safe to overlap.
//   - Every returned image path is absolute, and the render text explicitly
//     returns a native Markdown image line the model pastes into its answer.
//   - The ComfyUI HTTP layer lives in ./comfy-client.js and has no DSH imports,
//     so it can be tested with plain node scripts.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as comfy from './comfy-client.js'
import * as civitai from './civitai.js'
import * as hf from './huggingface.js'
import * as install from './install.js'
import * as safe from './safetensors.js'
import { normalizeOutputRoot } from './output.js'
import * as modeldocs from './modeldocs.js'
import * as hardware from './hardware.js'
import { detectLaunch } from './launch.js'
import {
  attachmentHash,
  captureStoreStatus,
  defaultImageRoots,
  findCapturedByName,
  findImageByName,
  inspectImageMetadata,
  parseA1111Parameters,
  readCapturedRecipe,
  sha256Hex,
  summarizeComfyPrompt,
  summarizeWorkflow,
} from './pnginfo.js'

export const name = 'dsh-drawing-tools/tools'
export const inject = ['tools']

const FAMILY_IDS = ['classic', 'anima', 'krea2', 'moss', 'generic']
/** 不属于模型族、但按同一入口读取的额外指南。 */
const EXTRA_GUIDE_IDS = ['prompt-patterns']
// Official-usage guides shipped with the bundle: read at model-use time by
// `drawing_guide`, so the persona does not have to carry ~20 KB of prompt rules.
const GUIDES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'guides')
const GUIDE_FILES = {
  classic: 'classic.md',
  anima: 'anima.md',
  krea2: 'krea2.md',
  moss: 'moss.md',
  generic: 'generic.md',
}
const MODEL_KINDS = ['checkpoints', 'diffusion_models', 'loras', 'vae', 'text_encoders']
const KIND_OF_FOLDER = { checkpoints: 'checkpoint', diffusion_models: 'diffusion_model', loras: 'lora', vae: 'vae', text_encoders: 'text_encoder' }
const MODEL_KIND_LABELS = {
  checkpoints: 'checkpoints（CheckpointLoaderSimple）',
  diffusion_models: 'diffusion_models（UNETLoader / UnetLoaderGGUF）',
  text_encoders: 'text_encoders（CLIPLoader）',
  vae: 'vae（VAELoader）',
  loras: 'loras（LoraLoaderModelOnly）',
}
const FAMILY_LABELS = {
  classic: 'classic = SD1.5 checkpoint（最快，默认）',
  anima: 'anima = Anima 2B 动漫/插画',
  krea2: 'krea2 = Krea-2 Turbo 12B GGUF（8 步，较慢）',
  moss: 'moss = MOSS-Image 5B（中英文排版，较慢）',
  other: 'other = 未归类',
}

/**
 * 会话的生效目录。优先用官方的 workingDirectory 服务（它能反映 set() 过的目录、
 * 目录消失后的恢复，以及 access 监听）；服务不可用时退回会话头里记录的 cwd。
 */
let workingDirectoryService = null
/** 凭据服务（可选）：Civitai token 只从这里/环境变量取，永不进配置或提示词。 */
let credentialsService = null
/** 当前 bundle 的 ctx：凭据服务按需现取，见 credentialsNow()。 */
let activeContext = null
/**
 * 凭据服务每次现取。它可能在 bundle 挂载之后才由凭据扩展注册，也可能在热重载时
 * 被换成新实例；只在 apply() 里抓一次，会让之后所有下载静默退回环境变量，
 * 表现就是"设置里明明显示已配置，工具却报 401"。
 */
const credentialsNow = () => activeContext?.get?.('credentials') ?? credentialsService
/** 其它可选服务同理：可能在挂载后才注册，也可能在热重载时被替换。 */
const serviceNow = (name, fallback) => activeContext?.get?.(name) ?? fallback
/** 泛搜索用 DSH 的 web 服务（可选）；没有它就让调用方改用 web_search 工具。 */
let webService = null
/** 配置编辑器与当前插件行：drawing_paths({ action: 'adopt' }) 用它把真实路径写回配置。 */
let configEditorService = null
let pluginEntry = null
function cwdFor(exec) {
  const session = exec?.agent?.session
  if (session !== undefined && session !== null) {
    try {
      const viaService = serviceNow('workingDirectory', workingDirectoryService)?.get?.(session)
      if (typeof viaService === 'string' && viaService !== '') return viaService
    } catch {
      // 服务抛错（例如已销毁）时退回记录值，不要因为取目录失败而让工具失败。
    }
    const recorded = session?.header?.cwd
    if (typeof recorded === 'string' && recorded !== '') return recorded
  }
  return process.cwd()
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

// Tool outputs must be lossless JSON. The executor snapshots every result and
// rejects anything that would not survive a JSON round trip unchanged:
// `undefined` entries (JSON.stringify drops them), `NaN` / `Infinity` / `-0`
// (not representable), class instances and sparse arrays (not plain data).
// `execute()` results are built from optional tool arguments, so `undefined`
// keys are the normal case — snapshot through JSON so a result can never
// violate that boundary by construction.
export function jsonSafe(value) {
  if (value === undefined) return {}
  const text = JSON.stringify(value)
  return text === undefined ? {} : JSON.parse(text)
}

function fmtParams(params) {
  const bits = [
    `${params.width}×${params.height}`,
    `${params.steps} 步`,
    `CFG ${params.cfg}`,
    `${params.sampler}/${params.scheduler}`,
    `seed ${params.seed}`,
    `batch ${params.batch}`,
  ]
  if (params.denoise !== 1) bits.push(`denoise ${params.denoise}`)
  for (const entry of Array.isArray(params.lora) ? params.lora : params.lora ? [params.lora] : []) {
    if (entry?.name) bits.push(`LoRA ${displayModelName(entry.name)}:${entry.strength}`)
  }
  if (params.initImage) bits.push('img2img')
  return bits.join('，')
}

/** Model-facing form of a model/lora name: forward slashes need no JSON escaping. */
function displayModelName(name) {
  return typeof name === 'string' ? name.replace(/\\/g, '/') : name
}

/**
 * Parse the `lora` argument. Accepts "name", "name:strength", "name@strength",
 * or `{ name, strength }`, and normalizes backslashes to "/" so the value can
 * be copied into JSON without escaping (Windows source paths break raw JSON).
 * @param {unknown} value
 * @returns {{ name: string, strength: number } | null}
 */
/**
 * ComfyUI's model/LoRA enum values keep the platform separator (Windows uses
 * \\), while model-facing text uses "/" so JSON needs no escaping. Convert
 * back right before submitting a prompt.
 * @param {unknown} name
 * @returns {unknown}
 */
export function toComfyName(name) {
  if (typeof name !== 'string') return name
  return process.platform === 'win32' ? name.replace(/\//g, '\\') : name
}

export function parseLoraArg(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const match = /^(.+)[:@]([-+]?\d+(?:\.\d+)?)$/.exec(trimmed)
    if (match) return { name: match[1].replace(/\\/g, '/'), strength: Number(match[2]) }
    return { name: trimmed.replace(/\\/g, '/'), strength: 1 }
  }
  if (value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim()) {
    const strength = Number(value.strength)
    const strengthClip = Number(value.strengthClip)
    return {
      name: value.name.trim().replace(/\\/g, '/'),
      strength: Number.isFinite(strength) ? strength : 1,
      ...(Number.isFinite(strengthClip) ? { strengthClip } : {}),
    }
  }
  return null
}

/**
 * Parse the lora argument into an ordered list. A single string/object yields
 * one entry; an array stacks them in order (model and clip both chained).
 */
export function parseLorasArg(value) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of items) {
    const parsed = parseLoraArg(item)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * Map short LoRA tags (e.g. from a ComfyUI prompt chunk) to real file names
 * under `<modelsRoot>/loras`. Returns the original tag when no file matches.
 * @param {string} modelsRoot
 * @param {Array<{ name: string, strength: number }>} loras
 * @returns {Array<{ name: string, strength: number, display: string, resolved: boolean }>}
 */
function resolveLoraNames(modelsRoot, loras) {
  if (!Array.isArray(loras) || !loras.length) return []
  const roots = comfy.toRootArray(modelsRoot)
  // 模型根未知（ComfyUI 离线且没配置）：不解析文件，原样展示。
  if (roots.length === 0) {
    return loras.map(entry => ({ ...entry, display: entry.name, resolved: false }))
  }
  const files = new Map()
  const walk = (directory, root, depth) => {
    if (depth > 4 || files.size > 5000) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.size > 5000) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full, root, depth + 1)
        continue
      }
      if (!/\.(safetensors|ckpt|pt|pth|bin)$/i.test(entry.name)) continue
      const relative = path.relative(root, full).split(path.sep).join('/')
      const base = entry.name.replace(/\.[^.]+$/, '').toLowerCase()
      if (!files.has(base)) files.set(base, relative)
    }
  }
  // ComfyUI's models/loras can be a junction to a differently named directory
  // (for example loras -> a folder named lora); accept both and keep the path
  // relative to the loras root, which is what LoraLoaderModelOnly expects.
  for (const root of roots) {
    walk(path.join(root, 'lora'), path.join(root, 'lora'), 0)
    walk(path.join(root, 'loras'), path.join(root, 'loras'), 0)
  }
  return loras.map(lora => {
    const raw = String(lora.name ?? '').replace(/\\/g, '/')
    const base = path.basename(raw).replace(/\.[^.]+$/, '').toLowerCase()
    const resolved = files.get(base) ?? files.get(raw.toLowerCase())
    return { ...lora, display: resolved ?? raw, resolved: Boolean(resolved) }
  })
}

function fmtSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '?'
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒` : `${seconds}秒`
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text
}

/**
 * 原生内联：DSH 的聊天渲染会把「百分号编码的绝对路径」当成本机图片，通过
 * /api/file 鉴权路由取字节，不需要任何额外的图片插件。
 */
function localImageMarkdown(file, alt) {
  const cleanAlt = String(alt ?? '').replace(/[[\]<>]/g, ' ').replace(/\s+/g, ' ').trim()
  return `![${cleanAlt || 'image'}](<${encodeURIComponent(file)}>)`
}

function listImagesForModel(images) {
  if (!Array.isArray(images) || !images.length) return []
  return images.flatMap(image => [
    `  - ${image.path}${image.bytes ? `（${(image.bytes / 1024).toFixed(0)} KiB）` : ''}`,
    `    内联（原样放进回复）：${localImageMarkdown(image.path, path.basename(image.path))}`,
  ])
}

function generateHint() {
  return '下一步：把上面每张图的「内联」Markdown 行原样放进回复（DSH 原生渲染本机图片路径），不要只回复路径文本。'
}

function toolError(prefix, error) {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`${prefix}${detail}`)
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

/** 在线时：把 ComfyUI 实际用的设备和本机检测对一下，CPU 跑就明确警告。 */
function onlineHardwareLines(state, hw) {
  const lines = []
  const device = String(state.device ?? '')
  const vendor = hardware.classifyVendor(device)
  const rec = hardware.recommendFor({ vendor, vramGB: state.vramTotalGB, platform: hw.platform })
  const primary = hw.primary
  const label = vendor === 'none' ? 'CPU' : vendor === 'unknown' ? '未知厂商' : vendor
  lines.push(`硬件: ${label}${primary?.name ? `（${primary.name}）` : ''}`)
  if (device.toLowerCase().includes('cpu')) {
    lines.push('⚠ ComfyUI 正在用 CPU 运行，出图会很慢。检查是否装错构建（A 卡要用 ROCm/DirectML 版，不是 CUDA 版），或启动参数里是不是带了 --cpu。')
  }
  if (rec.notes.length > 0) lines.push(`建议: ${rec.flavor} 构建；启动参数 ${rec.args.join(' ')}（仅作参考，实际取决于已装构建）`)
  return lines
}

/** 离线时：先让用户知道自己的卡该装什么，这是"不懂行"最容易卡住的一步。 */
function offlineHardwareLines(hw) {
  const lines = ['硬件（本机检测）:']
  if (hw.gpus.length === 0) {
    lines.push(`- ${hw.error ?? '没检测到显卡'}；如果是无独显机器，只能用 CPU（很慢）。`)
    return lines
  }
  // 有独显时不要拿核显去误导用户。
  const shown = hw.gpus.some((gpu) => Number.isFinite(gpu.vramGB) && gpu.vramGB >= 2)
    ? hw.gpus.filter((gpu) => Number.isFinite(gpu.vramGB) && gpu.vramGB >= 2)
    : hw.gpus
  for (const gpu of shown) {
    const rec = hardware.recommendFor({ vendor: gpu.vendor, vramGB: gpu.vramGB, platform: hw.platform })
    lines.push(`- ${gpu.name}${gpu.vramGB ? `（约 ${gpu.vramGB} GB）` : ''} → ${rec.flavor} 构建；参数 ${rec.args.join(' ')}`)
    for (const note of rec.notes) lines.push(`  ${note}`)
  }
  return [...lines, '']
}

function statusTool(settings) {
  return defineTool({
    name: 'drawing_status',
    description:
      '检查 ComfyUI 是否在线、版本、设备、显存与队列，并报告模型目录来源、启动配置与各模型族的可用文件。开始生成前、换机器后或生成失败排错时先调用；离线时它会给出缺什么、下一步怎么做。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, online: { type: 'boolean' }, version: { type: 'string' }, vramTotalGB: { type: 'number' }, vramFreeGB: { type: 'number' }, queueRunning: { type: 'number' }, queuePending: { type: 'number' }, families: { type: 'array' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => true,
    execute: async () => {
      const state = await comfy.status(settings.origin)
      const hw = await hardware.detectHardware()
      // 离线时不去问目录表（那会白等一个连不上的服务），直接用配置值+存在性检查。
      // 体检要读"现在"的目录：新装的模型/改过的路径立刻可见，不吃一分钟缓存。
      const layout = state.online
        ? await resolveLayout(settings, { fresh: true })
        : {
            modelsRoot: settings.modelsRoot,
            comfyRoot: settings.comfyRoot,
            source: settings.modelsRootConfigured ? 'config' : 'none',
            modelsRootExists: existsSync(settings.modelsRoot),
            comfyRootExists: existsSync(settings.comfyRoot),
            discovered: null,
          }
      const launch = settings.launch ?? {}
      const launchConfigured = launch.enabled !== false && typeof launch.command === 'string' && launch.command.trim() !== ''
      const launchDetected = detectLaunch({ comfyRoot: layout.comfyRoot, modelsRoot: layout.modelsRoot })
      const launchHint = launchConfigured
        ? `已配置自动启动：${launch.command}`
        : launchDetected.ok
          ? `可自动启动（${launchDetected.source}）：${launchDetected.command}（cwd ${launchDetected.cwd}）`
          : `未找到可自动启动的 ComfyUI：${launchDetected.reason}。可手动运行，或 drawing_setup({ action: 'apply', comfyDir: '<ComfyUI 目录>' }) 写配置`
      const sourceLabel = layout.source === 'config'
        ? '配置/环境变量'
        : layout.source === 'discovered'
          ? 'ComfyUI /internal/folder_paths'
          : '未知'
      const layoutLine = layout.modelsRoot === null
        ? '目录: 未知（未配置 comfyRoot/modelsRoot，ComfyUI 也没有报告目录表）'
        : `目录: models 根 = ${layout.modelsRoot}${layout.modelRoots.length > 1 ? `（另有 ${layout.modelRoots.length - 1} 个额外根）` : ''}（来源：${sourceLabel}）`
      const layoutHint = layout.modelsRoot === null
        ? '缺目录不影响出图（模型名来自 ComfyUI），只影响文件大小显示、本地找图与把配方存进 ComfyUI 目录；装上模型后重跑本工具即可自动读到，或显式配置 comfyRoot / modelsRoot。'
        : null
      if (!state.online) {
        const steps = [
          `ComfyUI 离线（${state.url}）：${state.error}`,
          '',
          ...offlineHardwareLines(hw),
          '先解决连接，再出图：',
          `1. 装了但没启动：${launchHint}。手动启动就在 ComfyUI 目录运行 \`python main.py\`。`,
          '2. 没装 ComfyUI：先从 https://github.com/comfyanonymous/ComfyUI 安装（自带便携包或 pip 都行），启动后应监听 127.0.0.1:8188。',
          '3. 不在本机或不是 8188：改插件行 config.origin（或环境变量 COMFY_ORIGIN），例如 http://192.168.1.10:8188。',
          '4. 版本较老：/internal/folder_paths 不可用时，模型目录要靠 config.comfyRoot / modelsRoot 指定，其余功能不受影响。',
          '',
          '不要在没有连上之前调用 drawing_generate。',
        ]
        return {
          text: steps.join('\n'),
          // 离线也要把结构化字段填满：调用方不该靠"字段缺失"来猜状态。
          online: false,
          setup: {
            origin: settings.origin,
            online: false,
            comfyRoot: layout.comfyRoot,
            modelsRoot: layout.modelsRoot,
            modelsRootSource: layout.source,
            launchConfigured,
            missing: ['comfy-unreachable'],
          },
        }
      }
      let models = []
      let modelsError = null
      try {
        models = await comfy.listModels(settings.origin, { modelsRoot: layout.modelRoots, dirs: layout.discovered?.dirs ?? null })
      } catch (error) {
        modelsError = error instanceof Error ? error.message : String(error)
      }
      const families = FAMILY_IDS.map(family => {
        const entries = family === 'generic'
          ? models.filter(model => model.folder === 'diffusion_models' && !['anima', 'krea2', 'moss'].includes(model.family))
          : models.filter(model => model.family === family)
        return {
          family,
          label: comfy.FAMILIES[family].label,
          models: entries.map(model => model.name),
          recommended: comfy.recommendedParams(family),
        }
      })
      const lines = [
        `ComfyUI: 在线，v${state.version}（${state.url}）`,
        state.device ? `设备: ${state.device}` : null,
        `显存: ${state.vramFreeGB ?? '?'} / ${state.vramTotalGB ?? '?'} GB 可用`,
        ...onlineHardwareLines(state, hw),
        `队列: 运行 ${state.queueRunning}，等待 ${state.queuePending}`,
        layoutLine,
        layoutHint,
        `启动: ${launchHint}`,
      ].filter(line => line !== null)
      if (modelsError) {
        lines.push(`模型清单获取失败: ${modelsError}`)
      } else {
        lines.push('模型族:')
        for (const family of families) {
          lines.push(`- ${family.family}（${family.label}）: ${family.models.length ? family.models.join('、') : '无可用模型'}`)
        }
      }
      lines.push(
        state.queueRunning > 0
          ? '建议: 队列非空，先等待或用 drawing_queue 查看；也可以直接提交（ComfyUI 会排队）。'
          : '建议: 直接调用 drawing_generate；不确定模型时先调用 drawing_models。',
      )
      lines.push('写提示词前：按族调用 drawing_guide({ family }) 读官方用法（anima / krea2 / moss 必读，classic 可跳过）。')
      // 路径对账：配置 vs ComfyUI 自报。改过 ComfyUI 路径但配置没跟上时，这里直接指出。
      lines.push('路径:')
      lines.push(`- 输出根: ${settings.outputDir}（图按 <年>/<月>/<日>/ 分目录，根下 index.jsonl 是总索引）`)
      lines.push(`- models 根: ${layout.modelsRoot ?? '未知'}${layout.source === 'discovered' ? '（ComfyUI 自报）' : layout.source === 'config' ? '（配置）' : ''}`)
      if (layout.modelsRootMismatch && layout.configuredModelsRoot) {
        lines.push(`  ⚠ 配置的 modelsRoot（${layout.configuredModelsRoot}）与 ComfyUI 自报（${layout.discovered?.modelsRoot ?? '无'}）不一致，已按自报值；用 drawing_paths({ action: 'adopt' }) 同步配置。`)
      }
      if (layout.comfyRootMismatch && layout.configuredComfyRoot) {
        lines.push(`  ⚠ 配置的 comfyRoot（${layout.configuredComfyRoot}）与 ComfyUI 自报（${layout.discovered?.comfyRoot ?? '无'}）不一致，已按自报值。`)
      }
      lines.push(`- API 工作流目录: ${apiWorkflowsDirFor(settings, layout)}`)
      lines.push(`- UI 工作流目录: ${uiWorkflowsDirFor(settings, layout)}`)
      return {
        text: lines.join('\n'),
        online: true,
        version: state.version,
        vramTotalGB: state.vramTotalGB,
        vramFreeGB: state.vramFreeGB,
        queueRunning: state.queueRunning,
        queuePending: state.queuePending,
        families,
        paths: {
          outputDir: settings.outputDir,
          modelsRoot: layout.modelsRoot,
          configuredModelsRoot: layout.configuredModelsRoot,
          modelsRootMismatch: layout.modelsRootMismatch,
          comfyRoot: layout.comfyRoot,
          configuredComfyRoot: layout.configuredComfyRoot,
          comfyRootMismatch: layout.comfyRootMismatch,
          apiWorkflowsDir: apiWorkflowsDirFor(settings, layout),
          uiWorkflowsDir: uiWorkflowsDirFor(settings, layout),
        },
        setup: {
          origin: settings.origin,
          online: true,
          comfyRoot: layout.comfyRoot,
          modelsRoot: layout.modelsRoot,
          modelsRootSource: layout.source,
          launchConfigured,
          familiesWithoutModels: families.filter(family => family.models.length === 0).map(family => family.family),
        },
      }
    },
  })
}

/**
 * 一个已安装文件的"自带说明书"：读 .safetensors 头。野生 LoRA 没有来源记录，
 * 但 kohya / ModelSpec 常把基模、触发短语、训练标签写在头里。
 */
async function headerInfoFor(layout, folder, name) {
  const kind = KIND_OF_FOLDER[folder]
  if (kind === undefined) return null
  const directory = install.installDir(kind, layout)
  if (directory === null) return null
  const relative = String(name).split(/[\\/]+/).join(path.sep)
  return safe.inspectModelFile(path.join(directory, relative))
}

/** Civitai 用 trainedWords，Hugging Face 用 triggerWords；展示层统一读这里。 */
const triggerWordsOf = (meta) => (Array.isArray(meta?.trainedWords) ? meta.trainedWords : Array.isArray(meta?.triggerWords) ? meta.triggerWords : [])
const triggerAlternativesOf = (meta) => (Array.isArray(meta?.triggerAlternatives) ? meta.triggerAlternatives : [])
const triggerHintsOf = (meta) => (Array.isArray(meta?.triggerHints) ? meta.triggerHints : [])

/** 一行可读的触发词说明：词组、备选、描述提示三种形态分开写。 */
function describeTriggerWords(meta) {
  const words = triggerWordsOf(meta)
  const alternatives = triggerAlternativesOf(meta)
  const hints = triggerHintsOf(meta)
  const parts = []
  if (words.length > 0) parts.push(`触发词: ${words.join(', ')}（${words.length} 个，默认一起用）`)
  if (alternatives.length > 0) parts.push(`备选触发词: ${alternatives.join(' / ')}（选其中一组）`)
  if (hints.length > 0) parts.push(`描述里的触发提示: ${hints[0].slice(0, 120)}`)
  return parts
}

/**
 * 一个模型文件能用什么参数画出来。checkpoint 走 classic；四族模型走本族；
 * 其余扩散模型只能走 generic（需要自备 textEncoder + vae）；LoRA/VAE/编码器只是零件。
 */
function usageOf(model) {
  if (model.folder === 'loras') return { kind: 'lora', label: '作为 drawing_generate 的 lora 参数使用', family: null }
  if (model.folder === 'vae') return { kind: 'vae', label: '作为 family=generic 的 vae 参数使用', family: null }
  if (model.folder === 'text_encoders') return { kind: 'text_encoder', label: '作为 family=generic 的 textEncoder 参数使用', family: null }
  if (model.folder === 'checkpoints') return { kind: 'checkpoint', label: `drawing_generate({ family: 'classic', model: '${model.name}' })`, family: 'classic' }
  if (FAMILY_IDS.includes(model.family) && model.family !== 'generic') {
    return { kind: 'diffusion_model', label: `drawing_generate({ family: '${model.family}', model: '${model.name}' })`, family: model.family }
  }
  return { kind: 'diffusion_model', label: `需要 self 备 textEncoder + vae：drawing_generate({ family: 'generic', model: '${model.name}', textEncoder: '<文件>', vae: '<文件>' })`, family: 'generic' }
}

function modelsTool(settings) {
  return defineTool({
    name: 'drawing_models',
    description:
      '列出 ComfyUI 实际可用的模型、所属模型族、大小与建议采样参数。不确定该用哪个族或模型、或要确认 LoRA/VAE/文本编码器是否存在时调用。',
    parameters: {
      kind: {
        type: 'string',
        enum: MODEL_KINDS,
        description: '按模型目录过滤：checkpoints / diffusion_models / text_encoders / vae / loras；省略返回全部。',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, models: { type: 'array' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => true,
    execute: async args => {
      const layout = await resolveLayout(settings)
      const models = await comfy.listModels(settings.origin, { modelsRoot: layout.modelRoots, dirs: layout.discovered?.dirs ?? null })
      // 安装记录里有触发词/基础模型/来源；离线也能读，读不到就当没有。
      const provenance = new Map()
      for (const folder of MODEL_KINDS) {
        const kind = KIND_OF_FOLDER[folder]
        const directory = install.installDir(kind, layout)
        if (directory === null) continue
        for (const [fileName, record] of await install.readProvenance(directory)) provenance.set(`${folder}/${fileName}`, record)
      }
      const withMeta = model => {
        const record = provenance.get(`${model.folder}/${model.name}`)
        const meta = record?.metadata ?? null
        return {
          ...model,
          usage: usageOf(model),
          source: record?.source ?? null,
          modelName: meta?.modelName ?? null,
          baseModel: meta?.baseModel ?? null,
          triggerWords: triggerWordsOf(meta),
          triggerAlternatives: triggerAlternativesOf(meta),
          triggerHints: triggerHintsOf(meta),
          pageUrl: meta?.pageUrl ?? null,
        }
      }
      const filtered = (args.kind ? models.filter(model => model.folder === args.kind) : models).map(withMeta)
      // 没有来源元数据的文件（野生的、手动拷进来的）读文件头，绕过一次网络。
      let headerReads = 0
      for (const model of filtered) {
        if (model.source !== null || model.triggerWords.length > 0 || headerReads >= 40) continue
        const header = await headerInfoFor(layout, model.folder, model.name)
        headerReads += 1
        if (header === null) continue
        model.header = header
        model.baseModel = model.baseModel ?? header.baseModel ?? null
        model.triggerWords = header.triggerWords.length > 0 ? header.triggerWords : model.triggerWords
        model.trainingTags = header.trainingTags
      }
      const lines = [
        args.kind ? `模型目录 ${MODEL_KIND_LABELS[args.kind]}（${filtered.length} 个）：` : `ComfyUI 可用模型（${filtered.length} 个）：`,
        '',
      ]
      if (!filtered.length) {
        lines.push('（空）')
        if (args.kind === 'loras') lines.push("loras 目录没有文件。需要 LoRA 时用 drawing_download({ action: 'search', query: '<关键词>', kind: 'lora' })，选中后 action: 'download' 会自动装到 loras 目录；再用 drawing_models 复核；找不到就告诉用户并停止。")
      }
      let currentFolder = null
      for (const model of filtered) {
        if (model.folder !== currentFolder) {
          currentFolder = model.folder
          lines.push(`## ${MODEL_KIND_LABELS[currentFolder] || currentFolder}`)
        }
        const familyLabel = model.family === 'other' ? 'other' : `${model.family}（${comfy.FAMILIES[model.family].label}）`
        const size = model.sizeGB === null ? '大小未知' : `${model.sizeGB} GB`
        const usage = model.usage ?? usageOf(model)
        const triggerParts = describeTriggerWords({ trainedWords: model.triggerWords, triggerAlternatives: model.triggerAlternatives, triggerHints: model.triggerHints })
        const trigger = triggerParts.length ? ` | ${triggerParts.join(' | ')}` : ''
        const base = model.baseModel ? ` | 基模: ${model.baseModel}` : ''
        const training = model.trainingTags?.length ? ` | 训练标签: ${model.trainingTags.slice(0, 6).map((entry) => entry.tag).join(', ')}` : ''
        const candidates = model.header?.tagCandidates?.length ? ` | 候选触发词: ${model.header.tagCandidates.join(', ')}` : ''
        if (model.triggerWords.length === 0 && model.header?.tagCandidates?.length) model.triggerWords = model.header.tagCandidates
        const strength = model.header?.recommendedStrength ? ` | 建议强度: ${model.header.recommendedStrength}` : ''
        lines.push(`- ${displayModelName(model.name)} | ${familyLabel} | ${size} | 用法: ${usage.label}${base}${training}${candidates}${strength}${trigger}`)
        if (model.notes) lines.push(`  ${model.notes}`)
        if (FAMILY_IDS.includes(model.family) && ['checkpoints', 'diffusion_models'].includes(model.folder)) {
          const rec = comfy.recommendedParams(model.family, model.name)
          lines.push(
            `  推荐: steps=${rec.steps} cfg=${rec.cfg} sampler=${rec.sampler} scheduler=${rec.scheduler} ${rec.width}×${rec.height}`,
          )
        }
      }
      lines.push('', '用法: 把上面的名字原样传给 drawing_generate 的 model / lora 参数（目录分隔符显示为 /，JSON 里照抄即可）；family 不传时按模型名自动推断。')
      lines.push('写提示词前先读该族官方用法: drawing_guide({ family })（anima / krea2 / moss 必读）。')
      return { text: lines.join('\n'), models: filtered }
    },
  })
}

function guideTool(settings) {
  const readGuide = fileName => readFileSync(path.join(GUIDES_DIR, fileName), 'utf8')
  return defineTool({
    name: 'drawing_guide',
    description:
      '读取模型用法说明：传 model 时优先返回该模型自带的官方文档（安装时从 Hugging Face / Civitai 捕获、或本地导入、或模型旁边的 .md）；否则返回该模型族的指南。写 anima / krea2 / moss 的提示词之前必须先调用；不传任何参数返回指南索引。',
    parameters: {
      family: {
        type: 'string',
        enum: [...FAMILY_IDS, ...EXTRA_GUIDE_IDS],
        description: '模型族，或 prompt-patterns（提示词模板库，含各族实测模板与负面词包）。返回对应指南全文；省略返回索引。',
      },
      model: {
        type: 'string',
        description: '模型文件名。给了就先找这个模型的官方文档（.dsh-docs 里已保存的，或模型旁边的 .md），找到就返回它；没有则退回族指南。',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, family: { type: 'string' }, model: { type: 'string' }, source: { type: 'string' }, path: { type: 'string' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => true,
    execute: async rawArgs => {
      let docMiss = false
      const family = rawArgs?.family
      const modelArg = typeof rawArgs?.model === 'string' ? rawArgs.model.trim() : ''
      if (modelArg !== '') {
        const layout = await resolveLayout(settings)
        // 1) 已保存的官方文档
        const saved = await modeldocs.readDoc(layout.modelsRoot, { modelName: modelArg })
        if (saved !== null) {
          return {
            text: `${saved.title} 的官方文档（来源: ${saved.source}${saved.url ? `，${saved.url}` : ''}；抓取于 ${saved.fetchedAt}）。按它使用这个模型；文档没覆盖的参数再按族指南。\n\n${saved.text}`,
            model: modelArg,
            source: saved.source,
            path: path.join(saved.dir, 'README.md'),
          }
        }
        // 2) 模型文件旁边的 .md（手动放进来的模型）
        const kind = KIND_OF_FOLDER[guessFolderForModel(modelArg)] ?? 'lora'
        const directory = install.installDir(kind, layout)
        if (directory !== null) {
          const local = await modeldocs.findLocalDocs(path.join(directory, String(modelArg).split(/[\\/]+/).join(path.sep)))
          if (local !== null) {
            return {
              text: `${modelArg} 旁边的本地说明（${local.sources.join('、')}）。按它使用；没有覆盖的部分再按族指南。\n\n${local.text}`,
              model: modelArg,
              source: 'local',
              path: local.sources[0],
            }
          }
        }
        // 3) 没有文档：有 family 就回退，没有就明确报错并给获取方式
        if (!family) {
          throw new Error(`没有找到 ${modelArg} 的官方文档。可以 drawing_guide({ family }) 先读族指南，或 drawing_modeldoc({ action: 'fetch', repo / versionId }) 抓取官方文档。`)
        }
        docMiss = true
      }
      if (!family) {
        const text = readGuide('README.md')
        return { text: `${text}`, family: 'index', path: path.join(GUIDES_DIR, 'README.md') }
      }
      const guideFile = GUIDE_FILES[family] ?? (EXTRA_GUIDE_IDS.includes(family) ? family + '.md' : null)
      if (guideFile === null) {
        throw new Error(`未知指南 "${family}"；可选：${[...FAMILY_IDS, ...EXTRA_GUIDE_IDS].join(' / ')}（省略 family 看索引）。`)
      }
      const file = path.join(GUIDES_DIR, guideFile)
      if (!existsSync(file)) throw new Error(`缺少 "${family}" 的用法指南文件：${file}`)
      const body = readGuide(guideFile)
      const missNote = docMiss
        ? '（没有找到这个模型自己的官方文档，先按族指南执行；需要时用 drawing_modeldoc 抓取。）\n\n'
        : ''
      return {
        text: `${missNote}以下是 family=${family} 的官方用法指南。写提示词、定尺寸/参数前按它执行；与工具返回的推荐值冲突时以工具为准。\n\n${body}`,
        family,
        path: file,
      }
    },
  })
}

function generateTool(settings) {
  return defineTool({
    name: 'drawing_generate',
    description:
      '用本地 ComfyUI 生成图片并返回 PNG 绝对路径。生成后把返回的内联 Markdown 行放进回复给用户看图。写 anima / krea2 / moss 的提示词前先调用 drawing_guide 读该族用法。单张约 5 秒到 4 分钟；等待超时会返回 promptId 供继续查询。',
    parameters: {
      prompt: { type: 'string', required: true, description: '正向提示词。建议英文；MOSS-Image 支持中英文排版。' },
      negative: { type: 'string', description: '负向提示词；省略则用该模型族推荐值。krea2 的 CFG=1，负面词不生效。' },
      family: {
        type: 'string',
        enum: FAMILY_IDS,
        description:
          '模型族，默认 classic。classic=SD1.5 checkpoint 最快；anima=Anima 2B 动漫（Danbooru tag，画师加 @）；krea2=Krea-2 12B GGUF（长自然语言，CFG=1 负面词无效）；moss=MOSS-Image 5B（自然语言长句，文字加引号，宽高 16 的倍数）。不传且指定 model 时按模型名推断；族内细节先调 drawing_guide。',
      },
      model: { type: 'string', description: '模型文件名（取 drawing_models 返回的 name）。省略时自动选本机该族第一个可用模型；该族没有任何模型时会报错并给出应放入的目录。' },
      width: {
        type: 'integer',
        description: '像素宽；圆整到 8 的倍数（moss 为 16）。默认 classic 768，其余 1024；大模型建议不超过 1024。',
      },
      height: { type: 'integer', description: '像素高；规则同 width。' },
      steps: {
        type: 'integer',
        description: '采样步数；省略用族推荐值（classic 25 / anima 30（turbo 8）/ krea2 8 / moss 25）。',
      },
      cfg: { type: 'number', description: 'CFG scale；省略用族推荐值（classic 7 / anima 4 / krea2 1 / moss 2.5）。' },
      sampler: {
        type: 'string',
        description: '采样器名；省略用族推荐（classic/anima/krea2 为 euler，moss 为 er_sde）。',
      },
      scheduler: {
        type: 'string',
        description: '调度器名；省略用族推荐（classic 为 normal，其余为 simple）。',
      },
      seed: { type: 'integer', description: '随机种子；省略随机。相同参数 + 相同种子可复现。' },
      batch: { type: 'integer', description: '一次生成张数 1–4，默认 1；显存有限，512×512 以上建议保持 1。' },
      lora: {
        oneOf: [
          { type: 'string', description: 'LoRA 文件名，或 "name:strength" / "name@strength"（例如 "style:0.8"）。名字取 drawing_models 的 name，可含 / 子目录。' },
          {
            type: 'array',
            description: '多个 LoRA 按顺序叠加（model 与 clip 都会串起来）。每项是 { name, strength, strengthClip? }，name 必填。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                strength: { type: 'number' },
                strengthClip: { type: 'number' },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true, description: 'LoRA 文件名（loras 目录内）。' },
              strength: { type: 'number', description: 'LoRA 强度，默认 1。' },
            },
            description: 'LoRA 文件名 + 强度。',
          },
        ],
        description:
          'LoRA 文件名，或 "name:strength" / "name@strength"，或 { name, strength }；名字取 drawing_models 的 name（可含 / 子目录）。缺文件时用当前可用的 shell 下载，用 pwsh 调 https://civitai.red/api/v1/models?query=<关键词>&types=LORA 搜索并下载到 models root（COMFY_MODELS_ROOT）下的 loras 目录，再重试。',
      },
      initImage: {
        type: 'string',
        description: '图生图初始图片的**本机路径**（绝对路径，或相对会话目录）。文件不存在会直接报错，不会当成文件名用；已在 ComfyUI input 目录里的文件请改用 initImageName。提供后走 img2img。',
      },
      textEncoder: { type: 'string', description: 'text encoder / CLIP 文件名，只有 family=generic 需要（其它族用各自固定值）；名字取 drawing_models({ kind: "text_encoders" })。' },
      vae: { type: 'string', description: 'VAE 文件名，只有 family=generic 需要；名字取 drawing_models({ kind: "vae" })。' },
      clipType: { type: 'string', description: 'family=generic 时 CLIPLoader 的 type，默认 stable_diffusion；模型需要别的类型时显式给。' },
      initImageName: {
        type: 'string',
        description: '已在 ComfyUI input 目录中的图片文件名（例如 dsh_init_...png）。与 initImage 二选一。',
      },
      denoise: { type: 'number', description: '重绘强度 0–1；提供 initImage 时默认 0.6，否则默认 1。' },
      timeoutSeconds: {
        type: 'integer',
        description: '总等待上限（秒），默认 600，最大 3600。超时返回 promptId，可用 drawing_queue / drawing_history 继续查询。',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, promptId: { type: 'string' }, images: { type: 'array' }, family: { type: 'string' }, model: { type: 'string' }, params: { type: 'object', additionalProperties: true }, seconds: { type: 'number' }, timedOut: { type: 'boolean' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const cwd = settings.cwdOf(exec)
      const initImageArg = typeof args.initImage === 'string' ? args.initImage.trim() : ''
      const initImageNameArg = typeof args.initImageName === 'string' ? args.initImageName.trim() : ''
      if (initImageArg && initImageNameArg) {
        throw new Error('initImage（本机路径）和 initImageName（ComfyUI input 文件名）只能给一个。')
      }
      let initImage
      if (initImageArg) {
        initImage = path.resolve(cwd, initImageArg)
        if (!existsSync(initImage)) {
          throw new Error(`initImage 不存在：${initImage}（本机路径按会话目录解析；如果它是 ComfyUI input 里的文件名，请改用 initImageName）`)
        }
        if (!statSync(initImage).isFile()) throw new Error(`initImage 不是文件：${initImage}`)
      }
      const initImageName = initImageNameArg || undefined
      // 多 LoRA：数组按顺序叠加；单个字符串/对象仍兼容。
      const loras = parseLorasArg(args.lora).map((entry) => ({ ...entry, name: toComfyName(entry.name) }))
      const layout = await resolveLayout(settings)
      const familyId = args.family ?? 'classic'
      const familyInfo = comfy.FAMILIES[familyId]
      if (familyInfo === undefined) throw new Error(`未知模型族 "${familyId}"；可选：${Object.keys(comfy.FAMILIES).join(' / ')}。`)
      let liveModels = null
      const loadModels = async () => {
        if (liveModels === null) liveModels = await comfy.listModels(settings.origin, { modelsRoot: layout.modelRoots, dirs: layout.discovered?.dirs ?? null })
        return liveModels
      }
      // 目录只来自 ComfyUI 自报或用户配置；两者都没有时不要编一个路径出来。
      const suggestDir = (folder) => layout.discovered?.suggestedDir?.(folder)
        ?? (layout.modelsRoot ? path.join(layout.modelsRoot, folder) : null)
      const whereToPut = (folder) => {
        const target = suggestDir(folder)
        return target === null
          ? `ComfyUI 的 ${folder} 目录（让 ComfyUI 运行起来可自动读到路径，或在插件行 config.comfyRoot/modelsRoot 指定）`
          : target
      }
      // 多 LoRA：先按 ComfyUI 真实文件名核对，缺文件时现在就说清楚，而不是等 /prompt 报 Value not in list。
      if (loras.length > 0) {
        const liveLoras = (await loadModels()).filter((model) => model.folder === 'loras')
        const byNormalized = new Map(liveLoras.map((model) => [model.name.replace(/\\/g, '/').toLowerCase(), model.name]))
        for (const entry of loras) {
          const key = entry.name.replace(/\\/g, '/').toLowerCase()
          const exact = byNormalized.get(key)
          if (exact === undefined) {
            throw new Error(`LoRA 不存在：${entry.name}（ComfyUI 里没有同名文件；先 drawing_models({ kind: 'loras' }) 核对，或用 drawing_download 安装）`)
          }
          // 用 ComfyUI 的原始写法（Windows 下是反斜杠）。
          entry.name = exact
        }
      }
      let modelArg = toComfyName(args.model)
      if (!modelArg) {
        // 不写死默认模型名：选这台机器上真实存在的第一个该族模型。
        // generic 没有家族归属，any diffusion model 都可以，交给调用方显式指定；
        // 这里仍然兜底选第一个 diffusion model，避免"必须问模型名"的死循环。
        const candidates = familyId === 'generic'
          ? (await loadModels()).filter(model => model.folder === 'diffusion_models')
          : (await loadModels()).filter(model => model.family === familyId && (model.folder === 'checkpoints' || model.folder === 'diffusion_models'))
        if (candidates.length === 0) {
          throw new Error(
            `family=${familyId} 在这台机器的 ComfyUI 里没有可用模型。\n` +
            `把该族模型放进 ${whereToPut(familyInfo.modelFolder)}（例如 ${familyInfo.defaultModel}），` +
            '或用 drawing_models 看现有文件后显式传 model。',
          )
        }
        modelArg = candidates[0].name
      }
      // 伴生文件（text encoder / VAE）按族固定，缺了 ComfyUI 会报难懂的错误，这里提前说清。
      // generic 由调用方显式给（客户端已校验），不再套用族固定值。
      const companionChecks = familyId === 'generic' ? [] : [['textEncoder', 'text_encoders', 'text encoder'], ['vae', 'vae', 'VAE']]
      for (const [key, folder, label] of companionChecks) {
        const needed = familyInfo[key]
        if (typeof needed !== 'string' || needed === '') continue
        const present = (await loadModels()).some(model => model.name === needed && (model.folder === folder || (folder === 'text_encoders' && model.folder === 'clip')))
        if (!present) {
          throw new Error(
            `family=${familyId} 需要 ${label} "${needed}"，但这台机器的 ComfyUI 里没有。\n` +
            `请把它放进 ${whereToPut(folder)}（或用 extra_model_paths.yaml 指过去）；同族模型与伴生文件要配套。`,
          )
        }
      }
      const timeoutSeconds = Math.min(3600, Math.max(30, Number(args.timeoutSeconds) || settings.defaultTimeoutSeconds))

      let result
      try {
        result = await comfy.generate(settings.origin, {
          prompt: args.prompt,
          negative: args.negative,
          family: args.family,
          model: modelArg,
          width: args.width,
          height: args.height,
          steps: args.steps,
          cfg: args.cfg,
          sampler: args.sampler,
          scheduler: args.scheduler,
          seed: args.seed,
          batch: args.batch,
          lora: loras,
          initImage,
          initImageName,
          textEncoder: args.textEncoder,
          vae: args.vae,
          clipType: args.clipType,
          denoise: args.denoise,
          timeoutSeconds,
          outputDir: settings.outputDir,
          modelsRoot: settings.modelsRoot,
        })
      } catch (error) {
        throw toolError('图片生成失败：', error)
      }

      if (result.timedOut) {
        return {
          text:
            `生成尚未完成：已等待 ${timeoutSeconds} 秒，任务仍在 ComfyUI 中（promptId=${result.promptId}）。图片此时还没有下载到本地。\n` +
            '下一步：用 drawing_queue 查看是否仍在运行；完成后再用 drawing_history 取本地路径。不要重复提交同一提示词。',
          promptId: result.promptId,
          timedOut: true,
          family: result.family,
          model: result.model,
          params: result.params,
          seconds: result.seconds,
          images: [],
        }
      }

      const withMarkdown = result.images.map((image) => ({ ...image, markdown: localImageMarkdown(image.path, path.basename(image.path)) }))
      const lines = [
        `已生成 ${result.images.length} 张图（${result.family} / ${result.model}，耗时 ${fmtSeconds(result.seconds)}，promptId=${result.promptId}）`,
        'PNG 绝对路径：',
        ...listImagesForModel(withMarkdown),
        `参数: ${fmtParams(result.params)}`,
      ]
      // 可见性：这次生成在 ComfyUI 里能看见、能打开。
      if (result.origin) lines.push(`ComfyUI：${result.origin}（队列里 client_id=${result.clientId}，画布与 Queue 面板都能看到）`)
      if (result.workflowSaved) lines.push(`工作流已写入 ComfyUI 的 Workflows 列表：${result.workflowName}`)
      else if (result.workflowName) lines.push(`工作流未能写入 ComfyUI 列表，但已存进 PNG：把图片拖回画布即可打开这张图的工作流`)
      lines.push(generateHint())
      if (args.batch && args.batch > 1) lines.push(`提示：batch=${result.images.length}，请把每张图的内联 Markdown 行都放进回复。`)
      return {
        text: lines.join('\n'),
        promptId: result.promptId,
        images: withMarkdown,
        family: result.family,
        model: result.model,
        params: result.params,
        seconds: result.seconds,
        timedOut: false,
        origin: result.origin,
        clientId: result.clientId,
        workflowName: result.workflowName,
        workflowSaved: result.workflowSaved,
      }
    },
  })
}


/** 模型名 → ComfyUI 目录名（只用于找旁边的文档；不认识就当 loras）。 */
function guessFolderForModel(name) {
  const value = String(name).toLowerCase()
  if (/checkpoint|\bsd15\b|\bsdxl\b|pony/.test(value)) return 'checkpoints'
  if (/vae/.test(value)) return 'vae'
  if (/encoder|clip/.test(value)) return 'text_encoders'
  return 'loras'
}

/**
 * drawing_modeldoc：规范获取/查看模型文档。
 * - fetch：从 Hugging Face 仓库或 Civitai 版本抓取并保存；
 * - import：把本地 .md 导入到标准位置；
 * - show / list：查看已保存的文档。
 */
function modeldocTool(settings) {
  return defineTool({
    name: 'drawing_modeldoc',
    description:
      '模型的官方文档：fetch 从 Hugging Face（repo）或 Civitai（versionId）抓取模型卡/说明并存到 <models>/.dsh-docs；import 导入本地 .md；show/list 查看已保存的文档。用某个模型出图前，先确认它有没有官方文档。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'show', 'fetch', 'import'], description: 'list=已保存的文档；show=看某一个；fetch=从来源抓取；import=导入本地文件。' },
      model: { type: 'string', description: '模型文件名（show / import 的目标，也是保存后的文档名）。' },
      kind: { type: 'string', enum: ['lora', 'checkpoint', 'diffusion_model', 'vae', 'text_encoder', 'controlnet', 'embedding', 'upscale_model', 'clip_vision'], description: '文档归属的类别，默认 lora。' },
      repo: { type: 'string', description: 'Hugging Face 仓库 id（fetch）。' },
      versionId: { type: 'integer', description: 'Civitai 模型版本 id（fetch）。' },
      path: { type: 'string', description: '本地 .md 文件路径（import）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, docs: { type: 'array' }, path: { type: 'string' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const action = args?.action
      const kind = args?.kind ?? 'lora'
      const layout = await resolveLayout(settings)
      if (layout.modelsRoot === null) throw new Error('模型根未知：先让 ComfyUI 运行（可自动发现），或在配置里指定 modelsRoot。')

      if (action === 'list') {
        const docs = await modeldocs.listDocs(layout.modelsRoot)
        const lines = [`已保存的模型文档（${modeldocs.docsRoot(layout.modelsRoot)}，${docs.length} 份）：`]
        if (docs.length === 0) lines.push('（空）用 fetch 抓取一份，或 import 导入本地 .md。')
        for (const doc of docs) lines.push(`- ${doc.kind}/${doc.slug} | ${doc.title} | 来源: ${doc.source} | ${doc.fetchedAt} | ${doc.bytes} 字节`)
        return { text: lines.join('\n'), docs }
      }

      if (action === 'show') {
        if (typeof args?.model !== 'string' || args.model.trim() === '') throw new Error('show 需要 model（模型文件名）。')
        const doc = await modeldocs.readDoc(layout.modelsRoot, { kind, modelName: args.model })
        if (doc === null) throw new Error(`没有保存 ${args.model} 的文档；先 fetch/import，或看模型旁边的 .md。`)
        return { text: `${doc.title}（来源: ${doc.source}${doc.url ? `，${doc.url}` : ''}，${doc.fetchedAt}）\n\n${doc.text}`, path: path.join(doc.dir, 'README.md') }
      }

      if (action === 'fetch') {
        if (typeof args?.repo !== 'string' && args?.versionId === undefined) throw new Error('fetch 需要 repo（Hugging Face）或 versionId（Civitai）。')
        let fetched
        if (typeof args?.repo === 'string' && args.repo.trim() !== '') {
          const token = await civitai.resolveNamedToken(credentialsNow(), 'HF_TOKEN')
          fetched = await modeldocs.fetchHuggingFaceDocs({ repo: args.repo.trim(), token: token?.value })
        } else {
          const token = await civitai.resolveToken(credentialsNow())
          fetched = await modeldocs.fetchCivitaiDocs({ civitai, versionId: args.versionId, token: token?.value })
        }
        const modelName = typeof args?.model === 'string' && args.model.trim() !== ''
          ? args.model.trim()
          : (typeof args?.repo === 'string' ? args.repo.split('/').pop() : `civitai-${args.versionId}`)
        const saved = await modeldocs.saveDoc(layout.modelsRoot, {
          kind,
          modelName,
          source: typeof args?.repo === 'string' ? 'huggingface' : 'civitai',
          url: fetched.sources[0] ?? null,
          title: fetched.title,
          text: fetched.text,
          meta: fetched.meta,
        })
        const preview = fetched.text.length > 400 ? `${fetched.text.slice(0, 400)}…` : fetched.text
        return {
          text: `已保存官方文档：${path.join(saved.dir, 'README.md')}（${saved.entry.bytes} 字节，来源 ${saved.entry.source}）。\n用这个模型出图前先 drawing_guide({ model: '${modelName}' }) 读它。\n\n${preview}`,
          path: path.join(saved.dir, 'README.md'),
        }
      }

      if (action === 'import') {
        if (typeof args?.path !== 'string' || args.path.trim() === '') throw new Error('import 需要本地 .md 路径。')
        if (typeof args?.model !== 'string' || args.model.trim() === '') throw new Error('import 需要 model（这份文档对应的模型文件名）。')
        const file = path.resolve(settings.cwdOf(exec), args.path.trim())
        if (!existsSync(file)) throw new Error(`找不到文件：${file}`)
        const text = readFileSync(file, 'utf8')
        const saved = await modeldocs.saveDoc(layout.modelsRoot, { kind, modelName: args.model.trim(), source: 'local', url: file, title: path.basename(file), text })
        return { text: `已导入：${path.join(saved.dir, 'README.md')}（${saved.entry.bytes} 字节）。用这个模型前 drawing_guide({ model: '${args.model.trim()}' }) 读它。`, path: path.join(saved.dir, 'README.md') }
      }

      throw new Error('action 只能是 list / show / fetch / import。')
    },
  })
}

/**
 * drawing_setup：把"启动 ComfyUI"这一步自动化。
 * - detect：找 ComfyUI 根（配置/环境变量/models 根上一级/常见位置）+ python；
 * - apply：把探测结果写进宿主行（drawing-console）的 config.launch，侧边栏入口即可启动。
 */
function setupTool(settings) {
  return defineTool({
    name: 'drawing_setup',
    description:
      '配置启动 ComfyUI：detect 自动探测安装目录与 Python 解释器（不写配置）；apply 把探测结果写进插件的 launch 配置，之后侧边栏「AI 绘画」入口和 start 路由就能自动拉起 ComfyUI。用户说"点启动没反应/要自己开 ComfyUI/换电脑"时用。',
    parameters: {
      action: { type: 'string', required: true, enum: ['detect', 'apply'], description: 'detect=只探测；apply=探测并写入 launch 配置。' },
      comfyDir: { type: 'string', description: 'ComfyUI 安装目录（含 main.py）。不给就自动找：配置、COMFYUI_HOME、models 根上一级、常见位置。' },
      python: { type: 'string', description: 'apply 时显式指定 Python 解释器；默认用探测到的。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, launch: { type: 'object', additionalProperties: true } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = args?.action ?? 'detect'
      const layout = await resolveLayout(settings)
      const detected = detectLaunch({
        comfyRoot: typeof args?.comfyDir === 'string' && args.comfyDir.trim() !== '' ? args.comfyDir.trim() : layout.comfyRoot,
        modelsRoot: layout.modelsRoot,
      })
      const command = typeof args?.python === 'string' && args.python.trim() !== '' ? args.python.trim() : detected.command
      const lines = []
      lines.push(`ComfyUI 探测：${detected.ok || detected.main ? detected.source : '未找到'}`)
      if (detected.comfyRoot) lines.push(`- 安装目录：${detected.comfyRoot}`)
      if (detected.main) lines.push(`- 入口：${detected.main}${existsSync(detected.main) ? '' : '（不存在）'}`)
      lines.push(`- Python：${command ?? '未找到'}`)
      if (detected.ok) lines.push(`- 启动命令：${command} ${detected.args.join(' ')}（cwd ${detected.cwd}）`)
      if (!detected.ok) lines.push(`- 原因：${detected.reason ?? '未知'}`)
      if (action === 'detect') {
        if (!detected.ok) lines.push('', '修正：drawing_setup({ action: \'apply\', comfyDir: \'<ComfyUI 目录>\' }) 显式指定，或把 comfyDir 写进插件配置。')
        return { text: lines.join('\n'), launch: detected }
      }

      if (command === null || command === undefined || command.trim() === '') throw new Error(`探测不到可用的 Python：${detected.reason ?? '未知'}。用 drawing_setup({ action: 'apply', comfyDir: '<目录>', python: '<解释器>' }) 显式指定。`)
      const cwd = detected.cwd ?? (detected.main ? path.dirname(detected.main) : null)
      if (cwd === null || !existsSync(cwd)) throw new Error(`ComfyUI 目录不可用：${cwd ?? '未知'}。`)
      const editor = serviceNow('configEditor', configEditorService)
      if (editor === null || typeof editor.entries !== 'function') {
        throw new Error('当前环境没有配置编辑器，无法写回 launch；请手动在插件行 config.launch 填 command/cwd。')
      }

      // 找宿主行：bundle 行的 name 就是 dsh-drawing-tools（preset 里的 tools 行不是 profile entry）。
      const entries = editor.entries()
      const named = entries.filter((entry) => [entry?.name, entry?.options?.name, entry?.id, entry?.patchId]
        .some((value) => typeof value === 'string' && value.includes('dsh-drawing-tools')))
      const hostEntry = named.find((entry) => String(entry?.id ?? entry?.patchId ?? '').includes('drawing-console')) ?? named[0]
      if (hostEntry === undefined) {
        throw new Error(`没找到宿主插件行；当前可编辑的 entry：${entries.map((entry) => entry?.name ?? entry?.id ?? '?').join('、')}`)
      }

      const launchConfig = {
        enabled: true,
        command,
        args: detected.args.length > 0 ? detected.args : ['main.py', '--preview-method', 'auto'],
        cwd,
      }
      await editor.edit(hostEntry, (current) => ({ ...current, launch: { ...(current?.launch ?? {}), ...launchConfig } }))
      lines.push('', '已写入 launch 配置（宿主行），它会在下一次启动时生效：')
      lines.push(`- command: ${launchConfig.command}`)
      lines.push(`- args: ${launchConfig.args.join(' ')}`)
      lines.push(`- cwd: ${launchConfig.cwd}`)
      lines.push('', '之后点侧边栏「AI 绘画」入口即可自动拉起 ComfyUI；也可以 drawing_status 复查。')
      return { text: lines.join('\n'), launch: { ...detected, applied: launchConfig } }
    },
  })
}

function pathsTool(settings) {
  return defineTool({
    name: 'drawing_paths',
    description:
      '查看/规范化 ComfyUI 路径。report：对比"配置里的路径"与"ComfyUI 运行时自报的路径"，指出不一致、目录不存在、环境变量覆盖等问题。' +
      'adopt：把 ComfyUI 自报的真实路径写回插件配置（comfyRoot / modelsRoot），用于换了 ComfyUI 安装位置或全新安装之后。',
    parameters: {
      action: { type: 'string', required: true, enum: ['report', 'adopt'], description: 'report=只看；adopt=把自报路径写回配置。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, paths: { type: 'object', additionalProperties: true } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = args?.action ?? 'report'
      const layout = await resolveLayout(settings, { fresh: true })
      const discovered = layout.discovered
      // 环境变量不再参与路径解析；这里只报告它们是否存在，便于解释旧配置。
      const envModels = process.env.COMFY_MODELS_ROOT ?? null
      const envComfy = process.env.COMFY_ROOT ?? null
      const rows = [
        { key: 'comfyRoot', configured: settings.comfyRoot, env: envComfy, actual: discovered?.comfyRoot ?? null },
        { key: 'modelsRoot', configured: settings.modelsRoot, env: envModels, actual: discovered?.modelsRoot ?? null },
      ]
      const report = rows.map((row) => ({
        ...row,
        exists: row.actual !== null && existsSync(row.actual),
        mismatch: row.configured !== null && row.actual !== null
          && path.resolve(row.configured).toLowerCase() !== path.resolve(row.actual).toLowerCase(),
      }))

      if (action === 'adopt') {
        if (discovered === null) throw new Error('ComfyUI 没有自报路径（离线或版本太旧）；先让 ComfyUI 运行起来再 adopt。')
        const editor = serviceNow('configEditor', configEditorService)
        if (editor === null || pluginEntry === undefined || pluginEntry === null) {
          throw new Error('当前环境没有配置编辑器（或在非插件行上下文），无法写回配置；请手动更新插件行 config.comfyRoot / config.modelsRoot。')
        }
        const next = {
          comfyRoot: discovered.comfyRoot ?? settings.comfyRoot,
          modelsRoot: discovered.modelsRoot ?? settings.modelsRoot,
        }
        await editor.edit(pluginEntry, (current) => ({ ...current, ...next }))
        const lines = ['已把 ComfyUI 自报的路径写回插件配置：']
        lines.push(`- comfyRoot: ${next.comfyRoot ?? '（未自报，保持原值）'}`)
        lines.push(`- modelsRoot: ${next.modelsRoot ?? '（未自报，保持原值）'}`)
        if (process.env.COMFY_MODELS_ROOT || process.env.COMFY_ROOT) {
          lines.push('', '提示：环境变量 COMFY_ROOT / COMFY_MODELS_ROOT 已不参与路径解析，可以忽略或清理掉。')
        }
        lines.push('', '配置改动会让插件重新 apply；工具会在几秒内用新路径。')
        return { text: lines.join('\n'), adopted: next }
      }

      const lines = [`路径报告（ComfyUI: ${settings.origin}）`]
      for (const row of report) {
        lines.push(`- ${row.key}:`)
        lines.push(`  配置: ${row.configured ?? '（未配置）'}（仅离线兜底；路径以 ComfyUI 自报为准）`)
        lines.push(`  ComfyUI 自报: ${row.actual ?? '（无，可能离线或版本不支持）'}${row.actual ? (row.exists ? '' : '（目录不存在）') : ''}`)
        if (row.mismatch) lines.push('  ⚠ 不一致：实际以 ComfyUI 自报为准；用 drawing_paths({ action: \'adopt\' }) 写回配置。')
      }
      const extraRoots = (discovered?.modelRoots ?? []).slice(1)
      if (extraRoots.length > 0) {
        lines.push('- 额外模型根（extra_model_paths）：')
        for (const root of extraRoots) lines.push(`  · ${root}${existsSync(root) ? '' : '（目录不存在）'}`)
      }
      lines.push(`- 输出根: ${settings.outputDir}（规范化后）`)
      lines.push(`- API 工作流目录: ${apiWorkflowsDirFor(settings, layout)}`)
      lines.push(`- UI 工作流目录: ${uiWorkflowsDirFor(settings, layout)}`)
      if (discovered === null) {
        // 自报为空有两种原因：服务真的离线，或者在线但版本太旧/被代理挡住。
        const live = await comfy.status(settings.origin).catch(() => null)
        lines.push('', live?.online
          ? `ComfyUI 在线（v${live.version ?? '?'}），但没有提供 /internal/folder_paths：可能是旧版本，或请求被代理拦截。路径只能靠配置值。`
          : 'ComfyUI 现在离线，只能看到配置值；启动它之后再跑一次 report。')
      }
      return { text: lines.join('\n'), paths: { outputDir: settings.outputDir, comfyRoot: settings.comfyRoot, modelsRoot: settings.modelsRoot, env: { comfyRoot: envComfy, modelsRoot: envModels }, report } }
    },
  })
}

function queueTool(settings) {
  return defineTool({
    name: 'drawing_queue',
    description:
      '查看 ComfyUI 队列，或中断正在执行的任务、清空排队任务。生成超时后查进度、或用户要求停止生成时调用。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'interrupt', 'clear'],
        description: 'status=查看队列；interrupt=中断当前正在执行的任务；clear=清空排队中（未开始）的任务。',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, queue: { type: 'object', additionalProperties: true } } }, render: (_args, value) => textBlock(value.text) },
    // 并行安全：status 只读；interrupt/clear 是发给 ComfyUI 的控制命令，
    // 不碰插件自己持有的状态，与其它工具并行时结果仍可预期。
    isConcurrencySafe: () => true,
    execute: async args => {
      const result = await comfy.queue(settings.origin, args.action)
      if (result.action === 'status') {
        const lines = [
          `ComfyUI 队列：运行 ${result.runningCount}，等待 ${result.pendingCount}`,
        ]
        for (const item of result.running) {
          lines.push(`- 运行中 promptId=${item.promptId ?? '?'}${item.family ? ` family=${item.family}` : ''}`)
        }
        for (const item of result.pending) {
          lines.push(`- 排队中 promptId=${item.promptId ?? '?'}${item.family ? ` family=${item.family}` : ''}`)
        }
        if (!result.runningCount && !result.pendingCount) lines.push('队列为空。')
        return { text: lines.join('\n'), queue: result }
      }
      return { text: `${result.message}\n提示：已提交但尚未开始的批量任务会受影响；已生成的本地图片不受影响。`, queue: result }
    },
  })
}

function historyTool(settings) {
  return defineTool({
    name: 'drawing_history',
    description:
      '列出最近完成的 ComfyUI 生成记录、所用模型与本地图片绝对路径。用户问之前画过什么、想复用/展示旧图，或生成超时后确认结果时调用。',
    parameters: {
      limit: { type: 'integer', description: '返回条数 1–50，默认 10。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, records: { type: 'array' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => true,
    execute: async args => {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10))
      const records = await comfy.history(settings.origin, limit, { outputDir: settings.outputDir })
      const lines = [`最近 ${records.length} 条完成记录（新 → 旧）：`]
      if (!records.length) lines.push('（没有历史记录）')
      let withLocal = 0
      for (const [index, record] of records.entries()) {
        const images = Array.isArray(record.images) ? record.images : []
        const local = images.filter(image => image.path)
        withLocal += local.length
        lines.push(
          `${index + 1}. promptId=${record.promptId}${record.family ? ` | ${record.family}` : ''}${record.model ? ` | ${record.model}` : ''}` +
            `${record.seconds ? ` | ${fmtSeconds(record.seconds)}` : ''}`,
        )
        if (images.length) {
          for (const image of images) {
            lines.push(`   - ${image.path ?? `（本地未下载）${image.filename}`}`)
          }
        } else {
          lines.push('   - （这条记录没有输出图片）')
        }
      }
      if (withLocal > 0) lines.push('', '需要给用户看图时，把本地绝对路径写成 ![alt](<百分号编码的绝对路径>) 放进回复；drawing_generate 会直接返回这一行。')
      return { text: lines.join('\n'), records }
    },
  })
}

function workflowTool(settings) {
  return defineTool({
    name: 'drawing_workflow',
    description:
      '列出或运行保存的 ComfyUI API 格式工作流 JSON（默认在 ComfyUI 的 api-workflows 目录，兼容旧 drawing/workflows；非标准流程、固定工作流时用）。UI 格式工作流需先在 ComfyUI 里“导出 (API)”。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'run'],
        description: 'list=列出可用工作流；run=运行指定工作流。',
      },
      name: { type: 'string', description: 'list 不需要；run 时传 workflows 目录内的文件名（可省略 .json）。' },
      path: { type: 'string', description: 'run 时也可直接传工作流 JSON 的绝对或相对路径；与 name 二选一。' },
      timeoutSeconds: { type: 'integer', description: 'run 的总等待上限（秒），默认 600，最大 3600。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, workflows: { type: 'array' }, promptId: { type: 'string' }, images: { type: 'array' }, seconds: { type: 'number' }, timedOut: { type: 'boolean' } } }, render: (_args, value) => textBlock(value.text) },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      if (args.action === 'list') {
        const layout = await resolveLayout(settings)
        const dirs = workflowDirs(settings, layout)
        const workflows = []
        for (const dir of dirs) {
          for (const workflow of await comfy.listWorkflows({ workflowsDir: dir })) {
            if (workflows.some(item => item.name === workflow.name)) continue
            workflows.push({ ...workflow, dir })
          }
        }
        workflows.sort((left, right) => left.name.localeCompare(right.name))
        const lines = [`保存的工作流（${dirs.join(' + ')}，${workflows.length} 个）：`]
        if (!workflows.length) {
          lines.push('（目录为空）')
          lines.push('把 ComfyUI 导出的 API 格式 JSON 放进这些目录后即可在这里看到。')
        }
        for (const workflow of workflows) {
          const formatNote =
            workflow.format === 'api'
              ? 'API 格式，可直接 run'
              : workflow.format === 'ui'
                ? 'UI 格式，需在 ComfyUI 中“导出 (API)”后才能 run'
                : '无法解析'
          lines.push(`- ${workflow.name} | ${formatNote} | ${workflow.nodeCount ?? '?'} 节点 | ${workflow.sizeKB} KiB`)
          lines.push(`  ${workflow.path}`)
        }
        return { text: lines.join('\n'), workflows }
      }

      const cwd = settings.cwdOf(exec)
      const layout = await resolveLayout(settings)
      if (typeof args.path === 'string' && args.path.trim() && typeof args.name === 'string' && args.name.trim()) {
        throw new Error('path（本机文件路径）和 name（工作流名）只能给一个。')
      }
      let workflowPath
      if (typeof args.path === 'string' && args.path.trim()) {
        workflowPath = path.resolve(cwd, args.path.trim())
      } else if (typeof args.name === 'string' && args.name.trim()) {
        const raw = args.name.trim()
        const fileName = path.extname(raw) ? raw : `${raw}.json`
        if (path.isAbsolute(raw)) {
          workflowPath = fileName
        } else {
          workflowPath = workflowDirs(settings, layout)
            .map(dir => path.join(dir, fileName))
            .find(candidate => existsSync(candidate)) ?? path.join(apiWorkflowsDirFor(settings, layout), fileName)
        }
      }
      if (!workflowPath) throw new Error('run 需要提供 name 或 path。')
      if (!existsSync(workflowPath)) throw new Error(`找不到工作流文件: ${workflowPath}（查找目录: ${workflowDirs(settings, layout).join('，')}）`)
      const timeoutSeconds = Math.min(3600, Math.max(30, Number(args.timeoutSeconds) || settings.defaultTimeoutSeconds))
      let result
      try {
        result = await comfy.runWorkflow(settings.origin, workflowPath, {
          timeoutMs: timeoutSeconds * 1000,
          outputDir: settings.outputDir,
        })
      } catch (error) {
        throw toolError('运行工作流失败：', error)
      }
      if (result.timedOut) {
        return {
          text: `工作流运行超时（${timeoutSeconds}s），promptId=${result.promptId}。可用 drawing_queue 查询，完成后再用 drawing_history。`,
          promptId: result.promptId,
          timedOut: true,
          images: [],
        }
      }
      const withMarkdown = result.images.map((image) => ({ ...image, markdown: localImageMarkdown(image.path, path.basename(image.path)) }))
      const lines = [
        `工作流 ${result.name} 完成，生成 ${result.images.length} 张图（耗时 ${fmtSeconds(result.seconds)}，promptId=${result.promptId}）`,
        result.workflowSaved
          ? `工作流已写入 ComfyUI 的 Workflows 列表：${result.workflowName}`
          : '警告：这次工作流没有写进 ComfyUI 的 Workflows 列表，画布可能仍显示旧文件。',
        'PNG 绝对路径：',
        ...listImagesForModel(withMarkdown),
        generateHint(),
      ]
      return { text: lines.join('\n'), promptId: result.promptId, images: withMarkdown, seconds: result.seconds, timedOut: false }
    },
  })
}

// ---------------------------------------------------------------------------
// drawing_pnginfo: read the ComfyUI recipe embedded in a PNG
// ---------------------------------------------------------------------------

function describeRecipe(source, modelsRoot) {
  const { header, comfyPrompt, a1111, workflowNodeCount } = source
  const summary = comfyPrompt ? summarizeComfyPrompt(comfyPrompt) : null
  const lines = [header]
  const recipeParts = []
  if (comfyPrompt) recipeParts.push('ComfyUI prompt（API 图）')
  if (workflowNodeCount) recipeParts.push(`ComfyUI workflow（UI 图，${workflowNodeCount} 节点）`)
  if (a1111) recipeParts.push('A1111 parameters')
  lines.push(`配方: ${recipeParts.join(' + ') || '无'}`)
  if (source.promptUnparsable) lines.push('prompt 块存在但解析失败（不是合法 JSON）。')

  const model = summary?.model ?? null
  const modelBits = []
  if (model?.unet) modelBits.push(`unet=${displayModelName(model.unet)}`)
  if (model?.clip) modelBits.push(`clip=${displayModelName(model.clip)}`)
  if (model?.vae) modelBits.push(`vae=${displayModelName(model.vae)}`)
  if (modelBits.length) lines.push(`模型: ${modelBits.join('，')}`)

  const loras = summary?.loras ? resolveLoraNames(modelsRoot, summary.loras) : []
  const loraMiss = comfy.toRootArray(modelsRoot).length > 0
    ? '（未找到同名文件，用 drawing_models 核对）'
    : '（模型目录未知，未核对；用 drawing_models 看是否已安装）'
  if (loras.length) {
    lines.push(`LoRA: ${loras.map(lora => `${lora.display}:${lora.strength}${lora.resolved ? '' : loraMiss}`).join('，')}`)
    if (loras.some(lora => lora.resolved)) lines.push('复刻: 把上面的 LoRA 名整串传给 drawing_generate 的 lora（含 / 与 :强度），JSON 里照抄。')
  }

  const params = { ...(a1111?.params ?? {}), ...(summary?.params ?? {}) }
  const width = Number.isFinite(source.width) ? source.width : null
  const height = Number.isFinite(source.height) ? source.height : null
  const size = summary?.size ?? a1111?.size ?? (width && height ? { width, height } : null)
  const paramBits = []
  if (size) paramBits.push(`${size.width}×${size.height}`)
  if (params.seed !== undefined) paramBits.push(`seed ${params.seed}`)
  if (params.steps !== undefined) paramBits.push(`${params.steps} 步`)
  if (params.cfg !== undefined) paramBits.push(`CFG ${params.cfg}`)
  if (params.sampler) paramBits.push(params.scheduler ? `${params.sampler}/${params.scheduler}` : params.sampler)
  else if (params.scheduler) paramBits.push(params.scheduler)
  if (params.denoise !== undefined && params.denoise !== 1) paramBits.push(`denoise ${params.denoise}`)
  if (summary?.batch !== null && summary?.batch !== undefined && summary.batch > 1) paramBits.push(`batch ${summary.batch}`)
  if (paramBits.length) lines.push(`参数: ${paramBits.join('，')}`)

  const positive = summary?.positive ?? a1111?.positive ?? null
  const negative = summary?.negative ?? a1111?.negative ?? null
  if (positive) lines.push('', '正向提示词:', clip(positive, 1600))
  if (negative) lines.push('', '负向提示词:', clip(negative, 800))
  if (summary && !positive) lines.push('', '（没有从图里解析出正向提示词文本；可看 workflow 节点或直接问用户。）')
  if (workflowNodeCount && !comfyPrompt) {
    lines.push('', '注意: 只有 UI 格式 workflow，不能直接提交运行；需要 API 格式（ComfyUI 里「导出 (API)」）才能用 drawing_workflow。')
  }

  return {
    lines,
    hasPrompt: Boolean(comfyPrompt),
    hasWorkflow: Boolean(workflowNodeCount) || Boolean(a1111),
    model,
    loras,
    params,
    size,
    positive,
    negative,
  }
}

function sidecarRecipe(sidecar, label) {
  let comfyPrompt = null
  let promptUnparsable = false
  if (typeof sidecar.prompt === 'string' && sidecar.prompt.trim()) {
    try {
      comfyPrompt = JSON.parse(sidecar.prompt)
    } catch {
      promptUnparsable = true
    }
  }
  const a1111 = typeof sidecar.parameters === 'string' && sidecar.parameters.trim() ? parseA1111Parameters(sidecar.parameters) : null
  let comfyWorkflow = null
  if (typeof sidecar.workflow === 'string' && sidecar.workflow.trim()) {
    try {
      comfyWorkflow = JSON.parse(sidecar.workflow)
    } catch {
      comfyWorkflow = null
    }
  }
  const dimensions = sidecar.width && sidecar.height ? `，${sidecar.width}×${sidecar.height}` : ''
  return {
    header: `${label}: ${JSON.stringify(sidecar.name ?? '图片')}（${sidecar.attachmentId}）${dimensions} · 入库时捕获，原图不用在本机`,
    comfyPrompt,
    a1111,
    workflowNodeCount: Number.isFinite(sidecar.workflowNodeCount) ? sidecar.workflowNodeCount : null,
    width: sidecar.width,
    height: sidecar.height,
    comfyWorkflow,
    promptUnparsable,
    sidecar,
  }
}


// ---------------------------------------------------------------------------
// 工作流审计：节点清单 + 依赖资源 + 缺失判定
// ---------------------------------------------------------------------------

/** ComfyUI 加载器节点 → 资源类别与字段。 */
const LOADER_FIELDS = [
  { types: ['CheckpointLoaderSimple', 'CheckpointLoader'], kind: 'checkpoint', fields: ['ckpt_name', 'config_name'] },
  { types: ['UNETLoader', 'UnetLoaderGGUF', 'UNETLoaderGGUF'], kind: 'diffusion_model', fields: ['unet_name', 'model_name'] },
  { types: ['CLIPLoader', 'DualCLIPLoader', 'CLIPLoaderGGUF', 'DualCLIPLoaderGGUF'], kind: 'text_encoder', fields: ['clip_name', 'clip_name1', 'clip_name2'] },
  { types: ['VAELoader'], kind: 'vae', fields: ['vae_name'] },
  { types: ['LoraLoader', 'LoraLoaderModelOnly'], kind: 'lora', fields: ['lora_name'] },
  { types: ['ControlNetLoader'], kind: 'controlnet', fields: ['controlnet_name'] },
  { types: ['UpscaleModelLoader'], kind: 'upscale_model', fields: ['model_name'] },
  { types: ['CLIPVisionLoader'], kind: 'clip_vision', fields: ['clip_name'] },
]
/** 每个类别在哪几个 ComfyUI 目录里找（clip 旧名也算文本编码器）。 */
const FOLDERS_OF_KIND = {
  checkpoint: ['checkpoints'],
  diffusion_model: ['diffusion_models'],
  text_encoder: ['text_encoders', 'clip'],
  vae: ['vae'],
  lora: ['loras'],
  controlnet: ['controlnet'],
  upscale_model: ['upscale_models'],
  clip_vision: ['clip_vision'],
}

/** 比对用的规范名：取 basename、小写、去扩展名、把分隔符折叠成空格。 */
function normalizeModelName(name) {
  return String(name)
    .split(/[\\/]/).pop()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

/** API 图的节点统计：class_type 出现次数。 */
function summarizeNodes(comfyPrompt) {
  if (comfyPrompt === null || typeof comfyPrompt !== 'object') return []
  const counts = new Map()
  for (const node of Object.values(comfyPrompt)) {
    const type = node !== null && typeof node === 'object' && typeof node.class_type === 'string' ? node.class_type : null
    if (type === null) continue
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => left.type.localeCompare(right.type))
}

/** 从 API 图里抽出工作流需要的模型文件（去重，按出现顺序）。 */
function extractRequirements(comfyPrompt) {
  if (comfyPrompt === null || typeof comfyPrompt !== 'object') return []
  const seen = new Set()
  const out = []
  for (const node of Object.values(comfyPrompt)) {
    const type = node !== null && typeof node === 'object' && typeof node.class_type === 'string' ? node.class_type : null
    if (type === null) continue
    const spec = LOADER_FIELDS.find((candidate) => candidate.types.includes(type))
    if (spec === undefined) continue
    const inputs = node.inputs !== null && typeof node.inputs === 'object' ? node.inputs : {}
    for (const field of spec.fields) {
      const value = inputs[field]
      if (typeof value !== 'string' || value.trim() === '') continue
      const key = spec.kind + '\u0000' + value
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: spec.kind, name: value, nodeType: type, field })
    }
  }
  return out
}

/** 用 ComfyUI 当前的模型清单判断每个依赖是否已安装。离线时 present=null（无法核对）。 */
async function auditRequirements(requirements, settings) {
  if (requirements.length === 0) return []
  let models = []
  let unreachable = false
  let layout = null
  try {
    layout = await resolveLayout(settings)
    models = await comfy.listModels(settings.origin, { modelsRoot: layout.modelRoots, dirs: layout.discovered?.dirs ?? null })
  } catch {
    unreachable = true
  }
  // 已安装文件的触发词/基模：从安装记录里读，读不到不影响审计。
  const provenance = new Map()
  if (layout !== null) {
    for (const kind of Object.keys(FOLDERS_OF_KIND)) {
      const directory = install.installDir(kind, layout)
      if (directory === null) continue
      for (const [fileName, record] of await install.readProvenance(directory)) provenance.set(`${kind}/${fileName}`, record)
    }
  }
  const audited = []
  for (const requirement of requirements) {
    if (unreachable) {
      audited.push({ ...requirement, present: null, installedAs: null, triggerWords: [] })
      continue
    }
    const folders = FOLDERS_OF_KIND[requirement.kind] ?? []
    const wanted = normalizeModelName(requirement.name)
    const hit = models.find((model) => folders.includes(model.folder) && normalizeModelName(model.name) === wanted)
    const record = hit === undefined ? undefined : provenance.get(`${requirement.kind}/${hit.name}`)
    // 没有来源元数据（野生的、手动拷进来的）就读文件头，常见于自制 LoRA。
    let header = null
    if (hit !== undefined && triggerWordsOf(record?.metadata).length === 0) header = await headerInfoFor(layout, hit.folder, hit.name)
    audited.push({
      ...requirement,
      present: hit !== undefined,
      installedAs: hit?.name ?? null,
      baseModel: record?.metadata?.baseModel ?? header?.baseModel ?? null,
      triggerWords: triggerWordsOf(record?.metadata).length > 0 ? triggerWordsOf(record?.metadata) : header?.triggerWords ?? [],
      triggerAlternatives: triggerAlternativesOf(record?.metadata),
      triggerHints: triggerHintsOf(record?.metadata),
      trainingTags: header?.trainingTags ?? [],
      recommendedStrength: header?.recommendedStrength ?? null,
    })
  }
  return audited
}

function pnginfoTool(settings) {
  return defineTool({
    name: 'drawing_pnginfo',
    description:
      '读取 ComfyUI 图片里内嵌的生成配方（PNG 的 prompt / workflow 文本块，或附件入库时的同源捕获）：返回工作流形态、节点清单（每类节点数量）、依赖的模型文件（checkpoint / diffusion model / text encoder / VAE / LoRA / controlnet / upscale / clip vision，逐个标注已安装或缺失）、seed、步数、CFG、采样器、尺寸与正负提示词；A1111 的 parameters 块也能读。缺资源时按返回的 missing 调 drawing_download 补齐。**优先用附件消息里的 sha256（形如 sha256:0899…）传 sha256**，入库时已经抓取，不需要原图路径；也可以传 name（文件名）或 path（本机原图）。',
    parameters: {
      sha256: { type: 'string', description: '附件消息里显示的 sha256（形如 sha256:0899… 或裸 64 位十六进制）。上传时已捕获配方，无需原图。' },
      name: { type: 'string', description: '只有文件名时用，例如 ComfyUI_temp_xxx.png；先查入库捕获，再按 searchUserDirs 决定是否搜用户目录。' },
      path: { type: 'string', description: '本机图片路径（绝对路径，或相对会话目录）。没有 sha256 / name 时用。' },
      save: { type: 'boolean', description: '把配方存进 ComfyUI 目录：API 图进 api-workflows（drawing_workflow 可复跑），UI 图进 user/default/workflows（ComfyUI 的 Workflows 面板可直接打开）。' },
      searchUserDirs: { type: 'boolean', description: '按 name 查找时是否连 ~/Desktop 与 ~/Downloads 一起搜，默认 false（只搜输出目录、会话目录和 ComfyUI 的 input/temp）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, source: { type: 'string' }, workflowFormat: { type: 'string' }, hasPrompt: { type: 'boolean' }, hasWorkflow: { type: 'boolean' }, nodes: { type: 'array' }, requirements: { type: 'array' }, missing: { type: 'array' }, loras: { type: 'array' }, params: { type: 'object', additionalProperties: true } } }, render: (_args, value) => textBlock(value.text) },
    // 并行安全：读取无状态；save 的写入走"独占创建 + 冲突改名"，两个并发保存
    // 会各自落成不同文件名（见 writeWorkflowFile），满足并行工具"不覆盖兄弟调用"的约定。
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cwd = settings.cwdOf(exec)
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      const requestedName = typeof args.name === 'string' ? args.name.trim() : ''
      const requestedHash = attachmentHash(args.sha256)
      const providedInputs = [requestedHash ? 'sha256' : null, requestedName ? 'name' : null, requestedPath ? 'path' : null].filter(Boolean)
      if (providedInputs.length > 1) {
        throw new Error(`sha256、name、path 只能给一个（收到的是 ${providedInputs.join('、')}）。`)
      }

      let filePath = null
      let fileBytes = null
      let fileMeta = null

      const fileFact = () => (filePath
        ? {
            path: filePath,
            bytes: fileBytes?.length ?? 0,
            mediaType: fileMeta?.mediaType ?? null,
            width: fileMeta?.width ?? null,
            height: fileMeta?.height ?? null,
          }
        : null)

      const explain = lines => ({
        text: lines.join('\n'),
        source: 'none',
        file: fileFact(),
        capture: null,
        hasPrompt: false,
        hasWorkflow: false,
        workflowFormat: 'none',
        nodes: [],
        requirements: [],
        missing: [],
        model: null,
        loras: [],
        params: {},
        size: null,
        positive: null,
        negative: null,
        savedWorkflowPath: null,
      })

      const finish = async (recipe) => {
        // 模型根优先用 ComfyUI 自报的：只读配置的话，没配 modelsRoot 的用户每次
        // 都会看到"未找到同名文件"，哪怕 LoRA 明明就装在本机。
        const pngLayout = await resolveLayout(settings).catch(() => null)
        const described = describeRecipe(recipe, pngLayout?.modelRoots ?? settings.modelsRoot)
        const lines = described.lines
        let savedWorkflowPath = null
        let savedUiWorkflowPath = null
        if (args.save) {
          const saveLayout = await resolveLayout(settings)
          const rawName = recipe.filePath ? path.basename(recipe.filePath) : recipe.sidecar?.name ?? 'workflow.png'
          const base = path.basename(rawName, path.extname(rawName)).replace(/[^\w.-]+/g, '_') || 'workflow'
          if (recipe.comfyPrompt) {
            savedWorkflowPath = writeWorkflowFile(apiWorkflowsDirFor(settings, saveLayout), `${base}.api.json`, JSON.stringify(recipe.comfyPrompt, null, 2))
            lines.push('', `API 工作流已保存（drawing_workflow 可直接复跑）: ${savedWorkflowPath}`, `复跑: drawing_workflow({ action: 'run', path: ${JSON.stringify(savedWorkflowPath)} })`)
          }
          if (recipe.comfyWorkflow) {
            savedUiWorkflowPath = writeWorkflowFile(uiWorkflowsDirFor(settings, saveLayout), `${base}.json`, JSON.stringify(recipe.comfyWorkflow, null, 2))
            lines.push(`UI 工作流已保存（ComfyUI 的 Workflows 面板可直接打开）: ${savedUiWorkflowPath}`)
          } else if (recipe.comfyPrompt) {
            lines.push('（没有捕获到 UI 格式 workflow，只存了 API 版；旧捕获/截图不含 UI 图。）')
          }
        }

        // 工作流形态、节点清单、依赖资源与缺失项：读图之后的"下一步"都从这里出。
        const nodes = summarizeNodes(recipe.comfyPrompt)
        const requirements = await auditRequirements(extractRequirements(recipe.comfyPrompt), settings)
        // 原图的正面提示词里出现过哪些触发词：复刻时这就是"哪种写法是对的"的证据。
        const positiveText = typeof recipe.positive === "string" ? recipe.positive.toLowerCase() : ""
        if (positiveText !== "") {
          for (const requirement of requirements) {
            requirement.usedInImage = (requirement.triggerWords ?? []).filter((word) => positiveText.includes(word.toLowerCase()))
          }
        }
        const missing = requirements.filter((requirement) => requirement.present === false)
        const workflowFormat = recipe.comfyPrompt ? 'api' : recipe.comfyWorkflow ? 'ui' : recipe.a1111 ? 'a1111' : 'none'
        if (nodes.length > 0) {
          const total = nodes.reduce((sum, node) => sum + node.count, 0)
          lines.push(`节点: ${nodes.length} 类 / ${total} 个 — ${nodes.map((node) => `${node.type}×${node.count}`).join('、')}`)
        }
        if (requirements.length > 0) {
          lines.push('依赖资源:')
          for (const requirement of requirements) {
            const state = requirement.present === true
              ? `已安装${requirement.installedAs && requirement.installedAs !== requirement.name ? `（${requirement.installedAs}）` : ''}`
              : requirement.present === false ? '缺失' : '无法核对（ComfyUI 离线）'
            const triggerParts = describeTriggerWords({ trainedWords: requirement.triggerWords, triggerAlternatives: requirement.triggerAlternatives, triggerHints: requirement.triggerHints })
            const used = requirement.usedInImage?.length ? ` | 原图用了: ${requirement.usedInImage.join(', ')}` : ''
            lines.push(`- ${requirement.kind}: ${requirement.name} — ${state}${triggerParts.length ? ` | ${triggerParts.join(' | ')}` : ''}${used}`)
          }
        }
        if (missing.length > 0) {
          const first = missing[0]
          lines.push('', `缺 ${missing.length} 个资源。下一步: drawing_download({ action: 'search', query: '${first.name}', kind: '${first.kind}' }) → 选中后 action: 'download'。`)
        }

        return {
          text: lines.join('\n'),
          source: recipe.sidecar ? 'capture' : 'file',
          workflowFormat,
          nodes,
          requirements,
          missing: missing.map((requirement) => ({ kind: requirement.kind, name: requirement.name })),
          file: fileFact(),
          capture: recipe.sidecar
            ? {
                attachmentId: recipe.sidecar.attachmentId,
                name: recipe.sidecar.name ?? null,
                capturedAt: recipe.sidecar.capturedAt ?? null,
              }
            : null,
          hasPrompt: described.hasPrompt,
          hasWorkflow: described.hasWorkflow,
          model: described.model,
          loras: described.loras,
          params: described.params,
          size: described.size,
          positive: described.positive,
          negative: described.negative,
          savedWorkflowPath,
          savedUiWorkflowPath,
        }
      }

      // 1) attachment sha256 straight from the chat message: no path involved.
      if (requestedHash) {
        const sidecar = readCapturedRecipe(requestedHash)
        if (!sidecar) {
          const store = captureStoreStatus()
          throw new Error(
            `没有 sha256:${requestedHash} 的入库记录（${store.dir}，已有 ${store.count} 条）。这张图可能是在捕获钩子生效前发送的；重新发送一次原 PNG 即可在入库时抓取，也可以改用 name 或 path。`,
          )
        }
        return finish(sidecarRecipe(sidecar, '附件'))
      }

      // 2) file name: the captured store first, then a filesystem lookup.
      if (!requestedPath && requestedName) {
        const captured = findCapturedByName(requestedName)
        if (captured) return finish(sidecarRecipe(captured, '附件'))
        if (path.isAbsolute(requestedName) || requestedName.includes('/') || requestedName.includes('\\')) {
          filePath = path.resolve(cwd, requestedName)
        } else {
          // 默认只在自己可控的目录里找；扫桌面/下载要显式打开，避免全盘找同名图。
          // ComfyUI 根目录未知时不要 path.join(null)；用自报值兜底，再不行就不搜它的 input/temp。
          const pngLayout = await resolveLayout(settings).catch(() => null)
          const comfyRoot = pngLayout?.comfyRoot ?? settings.comfyRoot
          const roots = args.searchUserDirs
            ? defaultImageRoots(cwd, [settings.outputDir])
            : [settings.outputDir, cwd, ...(comfyRoot ? [path.join(comfyRoot, 'input'), path.join(comfyRoot, 'temp')] : [])]
          const candidates = findImageByName(roots, requestedName)
          if (!candidates.length) {
            throw new Error(
              `没找到名为 "${requestedName}" 的图片，也没有它的入库捕获（已搜索输出目录、会话目录、ComfyUI 的 input/temp${args.searchUserDirs ? '、桌面与下载' : ''}）。请改用 sha256（入库时已抓取）、把原 PNG 的绝对路径用 path 传进来，或加 searchUserDirs: true 再试一次。`,
            )
          }
          filePath = candidates[0]
        }
      } else if (requestedPath) {
        filePath = path.resolve(cwd, requestedPath)
      } else {
        throw new Error('需要 sha256（附件消息里那串）、name（文件名）或 path（本机路径）之一。')
      }

      if (!existsSync(filePath)) throw new Error(`找不到文件：${filePath}`)
      if (!statSync(filePath).isFile()) throw new Error(`不是文件：${filePath}`)
      fileBytes = readFileSync(filePath)
      if (fileBytes.length > 64 * 1024 * 1024) throw new Error(`文件过大（${fmtBytes(fileBytes.length)}），不像是普通生成图。`)
      fileMeta = inspectImageMetadata(fileBytes)

      if (fileMeta.isPng && (fileMeta.comfyPrompt || fileMeta.comfyWorkflow || fileMeta.a1111)) {
        return finish({
          header: `文件: ${filePath}（${fmtBytes(fileBytes.length)}，${fileMeta.width}×${fileMeta.height}）`,
          comfyPrompt: fileMeta.comfyPrompt,
          a1111: fileMeta.a1111,
          workflowNodeCount: fileMeta.comfyWorkflow ? summarizeWorkflow(fileMeta.comfyWorkflow)?.nodeCount ?? null : null,
          comfyWorkflow: fileMeta.comfyWorkflow,
          width: fileMeta.width,
          height: fileMeta.height,
          promptUnparsable: fileMeta.chunks.includes('prompt') && !fileMeta.comfyPrompt,
          filePath,
        })
      }

      // 3) a normalized attachment copy (JPEG/WebP or chunk-less PNG): identify it by
      // its own sha256, which equals the attachment id the chat message shows.
      const captured = readCapturedRecipe(sha256Hex(fileBytes))
      if (captured) return finish(sidecarRecipe(captured, '聊天副本（已归一化）'))

      if (fileMeta.isPng) {
        const chunks = fileMeta.chunks.length ? fileMeta.chunks.join('、') : '无'
        return explain([
          `文件: ${filePath}（${fmtBytes(fileBytes.length)}，${fileMeta.width}×${fileMeta.height}）`,
          '这是 PNG，但没有可读的生成配方（没有 prompt / workflow / parameters 文本块），也没有它的入库捕获。',
          `文件里的文本块: ${chunks}。可能是保存时关闭了元数据，或不是 ComfyUI / A1111 产出的图。`,
        ])
      }

      return explain([
        `文件: ${filePath}（${fmtBytes(fileBytes.length)}，${String(fileMeta.mediaType).toUpperCase()}）`,
        '这张图不是 PNG，不含 PNG 文本块；它的 sha256 也没有对应的入库捕获。',
        'ComfyUI 把配方写在 PNG 的 tEXt 块里；DSH 附件入库会把带元数据的图重编码成无元数据的 JPEG/WebP，所以聊天里拿到的副本本来就不含这些块。',
        '要读配方：把原始 PNG 重新发送一次（新版插件会在入库时抓取，之后用消息里的 sha256 查），或用 path 给出磁盘上的原 PNG。',
      ])
    },
  })
}


// ---------------------------------------------------------------------------
// drawing_download: search Civitai and install a model into ComfyUI's folders
// ---------------------------------------------------------------------------

/** 只有官方站点收 token；镜像站是第三方，不带凭据。 */
function officialDownloadHost(target) {
  try {
    const hostname = new URL(target).hostname.toLowerCase()
    return hostname === 'civitai.com' || hostname === 'www.civitai.com' || hostname === 'huggingface.co' || hostname === 'www.huggingface.co'
  } catch {
    return false
  }
}

function downloadTool(settings) {
  const CIVITAI_TYPE_BY_KIND = { lora: 'LORA', checkpoint: 'Checkpoint', text_encoder: 'TextEncoder', vae: 'VAE', controlnet: 'Controlnet' }
  const KIND_BY_FOLDER = { loras: 'lora', checkpoints: 'checkpoint', diffusion_models: 'diffusion_model', vae: 'vae', text_encoders: 'text_encoder', controlnet: 'controlnet', embeddings: 'embedding', upscale_models: 'upscale_model', clip_vision: 'clip_vision' }
  const kindOf = (kind, type) => (kind && install.KINDS.includes(kind) ? kind : KIND_BY_FOLDER[String(type ?? '').toLowerCase()] ?? 'lora')

  const tokenFor = async (source) => {
    if (source === 'huggingface') return civitai.resolveNamedToken(credentialsNow(), 'HF_TOKEN')
    return civitai.resolveToken(credentialsNow())
  }

  return defineTool({
    name: 'drawing_download',
    description:
      '搜索并安装模型到 ComfyUI。source 可选 civitai（Civitai API）、huggingface（HF 仓库）或 all；action=files 列 HF 仓库里的文件；action=find 用 DSH 的 web 搜索找泛网上可能的来源（只返回链接，不自动下载）。' +
      'action=download 会把文件按规范命名放进对应的模型目录（loras / checkpoints / diffusion_models / vae / text_encoders / controlnet / embeddings / upscale_models / clip_vision），校验 SHA256、不覆盖已有文件，并在 models/.dsh-install 下写一条来源记录。' +
      'token 由宿主凭据提供（设置 → AI 绘画 或环境变量 CIVITAI_TOKEN / HF_TOKEN），不要也不要试图在参数里传 token。',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'files', 'find', 'download'], description: 'search=列候选；files=列某个 HF 仓库的文件；find=泛网搜索；download=下载安装。' },
      source: { type: 'string', enum: ['civitai', 'huggingface', 'all'], description: 'search/download 的来源，默认 all。' },
      query: { type: 'string', description: 'search / find 的关键词（缺模型时直接传文件名或模型名）。' },
      kind: { type: 'string', enum: install.KINDS, description: '资源类别，决定安装目录；省略时按 type 或 lora 处理。' },
      type: { type: 'string', enum: civitai.CIVITAI_TYPES, description: 'Civitai 的模型类型过滤（LORA / Checkpoint / TextEncoder / VAE / Controlnet）。' },
      nsfw: { type: 'boolean', description: 'Civitai 搜索是否包含 NSFW，默认 false。' },
      limit: { type: 'integer', description: 'search 每页返回条数 1–20，默认 10。' },
      pages: { type: 'integer', description: 'Civitai 翻几页（1–5，默认 2）：关键词很宽、目标模型不在第一页时调大。' },
      repo: { type: 'string', description: 'Hugging Face 仓库 id，例如 org/name（files / download 用）。' },
      file: { type: 'string', description: 'HF 仓库内的文件路径（download 用；省略时先调 files 看）。' },
      revision: { type: 'string', description: 'HF 分支或提交，默认 main。' },
      modelVersionId: { type: 'integer', description: 'Civitai 的模型版本 id（search 结果里的 versionId）。' },
      downloadUrl: { type: 'string', description: '直接给下载地址（Civitai 或 HF 均可）。' },
      fileName: { type: 'string', description: '保存的文件名（默认用候选里的名字；会被规范化）。' },
      sha256: { type: 'string', description: '下载后校验的 SHA256。' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' }, results: { type: 'array' }, path: { type: 'string' }, bytes: { type: 'number' }, sha256: { type: 'string' }, kind: { type: 'string' } } }, render: (_args, value) => textBlock(value.text) },
    // 写共享的模型目录，与兄弟调用并行时不确定 → 独占。
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const action = args?.action ?? 'search'
      const source = args?.source ?? 'all'
      const wantedSources = source === 'all' ? ['civitai', 'huggingface'] : [source]

      if (action === 'search') {
        const results = []
        const sourceStates = []
        for (const item of wantedSources) {
          const attempts = []
          const report = {}
          // 每次尝试（含失败）立刻记录，失败后继续下一站。
          const onAttempt = (attempt) => attempts.push({ ...attempt })
          try {
            let found
            if (item === 'civitai') {
              const token = await tokenFor('civitai')
              found = await civitai.searchModels({ query: args?.query, type: args?.type ?? 'LORA', limit: args?.limit, pages: args?.pages ?? 2, nsfw: args?.nsfw === true, token: token?.value, onAttempt, report })
              results.push(...found.map((entry) => ({ ...entry, source: 'civitai' })))
            } else {
              const token = await tokenFor('huggingface')
              found = await hf.searchModels({ query: args?.query, limit: args?.limit, token: token?.value, onAttempt, report })
              results.push(...found)
            }
            sourceStates.push({ source: item, ok: true, host: report.host ?? null, attempts, count: found.length })
          } catch (error) {
            sourceStates.push({ source: item, ok: false, host: null, attempts: error?.attempts ?? attempts, error: civitai.redact(String(error?.message ?? error)) })
          }
        }
        const lines = [`搜索 "${args?.query}"（${wantedSources.join(' + ')}，${results.length} 条）：`]
        // 站点状态：失败也在结果里，并按尝试顺序显示切换链。
        lines.push('来源状态：')
        for (const state of sourceStates) {
          const chain = (state.attempts ?? []).map((attempt) => {
            const host = String(attempt.host ?? '?').replace(/^https?:\/\//, '')
            if (attempt.ok) return `${host} ✓`
            const reason = attempt.error !== undefined ? ` ${attempt.error}` : attempt.status !== undefined ? ` HTTP ${attempt.status}` : ''
            return `${host} ✗${reason}`
          }).join(' → ')
          lines.push(`- ${state.source}: ${chain || '无尝试'}${state.ok ? ` · ${state.count} 条` : ` · 失败：${state.error}`}`)
        }
        const MAX_LISTED = 12
        let civitaiShown = 0
        let civitaiSkipped = 0
        for (const entry of results) {
          if (entry.source === 'civitai') {
            if (civitaiShown >= MAX_LISTED) { civitaiSkipped += 1; continue }
            civitaiShown += 1
            const versions = Array.isArray(entry.versions) && entry.versions.length ? entry.versions : [entry]
            lines.push(`- [civitai] ${entry.name}${entry.nsfw ? ' | NSFW' : ''} | ${versions.length} 个版本`)
            for (const version of versions) {
              const size = version.sizeKB === null || version.sizeKB === undefined ? '大小未知' : `${Math.round(version.sizeKB / 1024)} MB`
              lines.push(`  · ${version.versionName ?? '?'} | ${version.baseModel ?? '?'} | versionId=${version.versionId ?? '?'} | ${version.fileName ?? '?'} | ${size}`)
            }
            if (entry.sha256) lines.push(`  sha256(最新版)=${entry.sha256}`)
          } else {
            lines.push(`- [huggingface] ${entry.repo} | downloads=${entry.downloads ?? '?'} | likes=${entry.likes ?? '?'} | ${entry.pipelineTag ?? '?'}`)
          }
        }
        if (civitaiSkipped > 0) lines.push(`（另有 ${civitaiSkipped} 条 civitai 结果未列出：换更精确的关键词，或调小 limit/pages）`)
        if (sourceStates.some((state) => (state.attempts ?? []).some((attempt) => !attempt.ok))) lines.push('（失败站点已即时跳过，继续搜索下一站）')
        if (results.length === 0) lines.push('没有结果：换关键词，或对 Civitai 加 nsfw: true。')
        lines.push('', "Civitai 下载：drawing_download({ action: 'download', source: 'civitai', modelVersionId: <id>, kind: 'lora', sha256: '<sha>' })")
        lines.push("HF 下载：先 action: 'files' 看文件名，再 action: 'download', source: 'huggingface', repo: '<repo>', file: '<file>'")
        return { text: lines.join('\n'), results, sources: sourceStates }
      }

      if (action === 'files') {
        const token = await tokenFor('huggingface')
        const report = {}
        const files = await hf.listFiles({ repo: args?.repo, revision: args?.revision ?? 'main', token: token?.value, report })
        const hostChain = (report.attempts ?? []).map((attempt) => `${String(attempt.host).replace(/^https?:\/\//, '')} ${attempt.ok ? '✓' : '✗'}`).join(' → ')
        const lines = [`HF 仓库 ${args?.repo} 的模型文件（${files.length} 个）`, `来源：${hostChain || report.host || '未知'}`]
        for (const file of files) {
          const size = file.bytes === null ? '大小未知' : `${Math.round(file.bytes / 1024 / 1024)} MB`
          lines.push(`- ${file.path} | ${size}${file.sha256 ? ` | sha256=${file.sha256}` : ''}`)
        }
        if (files.length === 0) lines.push('没有 .safetensors / .ckpt / .pt / .bin / .gguf 文件：这个仓库可能是 diffusers 目录结构。')
        return { text: lines.join('\n'), results: files, sources: [{ source: 'huggingface', ok: true, host: report.host ?? null, attempts: report.attempts ?? [] }] }
      }

      if (action === 'find') {
        const web = serviceNow('web', webService)
        if (web === null || typeof web.search !== 'function') {
          throw new Error("当前没有可用的 web 搜索服务；改用 web_search 工具搜，再把直链交给 drawing_download({ action: 'download', downloadUrl: ... }) 安装。")
        }
        const found = await web.search({ query: args?.query, maxResults: Math.min(10, Math.max(1, Number(args?.limit) || 5)) })
        const lines = [`泛网搜索 "${args?.query}"：`]
        for (const item of found.sources ?? []) lines.push(`- ${item.title ?? item.url} — ${item.url}`)
        if ((found.sources ?? []).length === 0) lines.push('没有结果。')
        lines.push('', "确认来源可信后，把直链交给 action: 'download'（downloadUrl）安装。")
        return { text: lines.join('\n'), results: found.sources ?? [] }
      }

      if (action === 'download') {
        const kind = kindOf(args?.kind, args?.type)
        const layout = await resolveLayout(settings)
        const directory = install.installDir(kind, layout)
        if (directory === null) {
          throw new Error('不知道要安装到哪个目录：先让 ComfyUI 运行（可自动发现模型目录），或在插件行 config.modelsRoot 指定。')
        }
        let url = args?.downloadUrl ?? null
        let suggestedName = args?.fileName ?? null
        let origin = 'url'
        if (args?.repo) {
          if (!args?.file) throw new Error("从 Hugging Face 下载需要 file（先 action: 'files' 看文件名）。")
          url = url ?? hf.downloadUrlFor(args.repo, args.file, args.revision ?? 'main')
          suggestedName = suggestedName ?? String(args.file).split('/').pop()
          origin = `huggingface:${args.repo}`
        } else if (args?.modelVersionId) {
          url = url ?? `https://civitai.com/api/download/models/${args.modelVersionId}`
          origin = `civitai:${args.modelVersionId}`
        }
        if (url === null) throw new Error('download 需要 modelVersionId、repo+file 或 downloadUrl。')

        // 元数据先取：触发词 / 基模 / 标签 / 来源页面会和文件一起落盘。
        let metadata = null
        let metadataError = null
        try {
          if (args?.modelVersionId) metadata = await civitai.versionMetadata(args.modelVersionId, { token: (await tokenFor('civitai'))?.value })
          else if (args?.repo) metadata = await hf.repoInfo({ repo: args.repo, token: (await tokenFor('huggingface'))?.value })
        } catch (error) {
          metadataError = civitai.redact(String(error?.message ?? error))
        }

        const fileName = install.sanitizeFileName(suggestedName ?? metadata?.fileName ?? null, kind)
        const existing = install.alreadyInstalled(directory, fileName)
        if (existing !== null) {
          return { text: `已存在，未重复下载：${existing.path}（${Math.round(existing.bytes / 1024 / 1024)} MB）`, path: existing.path, bytes: existing.bytes, kind, skipped: true }
        }

        const token = await tokenFor(args?.source === 'huggingface' || args?.repo ? 'huggingface' : 'civitai')
        // 备用站点：官方站连不上时依次退到镜像（同一路径、同一鉴权头）。
        const candidates = [url]
        if (args?.downloadUrl === undefined || args?.downloadUrl === null) {
          if (args?.modelVersionId) candidates.push(`https://civitai.red/api/download/models/${args.modelVersionId}`)
          if (args?.repo) candidates.push(hf.downloadUrlFor(args.repo, args.file, args.revision ?? 'main').replace(hf.HF_HOSTS[0], hf.HF_HOSTS[1]))
        }
        let response = null
        let usedUrl = url
        let lastError = null
        const downloadAttempts = []
        let tokenSent = false
        for (const candidate of [...new Set(candidates)]) {
          const label = candidate.replace(/\/api\/download\/models\/\d+.*$/, '')
          // 镜像站（civitai.red / hf-mirror.com）是第三方，不能把用户的 API key 交给它。
          const sendToken = Boolean(token) && officialDownloadHost(candidate)
          tokenSent = sendToken
          try {
            response = await fetch(candidate, {
              headers: { 'user-agent': 'dsh-drawing-tools', ...(sendToken ? { authorization: `Bearer ${token.value}` } : {}) },
              redirect: 'follow',
              signal: AbortSignal.timeout(1_800_000),
            })
            if (response.status >= 500) {
              downloadAttempts.push({ host: label, ok: false, status: response.status, error: `HTTP ${response.status}` })
              lastError = new Error(`HTTP ${response.status}`)
              response = null
              continue
            }
            downloadAttempts.push({ host: label, ok: response.ok, status: response.status })
            usedUrl = candidate
            break
          } catch (error) {
            const message = civitai.redact(String(error?.message ?? error))
            downloadAttempts.push({ host: label, ok: false, error: message })
            lastError = error
          }
        }
        if (response === null) {
          const detail = downloadAttempts.map((attempt) => `${attempt.host}: ${attempt.error ?? attempt.status}`).join('；')
          throw new Error(`下载失败（已试 ${downloadAttempts.length} 个站点）：${detail}`)
        }
        if (response.status === 401 || response.status === 403) {
          // 两种 401 要分开说：没带 token 是"没配置"，带了 token 还被拒是"token 无效/无权限"。
          // 以前共用一句话，用户填完 token 仍看到"请填 token"，只会以为配置坏了。
          const sourceName = args?.repo ? 'Hugging Face' : 'Civitai'
          const detail = !token
            ? `这次没有可用的 token：凭据库和环境变量 ${args?.repo ? 'HF_TOKEN' : 'CIVITAI_TOKEN'} 都是空的。`
            : tokenSent
              ? `已附带 token（来源 ${token.source ?? 'credentials'}），但 ${sourceName} 拒绝了它：可能已失效、没有该模型权限，或该模型要求先在网页上接受条款。`
              : `这次走的是第三方镜像，出于安全没有把 token 发过去；${sourceName} 直连失败时请稍后重试。`
          throw new Error(`下载返回 ${response.status}：${detail}请在「设置 → AI 绘画」里重新填写 token 后重试。`)
        }
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)

        const written = await install.installResponse(response, { directory, fileName, expectedSha256: args?.sha256 ?? null })
        const provenance = await install.writeProvenance(directory, path.basename(written.path), {
          source: origin,
          url: usedUrl.replace(/token=[^&]+/i, 'token=***'),
          kind,
          metadata,
          metadataError,
          folder: install.FOLDER_FOR_KIND[kind],
          sha256: written.sha256,
          bytes: written.bytes,
          installedAt: new Date().toISOString(),
          query: args?.query ?? null,
        })
        // 官方文档：来源可识别时顺手抓回来（失败不影响安装）。
        let docPath = null
        let docError = null
        try {
          let fetched = null
          if (args?.repo) {
            const hfToken = await tokenFor('huggingface')
            fetched = await modeldocs.fetchHuggingFaceDocs({ repo: args.repo, token: hfToken?.value })
          } else if (args?.modelVersionId) {
            const civToken = await tokenFor('civitai')
            fetched = await modeldocs.fetchCivitaiDocs({ civitai, versionId: args.modelVersionId, token: civToken?.value })
          }
          if (fetched !== null && layout.modelsRoot !== null) {
            const saved = await modeldocs.saveDoc(layout.modelsRoot, {
              kind,
              modelName: path.basename(written.path),
              source: args?.repo ? 'huggingface' : 'civitai',
              url: fetched.sources[0] ?? null,
              title: fetched.title,
              text: fetched.text,
              meta: fetched.meta,
            })
            docPath = path.join(saved.dir, 'README.md')
          }
        } catch (error) {
          docError = civitai.redact(String(error?.message ?? error))
        }

        const lines = [
          `下载来源：${downloadAttempts.map((attempt) => `${attempt.host} ${attempt.ok ? '✓' : '✗'}`).join(' → ')}`,
          `已安装：${written.path}（${Math.round(written.bytes / 1024 / 1024)} MB，类别 ${kind}，目录 ${install.FOLDER_FOR_KIND[kind]}）`,
          `sha256=${written.sha256}`,
        ]
        if (metadata?.modelName) lines.push(`模型：${metadata.modelName}${metadata.versionName ? `（版本 ${metadata.versionName}）` : ''}${metadata.baseModel ? ` | 基模：${metadata.baseModel}` : ''}`)
        for (const part of describeTriggerWords(metadata)) lines.push(`${part}`)
        if (metadata?.pageUrl) lines.push(`来源页面：${metadata.pageUrl}`)
        if (metadataError !== null) lines.push(`（元数据读取失败：${metadataError}）`)
        if (docPath !== null) lines.push(`官方文档已保存：${docPath}（用 drawing_guide({ model: '${path.basename(written.path)}' }) 读）`)
        else if (docError !== null) lines.push(`（官方文档没抓到：${docError}）`)
        if (provenance !== null) lines.push(`来源记录：${provenance}`)
        lines.push(`下一步：drawing_models({ kind: '${install.FOLDER_FOR_KIND[kind]}' }) 复核；ComfyUI 没刷新就重启它。`)
        if (kind === 'checkpoint') lines.push(`用法：drawing_generate({ family: 'classic', model: '${path.basename(written.path)}' })`)
        else if (kind === 'lora') lines.push('用法：任意族出图时把文件名加进 lora 参数（name:强度）。')
        else if (kind === 'vae' || kind === 'text_encoder') lines.push('用法：只能配 family=generic（分别作为 vae / textEncoder 参数）。')
        else if (kind === 'diffusion_model') lines.push(`用法：drawing_generate({ family: 'generic', model: '${path.basename(written.path)}', textEncoder: '<文件>', vae: '<文件>' })`)
        return {
          text: lines.join('\n'),
          path: written.path,
          bytes: written.bytes,
          sha256: written.sha256,
          kind,
          triggerWords: triggerWordsOf(metadata),
          triggerAlternatives: triggerAlternativesOf(metadata),
          triggerHints: triggerHintsOf(metadata),
          baseModel: metadata?.baseModel ?? null,
          modelName: metadata?.modelName ?? null,
          pageUrl: metadata?.pageUrl ?? null,
          sources: downloadAttempts,
          docPath,
        }
      }

      throw new Error('action 只能是 search / files / find / download。')
    },
  })
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** ComfyUI-facing directories: API graphs run from one, UI graphs open from the other. */
/** API 工作流目录：显式配置优先，否则按 ComfyUI 自报的根目录推导。 */
function apiWorkflowsDirFor(settings, layout = null) {
  if (settings.apiWorkflowsDirConfigured) return settings.apiWorkflowsDir
  return layout?.comfyRoot ? path.join(layout.comfyRoot, 'api-workflows') : settings.apiWorkflowsDir
}

/** UI 工作流目录：显式配置优先，否则用自报根目录下的 user/default/workflows。 */
function uiWorkflowsDirFor(settings, layout = null) {
  if (settings.uiWorkflowsDirConfigured) return settings.uiWorkflowsDir
  return layout?.comfyRoot ? path.join(layout.comfyRoot, 'user', 'default', 'workflows') : settings.uiWorkflowsDir
}

function workflowDirs(settings, layout = null) {
  // ComfyUI 自报的根目录优先；配置与包内目录只作为离线兜底。
  return [...new Set([
    settings.apiWorkflowsDirConfigured ? settings.apiWorkflowsDir : null,
    layout?.comfyRoot ? path.join(layout.comfyRoot, 'api-workflows') : null,
    settings.apiWorkflowsDir,
    settings.legacyWorkflowsDir,
  ].filter(Boolean))]
}

/** Write one workflow file, avoiding clobbering an existing same-named file. */
function writeWorkflowFile(directory, fileName, content) {
  mkdirSync(directory, { recursive: true })
  const extension = path.extname(fileName)
  const stem = path.basename(fileName, extension)
  const body = content.endsWith('\n') ? content : `${content}\n`
  // 独占创建（wx）：并发保存同一张图时不会互相覆盖，第二个自动换 -2 名字。
  for (let index = 1; index < 100; index += 1) {
    const target = path.join(directory, index === 1 ? fileName : `${stem}-${index}${extension}`)
    try {
      writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`保存工作流失败：${directory} 里同名文件过多。`)
}

/**
 * 实际使用的目录：用户配置 > 运行中 ComfyUI 自报（/internal/folder_paths）> 未知。
 * 不猜默认路径；返回的 `source` 让 drawing_status 能如实说明"这些路径是哪来的"。
 * @param {{ fresh?: boolean }} [options] fresh=true 时跳过缓存（体检用）
 */
async function resolveLayout(settings, options = {}) {
  const discovered = await comfy
    .discoverLayout(settings.origin, options.fresh ? { maxAgeMs: 0 } : {})
    .catch(() => null)
  // ComfyUI 运行时会自报文件夹（/internal/folder_paths）：它才是事实来源。
  // 配置只作为兜底；两者不一致时用自报值，并把差异交给 status 显示（避免"改过路径但配置没跟上"）。
  const discoveredModelsRoot = discovered?.modelsRoot ?? null
  const discoveredComfyRoot = discovered?.comfyRoot ?? null
  // extra_model_paths.yaml 会有多个模型根；单值 modelsRoot 只作为主根保留兼容。
  const modelRoots = comfy.toRootArray(discovered?.modelRoots ?? discoveredModelsRoot ?? settings.modelsRoot ?? null)
  const modelsRoot = modelRoots[0] ?? null
  const comfyRoot = discoveredComfyRoot ?? settings.comfyRoot ?? null
  const samePath = (left, right) => {
    if (!left || !right) return true
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  }
  return {
    modelsRoot,
    modelRoots,
    comfyRoot,
    source: discoveredModelsRoot ? 'discovered' : settings.modelsRootConfigured ? 'config' : 'none',
    modelsRootExists: Boolean(modelsRoot) && existsSync(modelsRoot),
    comfyRootExists: Boolean(comfyRoot) && existsSync(comfyRoot),
    configuredModelsRoot: settings.modelsRoot,
    configuredComfyRoot: settings.comfyRoot,
    modelsRootMismatch: !samePath(settings.modelsRoot, discoveredModelsRoot),
    comfyRootMismatch: !samePath(settings.comfyRoot, discoveredComfyRoot),
    discovered,
  }
}

function resolveSettings(config = {}) {
  const outputDir = config.outputDir || comfy.DEFAULT_OUTPUT_DIR
  // 路径只认 ComfyUI 自报；配置仅在它离线时兜底。环境变量（COMFY_ROOT / COMFY_MODELS_ROOT）不再参与。
  const configuredComfyRoot = config.comfyRoot || null
  const configuredModelsRoot = config.modelsRoot || null
  // 不预设 ComfyUI 安装目录：没配置就先留空，等运行中的 ComfyUI 自报（或用户补配置）。
  const comfyRoot = configuredComfyRoot ? path.resolve(configuredComfyRoot) : null
  // `workflowsDir` keeps its historical meaning (the API-format directory).
  // 只有知道 ComfyUI 根目录时才把工作流放进它的子目录，否则用本插件自己的目录。
  const ownWorkflowsDir = path.resolve(comfy.DEFAULT_WORKFLOWS_DIR)
  const apiWorkflowsDir = path.resolve(config.apiWorkflowsDir || config.workflowsDir || (comfyRoot ? path.join(comfyRoot, 'api-workflows') : ownWorkflowsDir))
  const uiWorkflowsDir = path.resolve(config.uiWorkflowsDir || (comfyRoot ? path.join(comfyRoot, 'user', 'default', 'workflows') : ownWorkflowsDir))
  const legacyWorkflowsDir = path.resolve(config.legacyWorkflowsDir || ownWorkflowsDir)
  return {
    origin: config.origin || process.env.COMFY_ORIGIN || comfy.DEFAULT_ORIGIN,
    // 输出目录规范化：展开 ~、相对路径按进程工作目录解析、去尾分隔符。
    outputDir: normalizeOutputRoot(outputDir, { cwd: process.cwd() }) ?? path.resolve(outputDir),
    comfyRoot,
    apiWorkflowsDir,
    uiWorkflowsDir,
    legacyWorkflowsDir,
    workflowsDir: apiWorkflowsDir,
    apiWorkflowsDirConfigured: Boolean(config.apiWorkflowsDir || config.workflowsDir),
    uiWorkflowsDirConfigured: Boolean(config.uiWorkflowsDir),
    modelsRoot: configuredModelsRoot ? path.resolve(configuredModelsRoot) : null,
    // 记住哪些值是"用户指定"的：没指定的才允许被运行中的 ComfyUI 报告覆盖。
    comfyRootConfigured: configuredComfyRoot !== null,
    modelsRootConfigured: configuredModelsRoot !== null,
    defaultTimeoutSeconds: Math.min(3600, Math.max(30, Number(config.timeoutSeconds) || 600)),
    // 自动拉起 ComfyUI 的命令（宿主半用同一份配置）。status 用它判断"离线时能不能自己拉起来"。
    launch: config.launch && typeof config.launch === 'object' ? config.launch : null,
  }
}

export function apply(ctx, config = {}) {
  // 官方契约：会话目录由 workingDirectory 服务拥有。这里用可选访问（ctx.get）而不是硬依赖，
  // 这样挂进没有该服务的 preset 时插件仍能激活，cwdFor 会退回会话头记录的 cwd。
  workingDirectoryService = ctx.get?.('workingDirectory') ?? null
  activeContext = ctx
  credentialsService = ctx.get?.('credentials') ?? null
  webService = ctx.get?.('web') ?? null
  configEditorService = ctx.get?.('configEditor') ?? null
  pluginEntry = ctx.fiber?.entry ?? null
  const settings = resolveSettings(config)
  settings.cwdOf = cwdFor
  const definitions = [
    statusTool(settings),
    modelsTool(settings),
    guideTool(settings),
    generateTool(settings),
    queueTool(settings),
    historyTool(settings),
    workflowTool(settings),
    pnginfoTool(settings),
    pathsTool(settings),
    setupTool(settings),
    modeldocTool(settings),
    downloadTool(settings),
  ].map(definition => ({
    ...definition,
    execute: async (args, exec) => jsonSafe(await definition.execute(args, exec)),
  }))
  ctx.effect(() => {
    const disposers = definitions.map(definition => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // tool removal during teardown is best-effort
        }
      }
    }
  }, 'dsh-drawing-agent: drawing tools')
}
