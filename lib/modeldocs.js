// Model documentation: fetch official model cards / guides, store them in one
// canonical place, and read them back when a model is used.
//
// 规范：
// - 目录固定为 <models>/.dsh-docs/<kind>/<slug>/（跟着模型走，离线可读）。
// - 每份文档一个 index.json（来源 URL、抓取时间、字节、sha256）+ README.md（正文）。
// - 抓取来源：Hugging Face 模型卡与仓库内 *.md；Civitai 版本/模型描述；本地文件导入。
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'

export const DOCS_DIRNAME = '.dsh-docs'

export function docsRoot(modelsRoot) {
  return typeof modelsRoot === 'string' && modelsRoot !== '' ? path.join(modelsRoot, DOCS_DIRNAME) : null
}

export function docSlug(name) {
  const base = path.basename(String(name ?? ''), path.extname(String(name ?? '')))
  const slug = base.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug === '' ? 'model' : slug
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** 去掉 HTML 标签与常见实体，把模型卡描述变成纯文本。 */
export function stripHtml(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 写入一份文档。kind 决定目录（lora / checkpoint / diffusion_model / vae / ...）。
 * @returns {Promise<{dir:string, index:string, text:string, entry:object}>}
 */
export async function saveDoc(modelsRoot, { kind = 'lora', modelName, source, url = null, title = null, text, meta = null }) {
  const root = docsRoot(modelsRoot)
  if (root === null) throw new Error('模型根未知，无法保存文档；先让 ComfyUI 运行或在配置里指定 modelsRoot。')
  if (typeof modelName !== 'string' || modelName.trim() === '') throw new Error('保存文档需要 modelName。')
  if (typeof text !== 'string' || text.trim() === '') throw new Error('文档内容为空。')
  const slug = docSlug(modelName)
  const dir = path.join(root, kind, slug)
  await fs.mkdir(dir, { recursive: true })
  const body = text.trim().endsWith('\n') ? text.trim() : `${text.trim()}\n`
  await fs.writeFile(path.join(dir, 'README.md'), body, 'utf8')
  const entry = {
    kind,
    modelName,
    slug,
    title: title ?? modelName,
    source,
    url,
    fetchedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(body, 'utf8'),
    sha256: sha256(body),
    meta,
  }
  const index = path.join(dir, 'index.json')
  await fs.writeFile(index, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  return { dir, index, text: body, entry }
}

/** 按名字读一份文档：先精确 slug，再在各 kind 里找同名模型。 */
export async function readDoc(modelsRoot, { kind = null, modelName }) {
  const root = docsRoot(modelsRoot)
  if (root === null) return null
  const candidates = []
  if (kind !== null) candidates.push(path.join(root, kind, docSlug(modelName)))
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      candidates.push(path.join(root, entry.name, docSlug(modelName)))
    }
  } catch {
    return null
  }
  for (const dir of [...new Set(candidates)]) {
    try {
      const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'))
      const text = await fs.readFile(path.join(dir, 'README.md'), 'utf8')
      return { ...index, dir, text }
    } catch {
      // 继续找下一个
    }
  }
  return null
}

/** 列出所有已保存的文档（按抓取时间倒序）。 */
export async function listDocs(modelsRoot) {
  const root = docsRoot(modelsRoot)
  if (root === null) return []
  const out = []
  let kinds = []
  try {
    kinds = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const kind of kinds) {
    if (!kind.isDirectory()) continue
    let slugs = []
    try {
      slugs = await fs.readdir(path.join(root, kind.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue
      try {
        const index = JSON.parse(await fs.readFile(path.join(root, kind.name, slug.name, 'index.json'), 'utf8'))
        out.push({ ...index, dir: path.join(root, kind.name, slug.name) })
      } catch {
        // 坏目录跳过
      }
    }
  }
  out.sort((left, right) => String(right.fetchedAt ?? '').localeCompare(String(left.fetchedAt ?? '')))
  return out
}

const uniq = (items) => [...new Set(items.filter(Boolean))]

/**
 * 抓 Hugging Face 的模型卡与仓库内文档。
 * @returns {Promise<{title:string, text:string, sources:string[], meta:object}>}
 */
export async function fetchHuggingFaceDocs({ repo, token = null, maxExtraFiles = 3, timeoutMs = 25_000 } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('需要 repo（org/name）。')
  const host = 'https://huggingface.co'
  const auth = token ? { authorization: `Bearer ${token}` } : {}
  const get = async (url) => {
    const response = await fetch(url, { headers: { accept: 'text/plain, application/json', 'user-agent': 'dsh-drawing-tools', ...auth }, signal: AbortSignal.timeout(timeoutMs) })
    return response
  }
  const card = await get(`${host}/api/models/${repo}`).then((response) => (response.ok ? response.json() : null)).catch(() => null)
  const readmeUrls = [`${host}/${repo}/raw/main/README.md`, `${host}/${repo}/raw/master/README.md`]
  let readme = null
  let readmeUrl = null
  for (const url of readmeUrls) {
    const response = await get(url).catch(() => null)
    if (response && response.ok) {
      readme = await response.text()
      readmeUrl = url
      break
    }
  }
  // 仓库里除 README 外的说明文件（docs/*.md、USAGE*.md、prompt*.md 等）
  const extra = []
  const tree = await get(`${host}/api/models/${repo}/tree/main`).then((response) => (response.ok ? response.json() : [])).catch(() => [])
  const docs = (Array.isArray(tree) ? tree : [])
    .filter((file) => file.type === 'file' && /\.md$/i.test(file.path) && file.path.toLowerCase() !== 'readme.md')
    .filter((file) => /(docs?\/|usage|guide|prompt|manual|example|instruct)/i.test(file.path))
    .slice(0, maxExtraFiles)
  for (const file of docs) {
    const url = `${host}/${repo}/raw/main/${file.path.split('/').map(encodeURIComponent).join('/')}`
    const response = await get(url).catch(() => null)
    if (response && response.ok) extra.push({ path: file.path, url, text: await response.text() })
  }
  if (readme === null && extra.length === 0) throw new Error(`Hugging Face 仓库 ${repo} 没有可读的 README 或文档文件。`)
  const sections = []
  if (readme !== null) sections.push(`# 官方模型卡（${repo}）\n\n${readme.trim()}`)
  for (const file of extra) sections.push(`# ${file.path}\n\n${file.text.trim()}`)
  return {
    title: card?.cardData?.model_name ?? card?.id ?? repo,
    text: sections.join('\n\n---\n\n'),
    sources: uniq([readmeUrl, ...extra.map((file) => file.url)]),
    meta: {
      repo,
      pipelineTag: card?.pipeline_tag ?? null,
      tags: Array.isArray(card?.tags) ? card.tags.slice(0, 20) : [],
      files: extra.map((file) => file.path),
    },
  }
}

/**
 * 抓 Civitai 的描述（模型 + 版本）与触发词。
 * @returns {Promise<{title:string, text:string, sources:string[], meta:object}>}
 */
export async function fetchCivitaiDocs({ civitai, versionId, token = null } = {}) {
  if (civitai === undefined || typeof civitai.fetchWithHosts !== 'function') throw new Error('缺少 Civitai 客户端。')
  const { response, host } = await civitai.fetchWithHosts(`/api/v1/model-versions/${versionId}`, { token })
  if (!response.ok) throw new Error(`读取 Civitai 版本信息失败：HTTP ${response.status}`)
  const data = await response.json()
  const modelDescription = stripHtml(data?.model?.description ?? '')
  const versionDescription = stripHtml(data?.description ?? '')
  const trained = Array.isArray(data?.trainedWords) ? data.trainedWords : []
  const blocks = [
    `# ${data?.model?.name ?? 'Civitai model'}${data?.name ? ` — ${data.name}` : ''}`,
    `- 页面: https://civitai.com/models/${data?.modelId ?? '?'}${data?.id ? `?modelVersionId=${data.id}` : ''}`,
    `- 基模: ${data?.baseModel ?? '?'}`,
    trained.length > 0 ? `- 触发词: ${trained.join(', ')}` : null,
    modelDescription !== '' ? `\n## 模型说明\n\n${modelDescription}` : null,
    versionDescription !== '' ? `\n## 版本说明\n\n${versionDescription}` : null,
  ].filter(Boolean)
  return {
    title: data?.model?.name ?? `Civitai ${versionId}`,
    text: blocks.join('\n'),
    sources: [`https://${host.replace(/^https?:\/\//, '')}/api/v1/model-versions/${versionId}`],
    meta: { modelId: data?.modelId ?? null, versionId: data?.id ?? versionId, baseModel: data?.baseModel ?? null, trainedWords: trained },
  }
}

/** 模型文件旁边自带的说明（同名 .md、README.md、docs/*.md），用于手动放进来的模型。 */
export async function findLocalDocs(modelFilePath, { maxFiles = 3 } = {}) {
  if (typeof modelFilePath !== 'string' || modelFilePath === '') return null
  const dir = path.dirname(modelFilePath)
  const stem = path.basename(modelFilePath, path.extname(modelFilePath))
  // 只认与模型直接相关的说明：<stem>.md 一定相关；同目录 README.md 必须提到模型名，
  // 否则会把整个目录的通用 README 误当成这个模型的文档。
  const candidates = [path.join(dir, `${stem}.md`)]
  try {
    const readme = path.join(dir, 'README.md')
    const text = await fs.readFile(readme, 'utf8')
    if (text.toLowerCase().includes(stem.toLowerCase())) candidates.push(readme)
  } catch {
    // 没有 README
  }
  try {
    const entries = await fs.readdir(path.join(dir, 'docs'), { withFileTypes: true })
    for (const entry of entries.slice(0, maxFiles)) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) candidates.push(path.join(dir, 'docs', entry.name))
    }
  } catch {
    // 没有 docs 目录
  }
  const found = []
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8')
      if (text.trim() !== '') found.push({ path: file, text })
    } catch {
      // 跳过不存在
    }
  }
  if (found.length === 0) return null
  return {
    title: stem,
    text: found.map((file) => `# ${path.basename(file.path)}\n\n${file.text.trim()}`).join('\n\n---\n\n'),
    sources: found.map((file) => file.path),
    meta: { local: true },
  }
}
