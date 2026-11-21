// Installing a model file: one place for target folders, file-name rules,
// collision handling, verification and a provenance sidecar.
import fs from 'node:fs/promises'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 模型类别 → ComfyUI 的目录名。类别名对调用方稳定，目录名按 ComfyUI 的约定。 */
export const FOLDER_FOR_KIND = {
  lora: 'loras',
  checkpoint: 'checkpoints',
  diffusion_model: 'diffusion_models',
  vae: 'vae',
  text_encoder: 'text_encoders',
  controlnet: 'controlnet',
  embedding: 'embeddings',
  upscale_model: 'upscale_models',
  clip_vision: 'clip_vision',
}

export const KINDS = Object.keys(FOLDER_FOR_KIND)

const ALLOWED_EXT = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.sft', '.onnx'])
const DEFAULT_EXT = { lora: '.safetensors', checkpoint: '.safetensors', diffusion_model: '.safetensors', vae: '.safetensors', text_encoder: '.safetensors', controlnet: '.safetensors', embedding: '.pt', upscale_model: '.pth', clip_vision: '.safetensors' }

/**
 * 规范化文件名：只留 basename、去控制字符、折叠空白、统一分隔符、补默认扩展名。
 * 不改变可读的名字（中文/空格/点号保留），也不改变大小写。
 */
export function sanitizeFileName(rawName, kind) {
  const kindFolder = KINDS.includes(kind) ? kind : 'lora'
  let name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : ''
  name = name.split(/[\\/]/).pop() ?? ''
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  name = name.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '')
  if (name === '') name = `model${DEFAULT_EXT[kindFolder]}`
  const ext = path.extname(name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) name = `${name}${DEFAULT_EXT[kindFolder]}`
  // 只允许 ASCII 与常见 Unicode；极端长度截断，避免 Windows 路径超限。
  const stem = path.basename(name, path.extname(name))
  const keptExt = path.extname(name)
  return `${stem.slice(0, 120)}${keptExt}`
}

/** 目标目录：ComfyUI 自报的目录优先，其次 modelsRoot/子目录；都不知道就报错。 */
export function installDir(kind, layout) {
  const folder = FOLDER_FOR_KIND[KINDS.includes(kind) ? kind : 'lora']
  const discovered = layout?.discovered?.suggestedDir?.(folder)
  if (typeof discovered === 'string' && discovered !== '') return discovered
  if (typeof layout?.modelsRoot === 'string' && layout.modelsRoot !== '') return path.join(layout.modelsRoot, folder)
  return null
}

/** 同目录下挑一个不冲突的名字：name、name-2、name-3… */
export function freePath(directory, fileName) {
  const ext = path.extname(fileName)
  const stem = path.basename(fileName, ext)
  for (let index = 1; index < 100; index += 1) {
    const candidate = path.join(directory, index === 1 ? fileName : `${stem}-${index}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`目标目录里同名文件过多：${directory}`)
}

/** 源信息写进 models 根下的 .dsh-install 侧车文件，便于回溯与卸载。 */
export async function writeProvenance(directory, fileName, record) {
  try {
    const root = path.resolve(directory, '..', '..', '.dsh-install')
    const target = path.join(root, path.basename(directory), `${fileName}.json`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return target
  } catch {
    return null
  }
}

/** 读回某个模型目录里的安装记录：文件名 → 记录（含元数据）。 */
export async function readProvenance(directory) {
  const root = path.resolve(directory, '..', '..', '.dsh-install', path.basename(directory))
  const out = new Map()
  let names = []
  try {
    names = await fs.readdir(root)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.set(name.slice(0, -'.json'.length), JSON.parse(await fs.readFile(path.join(root, name), 'utf8')))
    } catch {
      // 坏记录不影响列表
    }
  }
  return out
}

/** 已存在且非空 → 视为已安装，不覆盖。 */
export function alreadyInstalled(directory, fileName) {
  const target = path.join(directory, fileName)
  if (!existsSync(target)) return null
  const info = statSync(target)
  return info.isFile() && info.size > 0 ? { path: target, bytes: info.size } : null
}

/**
 * 落盘：先写 .part，成功后校验并改名；失败/取消删掉半截文件。
 * @returns {Promise<{path:string, bytes:number, sha256:string}>}
 */
export async function installResponse(response, { directory, fileName, expectedSha256 = null, signal } = {}) {
  await fs.mkdir(directory, { recursive: true })
  const destination = freePath(directory, fileName)
  const partial = `${destination}.part`
  const hash = crypto.createHash('sha256')
  let bytes = 0
  const stream = createWriteStream(partial)
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('下载已取消')
      bytes += chunk.length
      hash.update(chunk)
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve))
    }
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())))
    const sha256 = hash.digest('hex')
    if (typeof expectedSha256 === 'string' && expectedSha256 !== '' && sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      await fs.rm(partial, { force: true }).catch(() => {})
      throw new Error(`SHA256 校验失败：期望 ${expectedSha256}，实际 ${sha256}。文件已删除，未安装。`)
    }
    await fs.rename(partial, destination)
    return { path: destination, bytes, sha256 }
  } catch (error) {
    await new Promise((resolve) => stream.end(() => resolve()))
    await fs.rm(partial, { force: true }).catch(() => {})
    throw error
  }
}
