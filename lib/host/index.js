/**
 * AI 绘画 bundle 的 Host 半。
 *
 * 做两件事：
 * 1. 侧边栏入口的 ComfyUI 路由（供 `lib/client.js` 使用）：
 *   GET  /plugins/dsh-drawing-agent/config  → { origin }
 *   GET  /plugins/dsh-drawing-agent/status  → { online, origin, checkedAt, version?, device?, error? }
 *   POST /plugins/dsh-drawing-agent/start   → { started, already, online, pid?, logPath?, error? }
 *   POST /plugins/dsh-drawing-agent/stop    → { stopped, already, online, pid?, error? }
 *   GET  /plugins/dsh-drawing-agent/log     → 最近一次启动日志的末尾几行（排查用）
 *   GET  /plugins/dsh-drawing-agent/pnginfo → 附件工作流捕获钩子的状态
 * 2. 附件工作流捕获：上传路由会把**原始 PNG 字节**交给 attachments 服务，随后
 *    归一化把它们变成无元数据的 JPEG。这里在归一化前把 `prompt` / `workflow`
 *    文本块截下来，按归一化后的 `sha256:<id>` 存进 `<DSH_HOME>/drawing-pnginfo/`。
 *    聊天消息里本来就带着这个 id，所以 `drawing_pnginfo` 不需要原图路径。
 *
 * 启动 ComfyUI **不经过绘世启动器**：直接用 ComfyUI 安装目录（`COMFYUI_HOME`，默认
 * 留空由配置提供）下的 `.ext\python.exe` 跑 main.py，输出重定向到 `launch.logDir`
 * （`COMFYUI_LOG_DIR`）下的 `comfyui-<时间戳>.log`。
 *
 * 注意不要照抄绘世命令行里的 `--cpu`：在 ComfyUI 0.44 里它的含义是「全部用 CPU（很慢）」，
 * 绘世只是拿它当绕过 A 卡 DirectML 检测的标签。我们不走绘世，直接用 ROCm 的 GPU。
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { closeSync, existsSync, openSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { captureImageBytes, captureStoreStatus } from '../pnginfo.js'

const execFileAsync = promisify(execFile)

export const name = 'dsh-drawing-tools'
export const inject = ['webServer']

// 路由前缀沿用历史名 `dsh-drawing-agent`，与包名 `dsh-drawing-tools` 解耦：
// lib/client.js 的 API_PREFIX 也用它，改名会让前端路由失效。
import * as civitai from '../civitai.js'
import { detectLaunch } from '../launch.js'

const BASE = '/plugins/dsh-drawing-agent'
const DEFAULT_ORIGIN = 'http://127.0.0.1:8188'
/** 启动命令因机器而异：默认留空，由 row config 或环境变量提供。 */
const ENV = process.env
const DEFAULT_LOG_DIR = ENV.COMFYUI_LOG_DIR || path.join(os.tmpdir(), 'dsh-drawing-logs')
const DEFAULT_LAUNCH = {
  command: ENV.COMFYUI_PYTHON || '',
  args: ENV.COMFYUI_MAIN
    ? [ENV.COMFYUI_MAIN, '--preview-method', 'auto']
    : [],
  cwd: ENV.COMFYUI_HOME || '',
}
/** 探测 ComfyUI 的单次超时：只用来判断"活着没"，不要拖住页面。 */
const PROBE_TIMEOUT_MS = 2000
/** 冷启动（ROCm 初始化 + 自定义节点）实测 10–30 秒，给足 90 秒。 */
const DEFAULT_START_TIMEOUT_MS = 90_000
const START_POLL_MS = 1000
const LOG_TAIL_LINES = 12

/** 同一个进程里只允许一次启动尝试，避免连点按钮拉起多个 ComfyUI。 */
let pendingStart = null
/** 最近一次启动尝试的状态，供 /log 与失败信息使用。 */
let lastStart = null
/** 客户端上报的最近一次错误（排查右栏打不开画布用）。 */
let lastReport = null

function originOf(config) {
  const configured = typeof config?.origin === 'string' ? config.origin.trim() : ''
  return (configured || DEFAULT_ORIGIN).replace(/\/+$/, '')
}

