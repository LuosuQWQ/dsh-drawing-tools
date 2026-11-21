// Launch detection: find a ComfyUI install and the interpreter that runs it.
//
// 目标：新机上用户不用手写 launch 命令。已知 models 根（或 comfyRoot）时，
// 它的上一级通常就是 ComfyUI 根；再按常见 python 布局找解释器。
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** ComfyUI 安装里可能的解释器位置（按优先级）。 */
const PYTHON_CANDIDATES = [
  ['.ext', 'python.exe'],
  ['.ext', 'bin', 'python'],
  ['python_embeded', 'python.exe'],
  ['python_embeded', 'bin', 'python'],
  ['venv', 'Scripts', 'python.exe'],
  ['venv', 'bin', 'python'],
  ['.venv', 'Scripts', 'python.exe'],
  ['.venv', 'bin', 'python'],
  ['python', 'python.exe'],
  ['python', 'bin', 'python'],
]

/** 常见的便携安装位置；只用于"找得到就用"，找不到不报错。 */
function commonRoots() {
  const home = os.homedir()
  return [
    path.join(home, 'ComfyUI'),
    path.join(home, 'Desktop', 'ComfyUI'),
    path.join(home, 'Documents', 'ComfyUI'),
    'D:/ComfyUI',
    'C:/ComfyUI',
    '/opt/ComfyUI',
    path.join(home, 'ComfyUI_windows_portable', 'ComfyUI'),
  ]
}

const existsFile = (file) => {
  try {
    return existsSync(file) && statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 找一套可启动的 ComfyUI。
 * @param {{ comfyRoot?: string|null, modelsRoot?: string|null, env?: Record<string,string|undefined> }} options
 * @returns {{ ok: boolean, source: string, comfyRoot: string|null, command: string|null, cwd: string|null, args: string[], main: string|null, reason?: string }}
 */
export function detectLaunch({ comfyRoot = null, modelsRoot = null, env = process.env, includeCommon = true } = {}) {
  const candidates = []
  const add = (value, source) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const root = path.resolve(value.trim())
    if (!candidates.some((entry) => entry.root.toLowerCase() === root.toLowerCase())) candidates.push({ root, source })
  }
  add(comfyRoot, '配置的 comfyRoot')
  add(env.COMFYUI_HOME, 'COMFYUI_HOME')
  add(env.COMFY_ROOT, 'COMFY_ROOT')
  add(env.COMFY_MODELS_ROOT ? path.dirname(path.resolve(env.COMFY_MODELS_ROOT)) : null, 'COMFY_MODELS_ROOT')
  add(modelsRoot ? path.dirname(path.resolve(modelsRoot)) : null, 'ComfyUI 自报的 models 根')
  // 便携包常见结构：<parent>/ComfyUI，modelsRoot 上一级再加一层。
  if (modelsRoot) add(path.dirname(path.dirname(path.resolve(modelsRoot))), 'models 根的上一级')
  if (includeCommon) for (const root of commonRoots()) add(root, '常见安装位置')

  let sawMain = null
  for (const candidate of candidates) {
    const main = path.join(candidate.root, 'main.py')
    if (!existsFile(main)) continue
    sawMain = candidate
    for (const parts of PYTHON_CANDIDATES) {
      const python = path.join(candidate.root, ...parts)
      if (!existsFile(python)) continue
      return {
        ok: true,
        source: candidate.source,
        comfyRoot: candidate.root,
        command: python,
        cwd: candidate.root,
        args: ['main.py', '--preview-method', 'auto'],
        main,
      }
    }
  }
  if (sawMain !== null) {
    return {
      ok: false,
      source: sawMain.source,
      comfyRoot: sawMain.root,
      command: null,
      cwd: sawMain.root,
      args: [],
      main: path.join(sawMain.root, 'main.py'),
      reason: '找到了 main.py，但没找到 Python 解释器（.ext/python.exe、python_embeded、venv 都没有）',
    }
  }
  return {
    ok: false,
    source: 'none',
    comfyRoot: null,
    command: null,
    cwd: null,
    args: [],
    main: null,
    reason: candidates.length > 0
      ? `没在这些目录里找到 main.py：${candidates.map((entry) => entry.root).join('、')}`
      : '不知道 ComfyUI 安装在哪里',
  }
}

/** 给状态输出用的一行描述。 */
export function describeLaunch(launch) {
  if (!launch) return '未知'
  if (launch.ok) return `${launch.source}：${launch.command}（cwd ${launch.cwd}）`
  return `未找到（${launch.reason}）`
}
