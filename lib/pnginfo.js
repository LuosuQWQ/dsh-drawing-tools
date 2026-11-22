// ComfyUI PNG metadata: parse the `prompt` / `workflow` text chunks that
// SaveImage writes into every output PNG, and turn the API graph into a short,
// model-facing recipe (model / LoRAs / sampler params / positive & negative
// prompt). No dependencies: only node:zlib for zTXt / compressed iTXt.
//
// Deliberately not a general EXIF reader. The only thing that matters here is
// the generation recipe; a normalized DSH attachment copy is a JPEG without any
// text chunk, and the tool reports that instead of guessing a recipe.

import zlib from 'node:zlib'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Sniff the container from magic bytes so a stripped attachment copy can be
 * reported as "this is a JPEG, the PNG chunks are gone" instead of "not a PNG".
 * @param {Buffer} buffer - complete file bytes.
 * @returns {'png' | 'jpeg' | 'webp' | 'gif' | 'unknown'}
 */
export function sniffMediaType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) return 'gif'
  return 'unknown'
}

function decodeUtf8(buffer) {
  const text = buffer.toString('utf8')
  // A few ComfyUI custom nodes emit GBK bytes inside an otherwise UTF-8 JSON
  // string; Node has full ICU, so a lossy utf8 decode that is mostly U+FFFD can
  // be retried as GBK before giving up.
  if (text.includes('\uFFFD')) {
    const bad = [...text].filter(char => char === '\uFFFD').length
    if (bad / Math.max(1, text.length) > 0.02) {
      try {
        const gbk = new TextDecoder('gbk').decode(buffer)
        if (!gbk.includes('\uFFFD')) return gbk
      } catch {
        // no GBK support in this ICU build; keep the utf8 result
      }
    }
  }
  return text
}

/**
 * Decode one tEXt / zTXt / iTXt payload.
 * @param {'tEXt' | 'zTXt' | 'iTXt'} type - chunk type that carried the payload.
 * @param {Buffer} data - chunk payload, keyword included.
 * @returns {{ keyword: string, value: string } | null}
 */
function decodeTextChunk(type, data) {
  const separator = data.indexOf(0)
  if (separator <= 0) return null
  const keyword = data.toString('latin1', 0, separator)
  const rest = data.subarray(separator + 1)
  try {
    if (type === 'tEXt') return { keyword, value: decodeUtf8(rest) }
    if (type === 'zTXt') return { keyword, value: decodeUtf8(zlib.inflateSync(rest.subarray(1))) }
    if (rest.length < 2) return null
    const compressed = rest[0] === 1
    let body = rest.subarray(2)
    const languageEnd = body.indexOf(0)
    if (languageEnd < 0) return null
    body = body.subarray(languageEnd + 1)
    const translatedEnd = body.indexOf(0)
    if (translatedEnd < 0) return null
    body = body.subarray(translatedEnd + 1)
    const raw = compressed ? zlib.inflateSync(body) : body
    return { keyword, value: decodeUtf8(raw) }
  } catch {
    return null
  }
}

/**
 * Walk PNG chunks and collect every textual chunk, plus IHDR dimensions.
 * @param {Buffer} buffer - complete file bytes.
 * @returns {{
 *   isPng: boolean,
 *   mediaType: 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown',
 *   width?: number,
 *   height?: number,
 *   text: Map<string, string>,
 * }}
 */
export function readPngInfo(buffer) {
  const mediaType = sniffMediaType(buffer)
  if (mediaType !== 'png') return { isPng: false, mediaType, text: new Map() }
  let offset = 8
  let width
  let height
  const text = new Map()
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    if (length > buffer.length - offset - 12) break
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR' && data.length >= 13) {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const entry = decodeTextChunk(type, data)
      if (entry && !text.has(entry.keyword)) text.set(entry.keyword, entry.value)
    }
    offset += 12 + length
    if (type === 'IEND') break
  }
  return { isPng: true, mediaType, width, height, text }
}