function launchOf(config) {
  const configured = config?.launch ?? {}
  const explicitCommand = typeof configured.command === 'string' && configured.command.trim() ? configured.command.trim() : ''
  const explicitCwd = typeof configured.cwd === 'string' && configured.cwd.trim() ? configured.cwd.trim() : ''
  const args = Array.isArray(configured.args) ? configured.args.filter((arg) => typeof arg === 'string') : []
  if (configured.enabled !== false && (explicitCommand !== '' || explicitCwd !== '')) {
    return {
      enabled: true,
      mode: 'config',
      command: explicitCommand || DEFAULT_LAUNCH.command,
      args: args.length > 0 ? args : DEFAULT_LAUNCH.args,
      cwd: explicitCwd || DEFAULT_LAUNCH.cwd,
      logDir: typeof configured.logDir === 'string' && configured.logDir.trim() ? configured.logDir.trim() : DEFAULT_LOG_DIR,
      timeoutMs: Number(configured.timeoutMs) > 0 ? Number(configured.timeoutMs) : DEFAULT_START_TIMEOUT_MS,
    }
  }
  // 没配置就自动找：已知 models 根/常见位置 → main.py + python。
  const detected = detectLaunch({ comfyRoot: config?.comfyRoot ?? null, modelsRoot: config?.modelsRoot ?? null })
  if (configured.enabled !== false && detected.ok) {
    return {
      enabled: true,
      mode: 'auto',
      detected,
      command: detected.command,
      args: args.length > 0 ? args : detected.args,
      cwd: detected.cwd,
      logDir: typeof configured.logDir === 'string' && configured.logDir.trim() ? configured.logDir.trim() : DEFAULT_LOG_DIR,
      timeoutMs: Number(configured.timeoutMs) > 0 ? Number(configured.timeoutMs) : DEFAULT_START_TIMEOUT_MS,
    }
  }
  return {
    enabled: false,
    mode: 'none',
    detected,
    reason: detected.reason,
    command: DEFAULT_LAUNCH.command,
    args: DEFAULT_LAUNCH.args,
    cwd: DEFAULT_LAUNCH.cwd,
    logDir: DEFAULT_LOG_DIR,
    timeoutMs: DEFAULT_START_TIMEOUT_MS,
  }
}

async function readBody(req, limit = 64 * 1024) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) break
  }
  return body
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}

function gigabytes(bytes) {
  const value = Number(bytes)
  return Number.isFinite(value) && value > 0 ? Math.round((value / 1024 ** 3) * 10) / 10 : undefined
}

function readableError(error) {
  const code = error?.cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return '连接被拒绝：ComfyUI 没有在监听'
  if (code === 'ENOTFOUND') return '地址解析失败'
  if (code === 'EACCES') return '没有权限执行启动命令'
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '连接超时'
  return String(error?.cause?.message ?? error?.message ?? error)
}

