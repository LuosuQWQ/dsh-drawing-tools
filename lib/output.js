// Canonical output layout: one root, predictable names, a single index.
//
// 规范化要点：
// - 根目录做归一化（展开 ~、相对路径按工作目录解析、去尾分隔符），不合法直接拒绝。
// - 文件名固定为 <HHMMSS>_<family>_<模型slug>_s<seed>_<序号>.png，可读、可排序、不重复覆盖。
// - 每张图旁边一份同名 .json（配方），根目录再追加一行 index.jsonl（总索引）。
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pad2 = (value) => String(value).padStart(2, '0')

/** 展开 ~、按 cwd 解析相对路径、去掉尾部分隔符；空值返回 null。 */
export function normalizeOutputRoot(raw, { cwd = process.cwd() } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let value = raw.trim()
  if (value === '~') value = os.homedir()
  else if (value === '~/' || value === '~\\') value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2))
  const resolved = path.resolve(cwd, value)
  const trimmed = resolved.replace(/[\\/]+$/, '')
  return trimmed === '' ? path.parse(resolved).root : trimmed
}

/** 模型名 → 文件名片段：保留中日韩与字母数字，其余折叠成 -，最长 40。 */
export function sanitizeSlug(text, { max = 40 } = {}) {
  const base = path.basename(String(text ?? ''), path.extname(String(text ?? '')))
  const slug = base
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug === '' ? 'model' : slug
}

/** <root>/<YYYY>/<MM>/<DD> */
export function datePath(at = new Date()) {
  return `${at.getFullYear()}/${pad2(at.getMonth() + 1)}/${pad2(at.getDate())}`
}

/** <HHMMSS> */
export function timePart(at = new Date()) {
  return `${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
}

/**
 * 规范化的图片路径；同秒同参重复时自动加 -2、-3，绝不覆盖已有文件。
 * @returns {{ directory: string, file: string, path: string }}
 */
export function imagePathFor({ root, at = new Date(), family = 'classic', model = '', seed = 0, index = 1 }) {
  if (typeof root !== 'string' || root === '') throw new Error('输出根目录未知；请先配置 outputDir 或使用默认目录。')
  const directory = path.join(root, datePath(at))
  const stem = `${timePart(at)}_${field(family)}_${sanitizeSlug(model)}_s${Number.isFinite(Number(seed)) ? Number(seed) : 0}_${pad2(index)}`
  for (let attempt = 1; attempt < 200; attempt += 1) {
    const candidate = path.join(directory, attempt === 1 ? `${stem}.png` : `${stem}-${attempt}.png`)
    if (!existsSync(candidate) && !existsSync(`${candidate}.json`)) return { directory, file: path.basename(candidate), path: candidate }
  }
  throw new Error(`同一个文件名已经存在太多次：${stem}`)
}

/** family 只保留安全字符。 */
function field(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '') || 'unknown'
}

/** 确保输出根存在。 */
export async function ensureRoot(root) {
  await fs.mkdir(root, { recursive: true })
  return root
}

/**
 * 往根目录的 index.jsonl 追加一条记录；失败不影响出图。
 * @returns {Promise<string|null>} index 路径（失败时 null）
 */
export async function appendIndex(root, record) {
  try {
    await fs.mkdir(root, { recursive: true })
    const file = path.join(root, 'index.jsonl')
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
    return file
  } catch {
    return null
  }
}