function parseJson(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

const LORA_TAG = /<lora:([^:>]+):([-+]?\d+(?:\.\d+)?)>/gi

function loraTagList(strings) {
  const tags = []
  for (const text of strings) {
    if (typeof text !== 'string' || !text.includes('<lora:')) continue
    LORA_TAG.lastIndex = 0
    let match
    while ((match = LORA_TAG.exec(text)) !== null) tags.push({ name: match[1].trim(), strength: Number(match[2]) })
  }
  return tags
}

/**
 * Follow one API-graph link to the text that produced its conditioning.
 * @param {Record<string, any>} api - API-format prompt graph.
 * @param {unknown} link - `[nodeId, outputIndex]` link.
 * @param {'positive' | 'negative' | 'any'} want - which slot is being resolved.
 * @param {number} depth - recursion guard.
 * @returns {string | null}
 */
function resolvePromptText(api, link, want, depth = 0) {
  if (depth > 8 || !Array.isArray(link)) return null
  const node = api[String(link[0])]
  const inputs = node && typeof node === 'object' ? node.inputs : undefined
  if (!inputs || typeof inputs !== 'object') return null
  if (want === 'positive' && typeof inputs.positive === 'string' && inputs.positive.trim()) return inputs.positive
  if (want === 'negative' && typeof inputs.negative === 'string' && inputs.negative.trim()) return inputs.negative
  const ownKeys = want === 'negative' ? ['text', 'text_0', 'prompt', 'string'] : ['text', 'text_0', 'prompt', 'string', 'positive']
  for (const key of ownKeys) {
    if (typeof inputs[key] === 'string' && inputs[key].trim()) return inputs[key]
  }
  for (const key of ['conditioning', 'conditioning_1', 'text', 'positive', 'negative', 'clip']) {
    if (Array.isArray(inputs[key])) {
      const found = resolvePromptText(api, inputs[key], want, depth + 1)
      if (found) return found
    }
  }
  return null
}

/**
 * Resolve a numeric input that may be a literal or a link to another node
 * (ComfyUI's Resolution Master / latent-size nodes pass width and height through
 * links, so `Number(link)` would be NaN).
 * @param {Record<string, any>} api - API-format prompt graph.
 * @param {unknown} value - literal or `[nodeId, outputIndex]` link.
 * @param {'width' | 'height' | 'batch_size'} key - input name to read at the source node.
 * @param {number} depth - recursion guard.
 * @returns {number | null}
 */
function resolveNumber(api, value, key, depth = 0) {
  if (depth > 6) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (Array.isArray(value)) {
    const source = api[String(value[0])]
    const inputs = source && typeof source === 'object' ? source.inputs : undefined
    if (!inputs || typeof inputs !== 'object') return null
    return inputs[key] === undefined ? null : resolveNumber(api, inputs[key], key, depth + 1)
  }
  return null
}

/**
 * Reduce a ComfyUI API prompt graph to the facts a model needs to reproduce it.
 * @param {Record<string, any>} api - API-format prompt graph from the PNG.
 * @returns {{
 *   nodeCount: number,
 *   nodeTypes: string[],
 *   model: { unet: string | null, clip: string | null, vae: string | null },
 *   loras: Array<{ name: string, strength: number }>,
 *   params: { seed?: number | string, steps?: number, cfg?: number, sampler?: string, scheduler?: string, denoise?: number },
 *   size: { width: number, height: number } | null,
 *   batch: number | null,
 *   positive: string | null,
 *   negative: string | null,
 * }}
 */
export function summarizeComfyPrompt(api) {
  const entries = Object.entries(api || {})
  const nodeTypes = entries.map(([, node]) => node?.class_type).filter(type => typeof type === 'string')
  const model = { unet: null, clip: null, vae: null }
  const loras = []
  const strings = []
  const params = {}
  let size = null
  let batch = null
  let seed

  for (const [, node] of entries) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    const type = String(node.class_type || '')
    for (const value of Object.values(inputs)) if (typeof value === 'string') strings.push(value)
    if (/UNETLoader|CheckpointLoader/i.test(type) && !model.unet) model.unet = inputs.unet_name || inputs.ckpt_name || null
    if (/CLIPLoader/i.test(type) && !model.clip) model.clip = inputs.clip_name || null
    if (/VAELoader/i.test(type) && !model.vae) model.vae = inputs.vae_name || null
    if (/LoraLoader|Lora ?Loader/i.test(type) && typeof inputs.lora_name === 'string') {
      const strength = inputs.strength_model ?? inputs.strength_clip ?? 1
      loras.push({ name: inputs.lora_name, strength: Number(strength) })
    }
    if (/KSampler|SamplerCustom/i.test(type) && params.steps === undefined) {
      if (inputs.seed !== undefined) seed = inputs.seed
      if (inputs.steps !== undefined) params.steps = Number(inputs.steps)
      if (inputs.cfg !== undefined) params.cfg = Number(inputs.cfg)
      if (typeof inputs.sampler_name === 'string') params.sampler = inputs.sampler_name
      if (typeof inputs.scheduler === 'string') params.scheduler = inputs.scheduler
      if (inputs.denoise !== undefined) params.denoise = Number(inputs.denoise)
    }
    if (!size && /EmptyLatentImage|EmptySD3LatentImage|Empty.*Latent/i.test(type)) {
      const width = resolveNumber(api, inputs.width, 'width')
      const height = resolveNumber(api, inputs.height, 'height')
      if (width && height) {
        size = { width, height }
        const batchSize = resolveNumber(api, inputs.batch_size, 'batch_size')
        if (batchSize !== null) batch = batchSize
      }
    }
  }

  for (const tag of loraTagList(strings)) {
    if (!loras.some(lora => lora.name === tag.name)) loras.push(tag)
  }

  let positive = null
  let negative = null
  const sampler = entries.find(([, node]) => /KSampler/i.test(String(node?.class_type || '')))
  if (sampler) {
    const inputs = sampler[1].inputs || {}
    positive = resolvePromptText(api, inputs.positive, 'positive')
    negative = resolvePromptText(api, inputs.negative, 'negative')
  }
  if (!positive) {
    // No sampler link to follow (bare graph / custom sampler): fall back to the
    // longest free-text input that is not a LoRA tag list.
    const candidates = strings.filter(text => text.trim().length > 20 && !/^<lora:/i.test(text.trim()))
    positive = candidates.sort((left, right) => right.length - left.length)[0] || null
  }
  if (seed !== undefined) params.seed = seed
  return {
    nodeCount: entries.length,
    nodeTypes,
    model,
    loras,
    params,
    size,
    batch,
    positive,
    negative,
  }
}