/** 只要 /system_stats 能回 JSON 就算在线；错误只取一段可读摘要。 */
async function probe(origin) {
  try {
    const response = await fetch(`${origin}/system_stats`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return { online: false, error: `ComfyUI 返回 HTTP ${response.status}` }
    const stats = await response.json()
    return {
      online: true,
      version: stats?.system?.comfyui_version,
      device: stats?.devices?.[0]?.name,
      vramFreeGB: gigabytes(stats?.devices?.[0]?.vram_free),
      vramTotalGB: gigabytes(stats?.devices?.[0]?.vram_total),
    }
  } catch (error) {
    return { online: false, error: readableError(error) }
  }
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 读日志末尾若干行；读不到就返回空数组（绝不能因此让接口失败）。 */
function tailLog(logPath, lines = LOG_TAIL_LINES) {
  try {
    if (!logPath || !existsSync(logPath)) return []
    const text = readFileSync(logPath, 'utf8')
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines)
  } catch {
    return []
  }
}

/** 找日志目录里最新的一个 comfyui-*.log（用户手动跑脚本时也能读到）。 */
function newestLog(logDir) {
  try {
    if (!existsSync(logDir)) return undefined
    const files = readdirSync(logDir)
      .filter((file) => /^comfyui-.*\.log$/.test(file))
      .map((file) => path.join(logDir, file))
      .map((file) => ({ file, at: statSync(file).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    return files[0]?.file
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForOnline(origin, timeoutMs, launchInfo) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (launchInfo.exited !== undefined) return { online: false, exited: launchInfo.exited }
    const result = await probe(origin)
    if (result.online) return { online: true, device: result.device, version: result.version }
    await sleep(START_POLL_MS)
  }
  return { online: false, timedOut: true }
}

async function startComfyUI(origin, launch) {
  if (!launch.enabled) {
    return {
      started: false,
      already: false,
      online: false,
      error: launch.mode === 'none'
        ? `自动启动未就绪：${launch.reason ?? '没有找到 ComfyUI'}。用 drawing_setup 检测并写配置，或在插件行 config.launch 指定 command/cwd。`
        : '本插件的自动启动已被配置关闭（launch.enabled: false）',
    }
  }
  if (!existsSync(launch.command)) {
    return { started: false, already: false, online: false, error: `找不到 Python：${launch.command}` }
  }
  if (!existsSync(launch.cwd)) {
    return { started: false, already: false, online: false, error: `找不到 ComfyUI 目录：${launch.cwd}` }
  }
  if (pendingStart) return pendingStart

  pendingStart = (async () => {
    let logPath
    let fd
    try {
      mkdirSync(launch.logDir, { recursive: true })
      logPath = path.join(launch.logDir, `comfyui-${stamp()}.log`)
      fd = openSync(logPath, 'a')
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        detached: true,
        windowsHide: true,
        // stdout 与 stderr 写同一个文件：ComfyUI 把 INFO 日志写 stderr，分开会很难看。
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
      const launchInfo = {}
      child.on('error', (error) => {
        launchInfo.exited = `spawn 失败：${readableError(error)}`
      })
      child.on('exit', (code, signal) => {
        launchInfo.exited = `python 提前退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`
      })
      child.unref()
      /* 记下 pid：这样 scripts/start-comfyui.ps1 -Stop（或「停止ComfyUI.cmd」）
         也能停掉由面板拉起的实例，不只是脚本自己起的。 */
      try {
        writeFileSync(path.join(launch.logDir, 'comfyui.pid'), String(child.pid), 'ascii')
      } catch {
        /* 写不进 pid 文件不影响启动本身 */
      }
      const outcome = await waitForOnline(origin, launch.timeoutMs, launchInfo)
      const base = { pid: child.pid, logPath, logTail: tailLog(logPath) }
      lastStart = { at: new Date().toISOString(), ...base, online: outcome.online }
      if (outcome.online) return { started: true, already: false, online: true, ...base }
      const reason = outcome.exited
        ? outcome.exited
        : `等待 ${Math.round(launch.timeoutMs / 1000)} 秒仍未就绪（进程可能还在初始化）`
      return { started: true, already: false, online: false, error: reason, ...base }
    } catch (error) {
      return { started: false, already: false, online: false, error: readableError(error), logPath, logTail: tailLog(logPath) }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* 父进程关掉副本即可，子进程仍持有自己的句柄 */
        }
      }
      pendingStart = null
    }
  })()
  return pendingStart
}

function readPidFile(logDir) {
  try {
    const file = path.join(logDir, 'comfyui.pid')
    if (!existsSync(file)) return undefined
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function portOf(origin) {
  try {
    const url = new URL(origin)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return 8188
  }
}

/** 拿到进程的 image 名（python.exe），用来确认要杀的确实是 ComfyUI。 */
async function imageNameOf(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
    })
    const line = String(stdout).trim()
    if (line === '' || line.startsWith('INFO')) return undefined
    const match = /^"([^"]+)"/.exec(line)
    return match === null ? undefined : match[1].toLowerCase()
  } catch {
    return undefined
  }
}

/** 找监听该端口的进程（pid 文件丢了/被别的方式启动时兜底）。 */
async function findListenerPid(port) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.includes(`:${port} `)) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      if (!/listening/i.test(parts[3])) continue
      const pid = Number(parts[4])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    /* netstat 不可用就算了 */
  }
  return undefined
}

