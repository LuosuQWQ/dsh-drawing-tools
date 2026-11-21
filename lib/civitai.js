// Civitai access: token resolution through DSH credentials, model search and download.
//
// The token never leaves the host: it is resolved per operation, never logged, never
// returned to the model, and never written into configuration.
import fs from 'node:fs/promises'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

/** 凭据引用：既是 credential ref，也是生效时的环境变量名。 */
export const CIVITAI_REF_NAME = 'CIVITAI_TOKEN'

let brander = null
try {
  ({ credentialRef: brander } = await import('@deepseek-ai/dsh-credentials'))
} catch {
  // 插件可能安装在拿不到该包的环境里；credential ref 运行时就是字符串。
  brander = null
}
export const CIVITAI_REF = brander ? brander(CIVITAI_REF_NAME) : CIVITAI_REF_NAME
/** 任意环境变量名 → credential ref（同一个名字既是 ref 也是 env 兜底键）。 */
export const credentialRefFor = (name) => (brander ? brander(name) : name)

/** 旧版把 token 放在这两个文件里；只用于一次性导入提示，不再直接读取使用。 */
export function legacyTokenFiles() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return [path.join(home, '.dsh', 'civitai_token'), path.join(os.homedir(), '.civitai_token')]
}

export async function readLegacyToken() {
  for (const file of legacyTokenFiles()) {
    try {
      const value = (await fs.readFile(file, 'utf8')).trim()
      if (value !== '') return { value, file }
    } catch {
      // 不存在就是没有
    }
  }
  return null
}

/** 把 token 从任何文本里抹掉：错误信息可能带 URL/headers。 */
export function redact(value) {
  if (typeof value !== 'string' || value === '') return value
  return value.replace(/(token=)[^&\s"']+/gi, '$1***').replace(/(Bearer\s+)[\w.-]+/gi, '$1***')
}

/** 每次操作现取；没有凭据服务时退回环境变量（DSH 的本地凭据库同样把 env 作为兜底层）。 */
export async function resolveNamedToken(credentials, name) {
  const ref = credentialRefFor(name)
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value !== '') return { value: hit.value, source: hit.source ?? 'credentials' }
    } catch {
      // 凭据服务异常时不要因此让下载失败，继续看环境变量
    }
  }
  const env = process.env[name]
  if (typeof env === 'string' && env.trim() !== '') return { value: env.trim(), source: 'env' }
  return null
}

/** Civitai token（保留旧名，行为不变）。 */
export const resolveToken = (credentials) => resolveNamedToken(credentials, CIVITAI_REF_NAME)

/** 给设置页用的状态；绝不返回值本身。 */
export async function describeNamedToken(credentials, name) {
  const legacy = name === CIVITAI_REF_NAME ? await readLegacyToken() : null
  const ref = credentialRefFor(name)
  const fallback = { configured: false, source: undefined, writable: false, legacyFile: legacy?.file ?? null }
  if (credentials && typeof credentials.describe === 'function') {
    try {
      const info = await credentials.describe(ref)
      return {
        configured: Boolean(info?.configured),
        source: info?.source,
        writable: Boolean(info?.writable),
        masked: info?.masked,
        legacyFile: info?.configured ? null : legacy?.file ?? null,
      }
    } catch (error) {
      return { ...fallback, error: redact(String(error?.message ?? error)) }
    }
  }
  const env = process.env[CIVITAI_REF_NAME]
  return { ...fallback, configured: Boolean(env && env.trim()), source: env ? 'env' : undefined }
}

export const describeToken = (credentials) => describeNamedToken(credentials, CIVITAI_REF_NAME)

export async function setNamedToken(credentials, name, token) {
  if (typeof token !== 'string' || token.trim() === '') throw new Error('token 不能为空。')
  if (!credentials || typeof credentials.set !== 'function') {
    throw new Error('当前 DSH 没有凭据服务，无法保存 token；请改用环境变量 ' + name + '。')
  }
  await credentials.set(credentialRefFor(name), token.trim())
}

export async function clearNamedToken(credentials, name) {
  if (!credentials || typeof credentials.unset !== 'function') throw new Error('当前 DSH 没有凭据服务，无法清除 token。')
  await credentials.unset(credentialRefFor(name))
}

export async function setToken(credentials, token) {
  if (typeof token !== 'string' || token.trim() === '') throw new Error('token 不能为空。')
  if (!credentials || typeof credentials.set !== 'function') {
    throw new Error('当前 DSH 没有凭据服务，无法保存 token；请改用环境变量 CIVITAI_TOKEN。')
  }
  await credentials.set(CIVITAI_REF, token.trim())
}