/**
 * Parse an A1111-style `parameters` chunk for older PNGs that carry no ComfyUI
 * graph (`prompt` + `Negative prompt:` + `Steps: ...`).
 * @param {string} text - raw `parameters` chunk text.
 * @returns {{
 *   positive: string | null,
 *   negative: string | null,
 *   params: { steps?: number, cfg?: number, sampler?: string, scheduler?: string, seed?: number },
 *   size: { width: number, height: number } | null,
 * }}
 */
export function parseA1111Parameters(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n')
  const marker = lines.search(/\nNegative prompt:/)
  const settingLine = lines.search(/\nSteps: /)
  const promptEnd = marker >= 0 ? marker : settingLine >= 0 ? settingLine : lines.length
  const positive = lines.slice(0, promptEnd).trim() || null
  const negative = marker >= 0
    ? lines.slice(marker + '\nNegative prompt:'.length, settingLine >= 0 ? settingLine : undefined).trim() || null
    : null
  const params = {}
  if (settingLine >= 0) {
    for (const part of lines.slice(settingLine + 1).split(',')) {
      const [rawKey, ...rest] = part.split(':')
      const key = rawKey.trim()
      const value = rest.join(':').trim()
      if (key === 'Steps') params.steps = Number(value)
      if (key === 'CFG scale') params.cfg = Number(value)
      if (key === 'Sampler') params.sampler = value
      if (key === 'Schedule type') params.scheduler = value
      if (key === 'Seed') params.seed = Number(value)
      if (key === 'Size') {
        const match = /^(\d+)x(\d+)$/.exec(value)
        if (match) params.size = { width: Number(match[1]), height: Number(match[2]) }
      }
    }
  }
  const size = params.size || null
  delete params.size
  return { positive, negative, params, size }
}