async function killPid(pid) {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

/**
 * 停止 ComfyUI：先认 pid 文件（我们自己起的，可信），再认监听端口的进程
 * （必须是 python.exe 才动手，避免误杀别的服务）。
 */
async function stopComfyUI(origin, launch) {
  const before = await probe(origin)
  if (!before.online) return { stopped: false, already: true, online: false }

  const candidates = []
  const filePid = readPidFile(launch.logDir)
  if (filePid !== undefined) candidates.push({ pid: filePid, trusted: true })
  const listenerPid = await findListenerPid(portOf(origin))
  if (listenerPid !== undefined && !candidates.some((item) => item.pid === listenerPid)) {
    candidates.push({ pid: listenerPid, trusted: false })
  }

  const killed = []
  for (const candidate of candidates) {
    if (!candidate.trusted) {
      const image = await imageNameOf(candidate.pid)
      if (image !== undefined && image !== 'python.exe') continue
    }
    if (await killPid(candidate.pid)) killed.push(candidate.pid)
  }

  try {
    const pidFile = path.join(launch.logDir, 'comfyui.pid')
    if (existsSync(pidFile)) rmSync(pidFile)
  } catch {
    /* pid 文件删不掉不影响停止 */
  }

  if (killed.length === 0) {
    return {
      stopped: false,
      already: false,
      online: before.online,
      error: `端口 ${portOf(origin)} 在监听，但没找到可停止的 python 进程（可能不是本插件或脚本启动的）`,
    }
  }

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await probe(origin)
    if (!state.online) return { stopped: true, already: false, online: false, pid: killed[0], pids: killed }
    await sleep(300)
  }
  return {
    stopped: true,
    already: false,
    online: true,
    pid: killed[0],
    pids: killed,
    error: '进程已结束但端口仍有响应，稍后再刷新看看',
  }
}

// ---------------------------------------------------------------------------
// Attachment capture: keep ComfyUI chunks across normalization
// ---------------------------------------------------------------------------

/** Diagnostic state surfaced by GET /plugins/dsh-drawing-agent/pnginfo. */
export const pnginfoCaptureState = {
  installed: false,
  patchedAt: null,
  captured: 0,
  lastCaptureAt: null,
  lastName: null,
  lastError: null,
  storeDir: null,
}