export async function clearToken(credentials) {
  if (!credentials || typeof credentials.unset !== 'function') throw new Error('当前 DSH 没有凭据服务，无法清除 token。')
  await credentials.unset(CIVITAI_REF)
}

/** 首选官方站，网络层失败时退到社区镜像（同一套 API 与下载路径）。 */
export const CIVITAI_HOSTS = ['https://civitai.com', 'https://civitai.red']
const API_BASE = `${CIVITAI_HOSTS[0]}/api/v1`

/**
 * 依次尝试各站点；只在"连不上 / 5xx"时换下一个，4xx 直接返回给调用方判断
 * （401/403 是凭据问题，换站点没有意义）。
 * @returns {Promise<{response: Response, host: string}>}
 */
export async function fetchWithHosts(pathname, { token = null, timeoutMs = 20_000, init = {}, onAttempt = null, report = null } = {}) {
  const attempts = []
  let lastError = null
  const note = (attempt) => {
    attempts.push(attempt)
    if (typeof onAttempt === 'function') onAttempt(attempt)
    if (report !== null && typeof report === 'object') report.attempts = attempts
  }
  for (const host of CIVITAI_HOSTS) {
    try {
      const response = await fetch(`${host}${pathname}`, {
        ...init,
        headers: { 'user-agent': 'dsh-drawing-tools', accept: 'application/json', ...authHeaders(token), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 5xx 视为站点问题：记下来立刻换下一站；4xx 交给调用方判断（多为凭据问题）。
      if (response.status >= 500) {
        note({ host, ok: false, status: response.status, error: `HTTP ${response.status}` })
        lastError = new Error(`HTTP ${response.status}`)
        continue
      }
      note({ host, ok: true, status: response.status })
      if (report !== null && typeof report === 'object') report.host = host
      return { response, host, attempts }
    } catch (error) {
      const message = redact(String(error?.message ?? error))
      note({ host, ok: false, error: message })
      lastError = error
    }
  }
  const detail = attempts.map((attempt) => `${attempt.host}: ${attempt.error ?? attempt.status ?? '无响应'}`).join('；')
  const error = new Error(`访问 Civitai 失败（已试 ${attempts.length} 个站点）：${detail || redact(String(lastError?.message ?? lastError))}`)
  error.attempts = attempts
  throw error
}
const TYPE_TO_FOLDER = { LORA: 'loras', Checkpoint: 'checkpoints', TextEncoder: 'text_encoders', VAE: 'vae', Controlnet: 'controlnet' }
export const CIVITAI_TYPES = Object.keys(TYPE_TO_FOLDER)
export const folderForType = (type) => TYPE_TO_FOLDER[type] ?? 'loras'

/**
 * 触发词的三种形态：
 * - 一组要同时用的词（Civitai 的 trainedWords 常见，如 ["lineart","monochrome"]）
 * - 备选（作者写成 "a | b" 或 "a or b"，用其中一组即可）
 * - 只在描述文字里写的提示（很多 LoRA 的激活词只出现在 model card 里）
 */
function splitCommas(value) {
  return String(value).split(',').map((piece) => piece.trim()).filter((piece) => piece !== '')
}

function isAlternatives(entry) {
  return /\s\|\s|\s+or\s+/i.test(entry)
}

function normalizeTriggerWords(rawWords) {
  const seen = new Set()
  const words = []
  for (const raw of Array.isArray(rawWords) ? rawWords : []) {
    for (const piece of splitCommas(raw)) {
      const key = piece.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      words.push(piece)
    }
  }
  return words
}

function triggerAlternatives(rawWords) {
  return (Array.isArray(rawWords) ? rawWords : []).map((raw) => String(raw).trim()).filter((entry) => entry !== '' && isAlternatives(entry))
}

/** 从模型描述里抽出触发词/激活词相关的句子（去 HTML 标签，最多 3 条）。 */
export function extractTriggerHints(description) {
  if (typeof description !== 'string' || description === '') return []
  const hints = []
  for (const rawLine of description.split(/\r?\n/)) {
    const line = rawLine.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (line === '') continue
    if (/trigger|activation|唤醒|触发|激活|关键字|关键词|keyword/i.test(line)) {
      hints.push(line.slice(0, 300))
      if (hints.length >= 3) break
    }
  }
  return hints
}

/**
 * 单个版本的完整元数据：触发词、基础模型、标签、候选文件与页面链接。
 * 下载前拿它落盘，之后 drawing_models / drawing_pnginfo 都能离线读到。
 */
export async function versionMetadata(versionId, { token = null, timeoutMs = 20_000, onAttempt = null, report = null } = {}) {
  if (versionId === undefined || versionId === null || String(versionId).trim() === '') throw new Error('需要 versionId。')
  let response
  try {
    ;({ response } = await fetchWithHosts(`/api/v1/model-versions/${versionId}`, { token, timeoutMs, onAttempt, report }))
  } catch (error) {
    throw new Error(`读取 Civitai 版本信息失败：${redact(String(error?.message ?? error))}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Civitai 返回 ${response.status}：这个模型需要登录凭据才能读取元数据。`)
  }
  if (!response.ok) throw new Error(`读取 Civitai 版本信息失败：HTTP ${response.status}`)
  const data = await response.json()
  const files = Array.isArray(data?.files) ? data.files : []
  const primary = files.find((file) => file?.primary) ?? files[0] ?? null
  return {
    source: 'civitai',
    modelId: data?.modelId ?? null,
    modelName: data?.model?.name ?? null,
    modelType: data?.model?.type ?? null,
    versionId: data?.id ?? versionId,
    versionName: data?.name ?? null,
    baseModel: data?.baseModel ?? null,
    trainedWords: normalizeTriggerWords(data?.trainedWords),
    triggerAlternatives: triggerAlternatives(data?.trainedWords),
    triggerHints: extractTriggerHints(data?.description),
    tags: Array.isArray(data?.model?.tags) ? data.model.tags.slice(0, 12) : [],
    description: typeof data?.description === 'string' ? data.description.slice(0, 1200) : '',
    pageUrl: data?.modelId ? `https://civitai.com/models/${data.modelId}${data?.id ? `?modelVersionId=${data.id}` : ''}` : null,
    fileName: primary?.name ?? null,
    sizeKB: typeof primary?.sizeKB === 'number' ? primary.sizeKB : null,
    sha256: primary?.hashes?.SHA256 ?? null,
    downloadUrl: data?.downloadUrl ?? primary?.downloadUrl ?? null,
  }
}

const authHeaders = (token) => (token ? { authorization: `Bearer ${token}` } : {})

/** 搜索模型；token 可选（公开模型不需要，部分模型需要登录）。 */
export async function searchModels({ query, type = 'LORA', limit = 10, nsfw = false, token = null, timeoutMs = 20_000, onAttempt = null, report = null } = {}) {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('搜索需要 query。')
  const url = new URL(`${API_BASE}/models`)
  url.searchParams.set('query', query.trim())
  if (type) url.searchParams.set('types', type)
  url.searchParams.set('limit', String(Math.min(20, Math.max(1, Number(limit) || 10))))
  if (nsfw) url.searchParams.set('nsfw', 'true')
  let response
  try {
    ;({ response } = await fetchWithHosts(`/api/v1/models?${url.searchParams.toString()}`, { token, timeoutMs, onAttempt, report }))
  } catch (error) {
    throw new Error(`搜索 Civitai 失败：${redact(String(error?.message ?? error))}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Civitai 返回 ${response.status}：这个搜索需要登录凭据。请在「设置 → AI 绘画」里填 Civitai token，或设置环境变量 CIVITAI_TOKEN。`)
  }
  if (!response.ok) throw new Error(`搜索 Civitai 失败：HTTP ${response.status}`)
  const data = await response.json()
  const items = Array.isArray(data?.items) ? data.items : []
  return items.map((item) => {
    const versions = Array.isArray(item.modelVersions) ? item.modelVersions : []
    const version = versions[0] ?? null
    const files = Array.isArray(version?.files) ? version.files : []
    const file = files.find((candidate) => candidate?.primary) ?? files[0] ?? null
    return {
      modelId: item.id,
      name: item.name,
      type: item.type,
      nsfw: Boolean(item.nsfw),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
      versionId: version?.id ?? null,
      versionName: version?.name ?? null,
      baseModel: version?.baseModel ?? null,
      trainedWords: normalizeTriggerWords(version?.trainedWords),
      triggerAlternatives: triggerAlternatives(version?.trainedWords),
      fileName: file?.name ?? null,
      sizeKB: typeof file?.sizeKB === 'number' ? file.sizeKB : null,
      sha256: file?.hashes?.SHA256 ?? null,
      downloadUrl: file?.downloadUrl ?? null,
      pageUrl: item.id ? `https://civitai.com/models/${item.id}${version?.id ? `?modelVersionId=${version.id}` : ''}` : null,
    }
  })
}
