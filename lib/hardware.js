// GPU detection and ComfyUI flavour advice.
//
// 目标：用户不懂 CUDA / ROCm / DirectML 的区别时，插件先替他判断，给出
// 「你的卡该用哪种 ComfyUI + 哪些启动参数」，而不是让他自己猜。
import { execFile } from 'node:child_process'
import path from 'node:path'

let cache = null
const CACHE_MS = 5 * 60 * 1000

const run = (file, args, timeout = 12_000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout ?? ''))
    })
  })

/** 从显卡名字判断厂商。 */
export function classifyVendor(name) {
  const value = String(name ?? '').toLowerCase()
  if (/nvidia|geforce|quadro|tesla|rtx\s?\d|gtx/.test(value)) return 'nvidia'
  if (/amd|radeon|firepro|instinct/.test(value)) return 'amd'
  if (/intel|arc\s?a\d|iris|uhd graphics/.test(value)) return 'intel'
  if (/apple|m[1-9] (max|pro|ultra)?/.test(value)) return 'apple'
  if (/microsoft basic|remote display|virtual/.test(value)) return 'none'
  return 'unknown'
}

/** 解析 nvidia-smi 的 CSV：name, memory.total, driver_version */
function parseNvidiaSmi(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, memory, driver] = line.split(',').map((part) => part.trim())
      const mib = Number((memory ?? '').replace(/[^\d.]/g, ''))
      return { vendor: 'nvidia', name: name ?? 'NVIDIA GPU', vramGB: Number.isFinite(mib) ? Math.round((mib / 1024) * 10) / 10 : null, driver: driver ?? null }
    })
    .filter((gpu) => gpu.name)
}

/**
 * Windows：CIM 查显卡名/驱动；显存用注册表 HardwareInformation.qwMemorySize
 * （64 位）。Win32_VideoController.AdapterRAM 是 32 位，>4GB 会溢出，不能用。
 */
async function detectWindows() {
  const script = [
    "$ram = 0",
    "Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $v = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'",
    "  if ($v -and $v -gt $ram) { $ram = $v }",
    "}",
    "'VRAM=' + $ram",
    "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion }",
  ].join('; ')
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (out === null) return null
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const vramLine = lines.find((line) => line.startsWith('VRAM='))
  const bytes = Number(vramLine?.slice(5) ?? 0)
  const totalGB = Number.isFinite(bytes) && bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null
  const gpus = lines
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [name, driver] = line.split('|')
      return { vendor: classifyVendor(name), name: name.trim(), driver: driver?.trim() || null, vramGB: null }
    })
    .filter((gpu) => gpu.vendor !== 'none')
  // 注册表只有全机最大值：给"独显"那一条（名字像 RX/RTX/GTX/Arc/Instinct/Tesla）。
  const discrete = gpus.find((gpu) => /rx\s?\d|rtx|gtx|quadro|tesla|arc\s?a\d|instinct/i.test(gpu.name)) ?? gpus.find((gpu) => gpu.vendor === 'nvidia' || gpu.vendor === 'amd')
  if (discrete !== undefined && totalGB !== null) discrete.vramGB = totalGB
  return gpus
}

/** Linux：nvidia-smi 优先，其次 DRM vendor id。 */
async function detectLinux() {
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
  if (smi !== null && smi.trim() !== '') return parseNvidiaSmi(smi)
  const lspci = await run('lspci', [])
  if (lspci === null) return null
  return lspci
    .split(/\r?\n/)
    .filter((line) => /vga|3d|display/i.test(line))
    .map((line) => {
      const name = line.replace(/^[^\s]+\s+[^:]+:\s*/, '').trim()
      return { vendor: classifyVendor(name), name, driver: null, vramGB: null }
    })
}