function captureMany(inputs, refs) {
  if (!Array.isArray(inputs) || !Array.isArray(refs)) return
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]
    const ref = refs[index]
    if (!input || !ref) continue
    try {
      const sidecar = captureImageBytes(input.data ?? input.bytes, ref)
      if (!sidecar) continue
      pnginfoCaptureState.captured += 1
      pnginfoCaptureState.lastCaptureAt = sidecar.capturedAt
      pnginfoCaptureState.lastName = sidecar.name
    } catch (error) {
      pnginfoCaptureState.lastError = error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Wrap the attachment service's image-save methods so original PNG chunks are
 * captured before normalization throws them away. Cordis exposes services
 * through a tracing proxy, so patch the class prototype (the proxy forwards
 * property reads to the instance and its prototype) and restore it on teardown.
 * @param ctx - a context whose `attachments` service is available.
 * @returns the shared capture state.
 */
export function installPnginfoCapture(ctx) {
  const service = ctx.attachments
  if (!service) return pnginfoCaptureState
  const proto = Object.getPrototypeOf(service)
  if (!proto || typeof proto.saveImages !== 'function') return pnginfoCaptureState
  pnginfoCaptureState.storeDir = captureStoreStatus().dir
  if (proto.__drawingPnginfoPatched) {
    pnginfoCaptureState.installed = true
    return pnginfoCaptureState
  }
  const originalSaveImages = proto.saveImages
  const originalSaveImage = proto.saveImage
  proto.saveImages = async function (inputs) {
    const refs = await originalSaveImages.call(this, inputs)
    captureMany(inputs, refs)
    return refs
  }
  if (typeof originalSaveImage === 'function') {
    proto.saveImage = async function (input) {
      const ref = await originalSaveImage.call(this, input)
      captureMany([input], [ref])
      return ref
    }
  }
  Object.defineProperty(proto, '__drawingPnginfoPatched', { value: true, configurable: true })
  pnginfoCaptureState.installed = true
  pnginfoCaptureState.patchedAt = new Date().toISOString()
  ctx.effect(() => () => {
    proto.saveImages = originalSaveImages
    if (typeof originalSaveImage === 'function') proto.saveImage = originalSaveImage
    delete proto.__drawingPnginfoPatched
    pnginfoCaptureState.installed = false
  })
  return pnginfoCaptureState
}

export function apply(ctx, config = {}) {
  const origin = originOf(config)
  const launch = launchOf(config)

  // Civitai 凭据：token 只存在 DSH 的凭据库里（或环境变量），不写配置、不回显。
  const credentials = () => ctx.get?.('credentials') ?? null
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/cred`,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, await civitai.describeToken(credentials()))
            if (req.method === 'DELETE') { await civitai.clearToken(credentials()); return sendJson(res, 200, await civitai.describeToken(credentials())) }
            if (req.method === 'POST') {
              const body = await readBody(req, 8 * 1024)
              let token = ''
              try { token = String(JSON.parse(body)?.token ?? '') } catch { token = '' }
              await civitai.setToken(credentials(), token)
              return sendJson(res, 200, await civitai.describeToken(credentials()))
            }
            return sendJson(res, 405, { error: 'method not allowed' })
          } catch (error) {
            return sendJson(res, 400, { error: civitai.redact(String(error?.message ?? error)) })
          }
        },
      }),
    'dsh-drawing-agent: civitai credentials route',
  )
  // 一次性导入旧版明文文件（~/.dsh/civitai_token），导入后不删除原文件，由用户决定。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/cred/import`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          try {
            const legacy = await civitai.readLegacyToken()
            if (legacy === null) return sendJson(res, 404, { error: '没有找到旧版 token 文件。' })
            await civitai.setToken(credentials(), legacy.value)
            return sendJson(res, 200, { imported: true, file: legacy.file, status: await civitai.describeToken(credentials()) })
          } catch (error) {
            return sendJson(res, 400, { error: civitai.redact(String(error?.message ?? error)) })
          }
        },
      }),
    'dsh-drawing-agent: civitai import route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/config`,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          sendJson(res, 200, { origin })
        },
      }),
    'dsh-drawing-agent: config route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/status`,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          const result = await probe(origin)
          sendJson(res, 200, {
            origin,
            checkedAt: new Date().toISOString(),
            launching: pendingStart !== null,
            launch: {
              mode: launch.mode,
              command: launch.command,
              cwd: launch.cwd,
              source: launch.detected?.source ?? null,
              reason: launch.reason ?? null,
            },
            logPath: lastStart?.logPath ?? newestLog(launch.logDir),
            ...result,
          })
        },
      }),
    'dsh-drawing-agent: status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/start`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          const current = await probe(origin)
          if (current.online) return sendJson(res, 200, { started: false, already: true, online: true })
          const result = await startComfyUI(origin, launch)
          sendJson(res, result.online ? 200 : 502, result)
        },
      }),
    'dsh-drawing-agent: start route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/stop`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          const result = await stopComfyUI(origin, launch)
          sendJson(res, result.stopped ? 200 : result.already ? 200 : 502, result)
        },
      }),
    'dsh-drawing-agent: stop route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/log`,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          const url = new URL(req.url ?? `${BASE}/log`, 'http://127.0.0.1')
          const wanted = Number(url.searchParams.get('lines'))
          const lines = Number.isFinite(wanted) && wanted > 0 ? Math.min(200, Math.trunc(wanted)) : LOG_TAIL_LINES
          const logPath = lastStart?.logPath ?? newestLog(launch.logDir)
          sendJson(res, 200, { logPath: logPath ?? null, lines: tailLog(logPath, lines) })
        },
      }),
    'dsh-drawing-agent: log route',
  )

  /* 客户端错误上报：右栏无法打开画布时把真实异常带回来，便于定位。 */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/report`,
        handler: (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 200, lastReport ?? { report: null })
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > 32_768) req.destroy()
          })
          req.on('end', () => {
            try {
              lastReport = { at: new Date().toISOString(), report: JSON.parse(body || '{}') }
            } catch {
              lastReport = { at: new Date().toISOString(), report: { raw: body.slice(0, 2_000) } }
            }
            sendJson(res, 204, {})
          })
        },
      }),
    'dsh-drawing-agent: client report route',
  )

  /* 附件工作流捕获：attachments 服务由 dsh-base 提供，这里只挂监听，不影响本插件路由。 */
  ctx.inject(['attachments'], (inner) => {
    try {
      installPnginfoCapture(inner)
    } catch (error) {
      pnginfoCaptureState.lastError = error instanceof Error ? error.message : String(error)
    }
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/pnginfo`,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
          sendJson(res, 200, { ...pnginfoCaptureState, store: captureStoreStatus() })
        },
      }),
    'dsh-drawing-agent: pnginfo capture route',
  )
}