/**
 * Parse a ComfyUI UI-format `workflow` chunk into a light structural summary.
 * @param {unknown} workflow - parsed UI workflow JSON.
 * @returns {{ nodeCount: number, linkCount: number, groups: number, types: string[] } | null}
 */
export function summarizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return null
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const types = [...new Set(nodes.map(node => node?.type).filter(type => typeof type === 'string'))]
  return {
    nodeCount: nodes.length,
    linkCount: Array.isArray(workflow.links) ? workflow.links.length : 0,
    groups: Array.isArray(workflow.groups) ? workflow.groups.length : 0,
    types,
  }
}

/**
 * Everything the tool needs from one file, without filesystem access.
 * @param {Buffer} buffer - complete file bytes.
 * @returns {{
 *   mediaType: string,
 *   isPng: boolean,
 *   width?: number,
 *   height?: number,
 *   chunks: string[],
 *   comfyPrompt: Record<string, any> | null,
 *   comfyWorkflow: Record<string, any> | null,
 *   a1111: ReturnType<typeof parseA1111Parameters> | null,
 * }}
 */
export function inspectImageMetadata(buffer) {
  const info = readPngInfo(buffer)
  const chunks = [...info.text.keys()]
  const comfyPrompt = info.text.has('prompt') ? parseJson(info.text.get('prompt')) : null
  const comfyWorkflow = info.text.has('workflow') ? parseJson(info.text.get('workflow')) : null
  const a1111 = info.text.has('parameters') ? parseA1111Parameters(info.text.get('parameters')) : null
  return {
    mediaType: info.mediaType,
    isPng: info.isPng,
    width: info.width,
    height: info.height,
    chunks,
    comfyPrompt,
    comfyWorkflow,
    a1111,
  }
}

/** Decode `reg query` output: UTF-8, or the console codepage when the path has non-ASCII characters. */
function decodeConsoleText(buffer) {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buffer)
    if (!gbk.includes('\uFFFD')) return gbk
  } catch {
    // no GBK support; keep the utf8 result
  }
  return utf8
}

let cachedKnownFolders
/**
 * Resolve the user's actual Desktop / Pictures / Downloads folders on Windows.
 * Profiles whose Desktop / Pictures / Downloads folders were moved to another
 * drive do not live under the home directory, and the shell folders key is the
 * only reliable unsigned source.
 * @returns {string[]} known folder paths, or an empty array off Windows.
 */
function windowsKnownFolders() {
  if (cachedKnownFolders !== undefined) return cachedKnownFolders
  const folders = []
  if (process.platform === 'win32') {
    try {
      const raw = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'],
        { timeout: 3000, windowsHide: true },
      )
      const wanted = new Set(['Desktop', 'Personal', 'My Pictures', '{374DE290-123F-4565-9164-39C4925E467B}'])
      for (const line of decodeConsoleText(raw).split(/\r?\n/)) {
        const match = /^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line)
        if (match && wanted.has(match[1]) && match[2]) folders.push(match[2])
      }
    } catch {
      // registry unavailable: fall back to the home-directory guesses
    }
  }
  cachedKnownFolders = folders
  return folders
}