/** macOS：system_profiler 的芯片名。 */
async function detectMac() {
  const out = await run('system_profiler', ['SPDisplaysDataType'])
  if (out === null) return null
  const names = [...out.matchAll(/Chipset Model:\s*(.+)/g)].map((match) => match[1].trim())
  return names.map((name) => ({ vendor: classifyVendor(name) || 'apple', name, driver: null, vramGB: null }))
}

/**
 * 检测本机显卡（带 5 分钟缓存）。
 * @returns {Promise<{platform:string, gpus:Array<{vendor:string,name:string,vramGB:number|null,driver:string|null}>, primary:object|null, error:string|null}>}
 */
export async function detectHardware({ fresh = false } = {}) {
  if (!fresh && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.value
  const platform = process.platform
  let gpus = null
  let error = null
  try {
    if (platform === 'win32') gpus = await detectWindows()
    else if (platform === 'darwin') gpus = await detectMac()
    else gpus = await detectLinux()
  } catch (cause) {
    error = String(cause?.message ?? cause)
  }
  if (gpus === null) {
    gpus = []
    error = error ?? '没能读取显卡信息'
  }
  // 多卡时优先独显：AMD/NVIDIA 优先于 Intel 核显。
  const score = (gpu) => {
    let value = 0
    if (/rx\s?\d|rtx|gtx|quadro|tesla|arc\s?a\d|instinct/i.test(gpu.name)) value += 100
    if (gpu.vendor === 'nvidia' || gpu.vendor === 'amd') value += 20
    if (Number.isFinite(gpu.vramGB)) value += Math.min(40, gpu.vramGB)
    return value
  }
  const primary = [...gpus].sort((left, right) => score(right) - score(left))[0] ?? null
  const value = { platform, gpus, primary, error }
  cache = { at: Date.now(), value }
  return value
}

/**
 * 按显卡与显存给出 ComfyUI 的构建建议与启动参数。
 * 这只是"建议"：实际能不能用还取决于装的是 CUDA / ROCm / DirectML / CPU 构建。
 */
export function recommendFor({ vendor, vramGB, platform = process.platform } = {}) {
  const args = ['--preview-method', 'auto']
  const notes = []
  let flavor = 'unknown'
  if (vendor === 'nvidia') {
    flavor = 'cuda'
    args.push('--use-pytorch-cross-attention')
    notes.push('装 CUDA 版（NVIDIA 官方驱动的 CUDA 运行时），ComfyUI 官方便携包默认就是 CUDA。')
  } else if (vendor === 'amd') {
    flavor = platform === 'win32' ? 'rocm-or-directml' : 'rocm'
    args.push('--use-quad-cross-attention')
    if (platform === 'win32') {
      notes.push('A 卡不要用 CUDA 版。装 ROCm 版（推荐，较新）或 DirectML 版；两者启动参数不同：DirectML 版才加 --directml，ROCm 版不加。')
    } else {
      notes.push('Linux 上用 ROCm 版；确认驱动里有 amdgpu 且装了 ROCm 运行时。')
    }
  } else if (vendor === 'intel') {
    flavor = 'ipex'
    args.push('--use-ipex')
    notes.push('Intel 独显/核显走 IPEX 版（实验性），或退回 CPU。')
  } else if (vendor === 'apple') {
    flavor = 'mps'
    notes.push('Apple Silicon 用官方 macOS 包即可，自动走 MPS。')
  } else if (vendor === 'none') {
    flavor = 'cpu'
    args.push('--cpu')
    notes.push('没有检测到独显：只能 CPU 跑，会很慢（分钟级/张）。')
  } else {
    notes.push('没识别出显卡厂商：先跑 nvidia-smi 或看驱动，再决定用哪种构建。')
  }
  if (Number.isFinite(vramGB) && vramGB > 0) {
    if (vramGB < 2) args.push('--novram')
    else if (vramGB < 6) args.push('--lowvram')
    if (vramGB < 6) notes.push(`显存只有约 ${vramGB} GB：已建议降显存参数，出图尺寸别超过 768。`)
  }
  return { flavor, args, notes }
}
