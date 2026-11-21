// Hugging Face as a second model source: search repos, list files, resolve URLs.
import path from 'node:path'

/** 首选官方站，网络失败时退到常用镜像（路径与鉴权头一致）。 */
export const HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']
const API = `${HF_HOSTS[0]}/api`
const RESOLVE = HF_HOSTS[0]

async function fetchWithHosts(pathname, { token = null, timeoutMs = 20_000, init = {}, onAttempt = null, report = null } = {}) {
  const attempts = []
  let lastError = null
  const note = (attempt) => {
    attempts.push(attempt)
    if (typeof onAttempt === 'function') onAttempt(attempt)
    if (report !== null && typeof report === 'object') report.attempts = attempts
  }
  for (const host of HF_HOSTS) {
    try {
      const response = await fetch(`${host}${pathname}`, {
        ...init,
        headers: { 'user-agent': 'dsh-drawing-tools', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
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
  const error = new Error(`访问 Hugging Face 失败（已试 ${attempts.length} 个站点）：${detail || redact(String(lastError?.message ?? lastError))}`)
  error.attempts = attempts
  throw error
}
const MODEL_EXT = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])

const redact = (text) => (typeof text === 'string' ? text.replace(/(Bearer\s+)[\w.-]+/gi, '$1***') : text)

async function getJson(target, { token, timeoutMs = 20_000, onAttempt = null, report = null } = {}) {
  // 调用方可能传字符串（仓库路径）或 URL（搜索参数），统一成 URL。
  const url = typeof target === 'string' ? new URL(target) : target
  let response
  try {
    // pathname 已包含 /api 前缀；fetchWithHosts 只拼 host。
    ;({ response } = await fetchWithHosts(`${url.pathname}${url.search}`, { token, timeoutMs, onAttempt, report }))
  } catch (error) {
    throw new Error(`访问 Hugging Face 失败：${redact(String(error?.message ?? error))}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Hugging Face 返回 ${response.status}：这个仓库需要登录（gated）。请在「设置 → AI 绘画」里填 Hugging Face token，或设置环境变量 HF_TOKEN。`)
  }
  if (!response.ok) throw new Error(`Hugging Face 返回 HTTP ${response.status}`)
  return response.json()
}

/**
 * 搜索仓库。返回仓库级候选：真正的文件名与大小要等 download 前用 listFiles 取，
 * 这样搜索本身很便宜。
 */
export async function searchModels({ query, limit = 10, token = null, onAttempt = null, report = null } = {}) {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('搜索需要 query。')
  const url = new URL(`${API}/models`)
  url.searchParams.set('search', query.trim())
  url.searchParams.set('limit', String(Math.min(30, Math.max(1, Number(limit) || 10))))
  url.searchParams.set('sort', 'downloads')
  url.searchParams.set('direction', '-1')
  const items = await getJson(url, { token, onAttempt, report })
  return (Array.isArray(items) ? items : []).map((item) => ({
    source: 'huggingface',
    repo: item.id,
    name: item.id,
    downloads: typeof item.downloads === 'number' ? item.downloads : null,
    likes: typeof item.likes === 'number' ? item.likes : null,
    pipelineTag: item.pipeline_tag ?? null,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
  }))
}

/** 列出仓库里可作为模型的单个文件（含 LFS 的 sha256）。 */
export async function listFiles({ repo, revision = 'main', token = null, limit = 40, onAttempt = null, report = null } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('需要 repo，例如 some-org/some-model。')
  const url = new URL(`${API}/models/${repo}/tree/${revision}`)
  url.searchParams.set('recursive', 'false')
  const items = await getJson(url, { token, onAttempt, report })
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.type === 'file' && MODEL_EXT.has(path.extname(String(item.path)).toLowerCase()))
    .slice(0, limit)
    .map((item) => ({
      source: 'huggingface',
      repo,
      revision,
      fileName: path.basename(String(item.path)),
      path: String(item.path),
      bytes: typeof item.size === 'number' ? item.size : null,
      sha256: item?.lfs?.oid ?? null,
      downloadUrl: `${RESOLVE}/${repo}/resolve/${revision}/${encodeURIComponent(String(item.path)).replace(/%2F/g, '/')}`,
    }))
}

/** 仓库级元数据：pipeline、tags、下载量，以及 LoRA 常见的 instance_prompt。 */
export async function repoInfo({ repo, token = null, onAttempt = null, report = null } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('需要 repo。')
  const data = await getJson(`${API}/models/${repo}`, { token, onAttempt, report })
  const card = data?.cardData !== null && typeof data?.cardData === 'object' ? data.cardData : {}
  const prompt = typeof card.instance_prompt === 'string' ? card.instance_prompt : typeof card.trigger_word === 'string' ? card.trigger_word : null
  return {
    source: 'huggingface',
    repo,
    pipelineTag: data?.pipeline_tag ?? null,
    tags: Array.isArray(data?.tags) ? data.tags.slice(0, 20) : [],
    downloads: typeof data?.downloads === 'number' ? data.downloads : null,
    likes: typeof data?.likes === 'number' ? data.likes : null,
    triggerWords: prompt === null ? [] : String(prompt).split(',').map((word) => word.trim()).filter(Boolean).slice(0, 20),
    triggerAlternatives: prompt === null ? [] : [String(prompt)].filter((entry) => /\s\|\s|\s+or\s+/i.test(entry)),
    pageUrl: `https://huggingface.co/${repo}`,
  }
}

export const downloadUrlFor = (repo, filePath, revision = 'main') =>
  `${RESOLVE}/${repo}/resolve/${revision}/${String(filePath).split('/').map(encodeURIComponent).join('/')}`