/**
 * Places a user-saved ComfyUI PNG is likely to be, ordered by hit rate.
 * @param {string} cwd - session working directory.
 * @param {string[]} extra - additional roots (e.g. the ComfyUI output directory).
 * @returns {string[]} candidate roots, missing ones included and ignored by the walk.
 */
export function defaultImageRoots(cwd, extra = []) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const roots = [
    ...extra,
    ...windowsKnownFolders(),
    home ? path.join(home, 'Downloads') : null,
    home ? path.join(home, 'Desktop') : null,
    home ? path.join(home, 'Pictures') : null,
    cwd,
  ].filter(Boolean)
  return [...new Set(roots)]
}

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'appdata'])

/**
 * Find a file by exact basename under the given roots, newest first.
 * Only used when the model knows the attachment's display name but not its
 * absolute path; the scan is depth- and count-capped so a big workspace cannot
 * turn one tool call into a filesystem crawl.
 * @param {string[]} roots - directories to search.
 * @param {string} basename - exact file name (case-insensitive).
 * @param {{ maxDepth?: number, limit?: number }} [options] - walk limits.
 * @returns {string[]} absolute paths, newest first.
 */
export function findImageByName(roots, basename, options = {}) {
  const target = String(basename || '').toLowerCase()
  if (!target || target.includes('/') || target.includes('\\')) return []
  const maxDepth = options.maxDepth ?? 2
  const limit = options.limit ?? 20
  const found = []
  let visited = 0
  const walk = (directory, depth) => {
    if (depth > maxDepth || found.length >= limit || visited >= 20000) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= 20000 || found.length >= limit) return
      visited += 1
      const name = entry.name
      if (name.startsWith('.') || SKIP_DIRECTORIES.has(name.toLowerCase())) continue
      const full = path.join(directory, name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (name.toLowerCase() === target) {
        found.push(full)
      }
    }
  }
  for (const root of roots) {
    if (root) walk(root, 0)
  }
  return found
    .map(file => {
      let mtime = 0
      try {
        mtime = statSync(file).mtimeMs
      } catch {
        // keep mtime 0; the path still stays usable
      }
      return { file, mtime }
    })
    .sort((left, right) => right.mtime - left.mtime)
    .map(item => item.file)
}

// ---------------------------------------------------------------------------
// Capture store
//
// The upload route hands the *original* PNG bytes to the attachment service,
// which immediately normalizes them into a metadata-free JPEG. A host hook in
// lib/host/index.js parses those bytes first and persists the ComfyUI chunks
// under the normalized attachment id (`sha256:...`). The message already shows
// that id, so a later tool call can resolve the recipe with no file path at all.
// ---------------------------------------------------------------------------

const STORE_VERSION = 1
const STORE_KEEP = 300

/** Absolute DSH home used by the running host. */
export function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Directory holding one `<sha256>.json` capture per uploaded image. */
export function pnginfoStoreDir() {
  return path.join(dshHomeDir(), 'drawing-pnginfo')
}

/**
 * Canonicalize an attachment id or bare digest.
 * @param {unknown} value - `sha256:<hex>`, `<hex>`, or anything else.
 * @returns {string | null} lowercase 64-character hex digest.
 */
export function attachmentHash(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/^sha256:/i, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null
}

/**
 * @param {Buffer | Uint8Array} bytes - complete bytes.
 * @returns {string} lowercase hex sha256.
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function storeFile(dir, hash) {
  return path.join(dir, `${hash}.json`)
}

function readStoreIndex(dir) {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'))
    if (!value || typeof value !== 'object') return { version: STORE_VERSION, names: {} }
    if (!value.names || typeof value.names !== 'object') value.names = {}
    return value
  } catch {
    return { version: STORE_VERSION, names: {} }
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  renameSync(temporary, file)
}

function updateStoreIndex(dir, sidecar) {
  if (!sidecar.name) return
  try {
    const index = readStoreIndex(dir)
    index.version = STORE_VERSION
    index.names[String(sidecar.name).toLowerCase()] = attachmentHash(sidecar.attachmentId)
    index.updatedAt = sidecar.capturedAt
    writeJsonAtomic(path.join(dir, 'index.json'), index)
  } catch {
    // the name index is a convenience; the hash lookup still works
  }
}

function pruneStore(dir) {
  try {
    const files = readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name))
    if (files.length <= STORE_KEEP) return
    const ordered = files
      .map(name => {
        let mtime = 0
        try {
          mtime = statSync(path.join(dir, name)).mtimeMs
        } catch {
          // keep 0; still a prune candidate
        }
        return { name, mtime }
      })
      .sort((left, right) => left.mtime - right.mtime)
    for (const item of ordered.slice(0, ordered.length - STORE_KEEP)) {
      try {
        rmSync(path.join(dir, item.name), { force: true })
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

/**
 * Persist the ComfyUI chunks of one uploaded original PNG under its durable
 * normalized attachment id.
 * @param {Buffer | Uint8Array | ArrayBuffer} bytes - original bytes the upload route received.
 * @param {{ attachmentId?: string, name?: string, mediaType?: string, width?: number, height?: number }} ref - normalized attachment reference.
 * @returns {Record<string, any> | null} the written sidecar, or null when the image carried no recipe.
 */
export function captureImageBytes(bytes, ref) {
  if (!ref || typeof ref.attachmentId !== 'string') return null
  const hash = attachmentHash(ref.attachmentId)
  if (!hash) return null
  if (!bytes) return null
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof ArrayBuffer
      ? Buffer.from(bytes)
      : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
  if (buffer.length < 8) return null
  const info = readPngInfo(buffer)
  if (!info.isPng) return null
  const prompt = info.text.get('prompt') ?? null
  const parameters = info.text.get('parameters') ?? null
  const workflow = info.text.get('workflow') ?? null
  if (prompt === null && parameters === null && workflow === null) return null
  let workflowNodeCount = null
  if (workflow) {
    const parsed = parseJson(workflow)
    workflowNodeCount = parsed && Array.isArray(parsed.nodes) ? parsed.nodes.length : null
  }
  const dir = pnginfoStoreDir()
  mkdirSync(dir, { recursive: true })
  const sidecar = {
    version: STORE_VERSION,
    attachmentId: `sha256:${hash}`,
    name: typeof ref.name === 'string' && ref.name ? ref.name : null,
    mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
    width: Number.isFinite(ref.width) ? ref.width : info.width ?? null,
    height: Number.isFinite(ref.height) ? ref.height : info.height ?? null,
    capturedAt: new Date().toISOString(),
    workflowNodeCount,
    workflow,
    prompt,
    parameters,
  }
  try {
    writeJsonAtomic(storeFile(dir, hash), sidecar)
    updateStoreIndex(dir, sidecar)
    pruneStore(dir)
  } catch {
    return null
  }
  return sidecar
}

/**
 * Read one captured recipe by attachment id or bare digest.
 * @param {unknown} hashValue - `sha256:<hex>` or `<hex>`.
 * @returns {Record<string, any> | null}
 */
export function readCapturedRecipe(hashValue) {
  const hash = attachmentHash(hashValue)
  if (!hash) return null
  try {
    const value = JSON.parse(readFileSync(storeFile(pnginfoStoreDir(), hash), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Find a captured recipe by the display name shown in the chat attachment.
 * @param {string} name - original file name.
 * @returns {Record<string, any> | null}
 */
export function findCapturedByName(name) {
  if (typeof name !== 'string' || !name.trim()) return null
  const index = readStoreIndex(pnginfoStoreDir())
  const hash = index.names[name.trim().toLowerCase()]
  return hash ? readCapturedRecipe(hash) : null
}

/**
 * Diagnostic snapshot for the host route and the tool's "no capture" message.
 * @returns {{ dir: string, count: number }}
 */
export function captureStoreStatus() {
  const dir = pnginfoStoreDir()
  let count = 0
  try {
    count = readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length
  } catch {
    count = 0
  }
  return { dir, count }
}

// ---------------------------------------------------------------------------
// 原图副本（originals）
//
// 聊天附件会被归一化重编码（PNG → JPEG），tEXt 块随之消失。入库钩子只保住了
// 配方 JSON；这里再存一份**原始字节**，粘贴/拖入时由客户端上传，供 pnginfo 直接
// 解析，也方便事后核对。目录按条数和总量设上限，超了淘汰最旧的。
// ---------------------------------------------------------------------------

const ORIGINAL_DIR_NAME = 'originals'
const ORIGINAL_KEEP = 64
const ORIGINAL_MAX_BYTES = 256 * 1024 * 1024

/** Directory holding one unmodified upload per sha256 (plus a `.json` sidecar). */
export function originalsDir() {
  return path.join(pnginfoStoreDir(), ORIGINAL_DIR_NAME)
}

function extensionFor(mediaType, name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.bin'
}

function pruneOriginals(dir) {
  let records = []
  try {
    records = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(dir, name)
        try {
          const record = JSON.parse(readFileSync(file, 'utf8'))
          return { record, file }
        } catch {
          return null
        }
      })
      .filter((entry) => entry !== null)
  } catch {
    return
  }
  records.sort((left, right) => String(right.record.savedAt ?? '').localeCompare(String(left.record.savedAt ?? '')))
  let total = 0
  for (const [index, entry] of records.entries()) {
    total += Number(entry.record.bytes) || 0
    if (index < ORIGINAL_KEEP && total <= ORIGINAL_MAX_BYTES) continue
    try { rmSync(entry.file, { force: true }) } catch {}
    if (typeof entry.record.file === 'string') {
      try { rmSync(entry.record.file, { force: true }) } catch {}
    }
  }
}

/**
 * Store one unmodified upload. Idempotent: the same bytes overwrite the same slot.
 * @param {Buffer | Uint8Array} bytes
 * @param {{ sha256?: string | null, name?: string | null, sourcePath?: string | null }} [meta]
 */
export function saveOriginal(bytes, { sha256 = null, name = null, sourcePath = null } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length === 0) throw new Error('原图为空。')
  const actual = sha256Hex(buffer)
  const hash = attachmentHash(sha256) ?? actual
  if (hash !== actual) throw new Error('原始字节与声明的 sha256 不一致。')
  const dir = originalsDir()
  mkdirSync(dir, { recursive: true })
  const mediaType = sniffMediaType(buffer)
  const file = path.join(dir, `${hash}${extensionFor(mediaType, name)}`)
  writeFileSync(file, buffer)
  const record = {
    version: 1,
    sha256: hash,
    name: typeof name === 'string' && name !== '' ? name : null,
    sourcePath: typeof sourcePath === 'string' && sourcePath !== '' ? sourcePath : null,
    mediaType,
    bytes: buffer.length,
    savedAt: new Date().toISOString(),
    file,
  }
  writeJsonAtomic(path.join(dir, `${hash}.json`), record)
  pruneOriginals(dir)
  return record
}

/** Sidecar for a stored original, or null. */
export function originalRecord(hashValue) {
  const hash = attachmentHash(hashValue)
  if (!hash) return null
  try {
    const record = JSON.parse(readFileSync(path.join(originalsDir(), `${hash}.json`), 'utf8'))
    if (!record || record.sha256 !== hash || typeof record.file !== 'string') return null
    return record
  } catch {
    return null
  }
}

/** The stored original bytes (re-verified against the hash), or null. */
export function readOriginal(hashValue) {
  const record = originalRecord(hashValue)
  if (!record) return null
  try {
    const bytes = readFileSync(record.file)
    if (sha256Hex(bytes) !== record.sha256) return null
    return { bytes, record }
  } catch {
    return null
  }
}
