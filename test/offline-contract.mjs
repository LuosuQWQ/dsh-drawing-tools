// Offline contract checks for the drawing tools package: nothing here needs ComfyUI.
//
// The point is to catch the kind of drift that only shows up at runtime — a guide
// that is not reachable through drawing_guide, a tool that lost its description, a
// family missing from the enum, or a reference to a file that no longer exists.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))
const tools = read('lib/tools.js')
const comfy = read('lib/comfy-client.js')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- tools
const TOOL_NAMES = [
  'drawing_status', 'drawing_models', 'drawing_guide', 'drawing_generate',
  'drawing_queue', 'drawing_history', 'drawing_workflow', 'drawing_pnginfo', 'drawing_download', 'drawing_paths', 'drawing_modeldoc', 'drawing_setup',
]
for (const name of TOOL_NAMES) {
  check(`defines ${name}`, tools.includes(`name: '${name}'`))
}
const defined = [...tools.matchAll(/name: '(drawing_[a-z_]+)'/g)].map((m) => m[1])
check('no unexpected tool names', defined.every((name) => TOOL_NAMES.includes(name)), defined.join(', '))
for (const name of TOOL_NAMES) {
  const at = tools.indexOf(`name: '${name}'`)
  const window = tools.slice(at, at + 600)
  check(`${name} has a description`, /description:\s*\n?\s*'[^']{20,}/.test(window))
}

// ---------------------------------------------------------------- families
const FAMILY_IDS = (comfy.match(/export const FAMILIES = \{([\s\S]*?)\n\}/)?.[1] ?? '')
  .split('\n').filter((line) => /^  [a-z0-9]+: \{/.test(line)).map((line) => line.trim().replace(/: \{$/, ''))
check('five families including generic', FAMILY_IDS.length === 5 && FAMILY_IDS.includes('generic'), FAMILY_IDS.join(', '))
check('tools use the same family ids', tools.includes("const FAMILY_IDS = ['classic', 'anima', 'krea2', 'moss', 'generic']"))
for (const id of FAMILY_IDS) {
  const at = comfy.indexOf(`  ${id}: {`)
  const window = comfy.slice(at, at + 900)
  // generic 故意没有 defaultModel：它必须由调用方显式给 model + textEncoder + vae。
  check(`family ${id} declares label and defaults`, /label: '/.test(window) && /defaults: \{/.test(window) && (id === 'generic' ? /requiresCompanions: true/.test(window) : /defaultModel: '/.test(window)))
}

// ---------------------------------------------------------------- guides
const guideFiles = readdirSync(path.join(root, 'guides')).filter((f) => f.endsWith('.md')).sort()
check('guides include the four families plus README', ['anima.md', 'classic.md', 'krea2.md', 'moss.md', 'README.md'].every((f) => guideFiles.includes(f)), guideFiles.join(', '))
check('prompt template library survived the skills cleanup', guideFiles.includes('prompt-patterns.md'))
for (const id of FAMILY_IDS) {
  check(`guides/${id}.md exists and names its family`, existsSync(path.join(root, 'guides', `${id}.md`)) && read(`guides/${id}.md`).includes(`family \`${id}\``))
}
check('GUIDE_FILES maps every family', FAMILY_IDS.every((id) => new RegExp(`${id}: '[a-z0-9-]+\\.md'`).test(tools)))
check('drawing_guide exposes the extra guide', tools.includes('EXTRA_GUIDE_IDS') && tools.includes("'prompt-patterns'"))
check('drawing_guide enum spreads families and extras', /enum: \[\.\.\.FAMILY_IDS, \.\.\.EXTRA_GUIDE_IDS\]/.test(tools))
check('guide index mentions the template library', read('guides/README.md').includes('prompt-patterns.md'))

// ---------------------------------------------------------------- no dangling skills/
const SKILLS_RE = /skills[\\/]/
const textFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(md|js|mjs|json|yml)$/.test(entry.name)) textFiles.push(full)
  }
}
walk(root)
// 这个测试文件本身要提到被删掉的目录名，跳过它自己。
const dangling = textFiles
  .filter((file) => path.relative(root, file) !== path.join('test', 'offline-contract.mjs'))
  .filter((file) => SKILLS_RE.test(readFileSync(file, 'utf8')))
check('no references to the removed skills/ tree', dangling.length === 0, dangling.map((f) => f.replace(root, '')).join(', '))
check('manifest no longer ships skills', !(pkg.files ?? []).includes('skills'))

// ---------------------------------------------------------------- manifest
check('manifest ships guides and test', ['guides', 'test'].every((entry) => pkg.files.includes(entry)))
check('client module id equals package name', read('lib/client.js').includes(`id: '${pkg.name}'`))
check('npm test runs this file plus the other offline suites', /offline-contract/.test(pkg.scripts?.test ?? ''))


// —— 9. 路径与调用约定 ——
check('reads the official workingDirectory service (optional access)', tools.includes("ctx.get?.('workingDirectory')") && !/export const inject = \[[^\]]*'workingDirectory'/.test(tools))
check('wires that service in apply()', tools.includes("workingDirectoryService = ctx.get?.('workingDirectory')") && tools.includes('settings.cwdOf = cwdFor'))
check('no ad-hoc session header cwd reads left', !tools.includes('sessionCwd(') && tools.includes("session?.header?.cwd"))
check('initImage only accepts a local path', tools.includes('initImageName') && tools.includes('initImage 不存在'))
check('initImage and initImageName are exclusive', tools.includes('和 initImageName（ComfyUI input 文件名）只能给一个'))
check('workflow name/path are exclusive', tools.includes('path（本机文件路径）和 name（工作流名）只能给一个'))
check('pnginfo sha256/name/path are exclusive', tools.includes('sha256、name、path 只能给一个'))
check('pnginfo user-folder search is opt-in', tools.includes('searchUserDirs') && /args\.searchUserDirs\s*\?/.test(tools))
check('default image roots exclude Desktop/Downloads', !/const roots = \[[sS]{0,200}defaultImageRoots/.test(tools) || tools.includes('args.searchUserDirs'))
check('saves use exclusive creation', /flag: 'wx'/.test(tools))
check('offline status reports online: false', /online: false/.test(tools))

const objectProps = [...tools.matchAll(/\b(text|online|version|vramTotalGB|vramFreeGB|queueRunning|queuePending|families|models|family|path|promptId|images|model|params|seconds|timedOut|queue|records|workflows|source|hasPrompt|hasWorkflow|loras): \{ type: 'object' \}/g)]
check('every object property declares additionalProperties', objectProps.length === 0, objectProps.map((m) => m[1]).join(', '))

const schemaCount = (tools.match(/output: \{ schema: \{ type: 'object', additionalProperties: true, properties: \{/g) ?? []).length
check('all twelve tools declare output properties', schemaCount === 12, String(schemaCount))

const comfySrc = read("lib/comfy-client.js")
check('comfy-client rejects missing initImage instead of guessing', comfySrc.includes('initImage 文件不存在') && !comfySrc.includes('assume the caller passed an existing ComfyUI input name'))
check('comfy-client honours an explicit initImageName', /resolveInitImage\(origin, resolved\.initImage, resolved\.initImageName\)/.test(comfySrc))


// —— 10. 换机器也能用：不假设路径与模型文件名 ——
check('asks ComfyUI for its folder layout', comfySrc.includes('/internal/folder_paths') && comfySrc.includes('export async function discoverLayout'))
check('layout discovery degrades to null', /catch \{[\s\S]{0,200}?folderPathsCache\.set\(key, \{ at: Date\.now\(\), value \}\s*\)|value = null/.test(comfySrc))
check('layout caches per origin', comfySrc.includes('folderPathsCache') && comfySrc.includes('maxAgeMs'))
check('resolved layout records where paths came from', tools.includes("source: settings.modelsRootConfigured ? 'config'") && tools.includes("'discovered'"))
check('status reports setup diagnostics', tools.includes('setup: {') && tools.includes('launchConfigured') && tools.includes('modelsRootSource'))
check('status explains missing ComfyUI and port changes', tools.includes('没装 ComfyUI') && tools.includes('config.origin'))
check('generate picks a real model instead of a hardcoded name', tools.includes('candidates[0].name') && tools.includes('在这台机器的 ComfyUI 里没有可用模型'))
check('generate validates companion text encoder / VAE', tools.includes('text encoder') && tools.includes('同族模型与伴生文件要配套'))
check('workflow dirs fall back to the discovered root', /function workflowDirs\(settings, layout = null\)/.test(tools) && tools.includes("path.join(layout.comfyRoot, 'api-workflows')"))
check('models sizes use the resolved root', /listModels\(settings\.origin, \{ modelsRoot: layout\.modelsRoot \}\)/.test(tools))


// —— 11. 不预设任何 ComfyUI / 模型路径 ——
check('no default ComfyUI install path', !comfySrc.includes("path.join(os.homedir(), 'ComfyUI')") && !tools.includes("path.join(os.homedir(), 'ComfyUI')"))
check('DEFAULT_MODELS_ROOT never comes from the environment', comfySrc.includes('export const DEFAULT_MODELS_ROOT = null') && !comfySrc.includes('process.env.COMFY_MODELS_ROOT'))
check('sizes skip when the root is unknown', comfySrc.includes("if (typeof modelsRoot !== 'string' || modelsRoot === '') return null"))
check('layout source has an explicit unknown state', tools.includes("'none'") && !tools.includes(": 'guess'"))
check('settings keep unknown roots as null', tools.includes('modelsRoot: configuredModelsRoot ? path.resolve(configuredModelsRoot) : null') && tools.includes('const comfyRoot = configuredComfyRoot ? path.resolve(configuredComfyRoot) : null'))
check('workflows fall back to the plugin own dir when ComfyUI root is unknown', tools.includes(": ownWorkflowsDir)") && tools.includes("path.join(comfyRoot, 'api-workflows')"))
check('status re-reads the layout (no cached paths)', tools.includes('resolveLayout(settings, { fresh: true })'))
check('status explains an unknown path instead of inventing one', tools.includes('目录: 未知（未配置 comfyRoot/modelsRoot，ComfyUI 也没有报告目录表）'))
check('generate never fabricates a model directory', tools.includes('const whereToPut = (folder) =>') && tools.includes('让 ComfyUI 运行起来可自动读到路径'))
const ps1 = read('scripts/start-comfyui.ps1')
const sh = read('scripts/start-comfyui.sh')
check('launch scripts require an explicit ComfyUI home', ps1.includes('请用 -ComfyDir 或环境变量 COMFYUI_HOME 指定') && sh.includes('请用 COMFYUI_HOME 指定'))
check('launch scripts no longer default to ~/ComfyUI', !ps1.includes("Join-Path $env:USERPROFILE 'ComfyUI'") && !sh.includes('$HOME/ComfyUI'))


// —— 12. 装一个包就得到 agent 预设 ——
const patch = read("cordis.patch.yml")
check('tools patch declares the drawing-minimal preset', patch.includes("id: preset-drawing-minimal") && patch.includes("name: '@deepseek-ai/dsh-agent-preset'") && patch.includes('id: drawing-minimal'))
check('the preset mounts this package tools', patch.includes(`name: '${pkg.name}/tools'`))
const workflowTool = tools.slice(tools.indexOf("name: 'drawing_workflow'"))
check('drawing_workflow defines withMarkdown before using it', /const withMarkdown =/.test(workflowTool.slice(0, 8000)))
check('the preset keeps the minimal persona shape', patch.includes('complete: true') && patch.includes('includeRuntimeContext: false'))
check('the preset only reads images, not files', /readImage: true/.test(patch) && /read: false/.test(patch) && /write: false/.test(patch))
check('persona no longer names show_image', !patch.includes('show_image') && patch.includes('内联'))
check('the sidebar console row still ships', patch.includes('id: drawing-console'))
check('tools description mentions the preset', /agent preset/i.test(pkg.description ?? ''), pkg.description)


// —— 13. 预设与当前工具行为一致 ——
check('persona starts from a status check', patch.includes('drawing_status 体检'))
check('persona only picks families that have models', patch.includes('只从「本机有模型」的族里选'))
check('persona explains the omitted-model behaviour', patch.includes('不传 model 用本机该族第一个可用模型'))
check('persona respects unknown paths', patch.includes('不要猜默认目录') && patch.includes('目录未知'))
check('persona covers not-installed and wrong-port cases', patch.includes('安装它 / 改 config.origin'))
check('persona does not assume pwsh', !/用 pwsh (调|跑|下载)/.test(patch) && !/Invoke-(RestMethod|WebRequest)/.test(patch))
check('persona points at the prompt template library', patch.includes("family: 'prompt-templates'") || patch.includes("family: 'prompt-patterns'"))
check('preset description mentions image-only file access', patch.includes('文件只读图片、不可编辑'))
const guideReadme = read('guides/README.md')
check('guides point at drawing_download instead of hand-rolled curl', guideReadme.includes("drawing_download({ action: 'search'") && guideReadme.includes("drawing_download({ action: 'download'") && !guideReadme.includes('Invoke-RestMethod'))


// —— 14. Civitai 下载与凭据 ——
const civitaiSrc = read('lib/civitai.js')
const hostSrc = read('lib/host/index.js')
const clientSrc = read('lib/client.js')
check('download tool is defined', tools.includes("name: 'drawing_download'"))
check('download installs through the normalizer', tools.includes('install.installResponse') && tools.includes('install.sanitizeFileName'))
check('download writes provenance', tools.includes('install.writeProvenance'))
check('download supports hugging face', tools.includes('hf.listFiles') && tools.includes('hf.downloadUrlFor'))
check('download supports generic web search', tools.includes('webService.search'))
check('download tool exposes search, files, find and download', /enum: \['search', 'files', 'find', 'download'\]/.test(tools))
// 2026-11-23 复盘：/internal/folder_paths 的失败结果被缓存满 60 秒，ComfyUI 起来之后
// drawing_download 仍然一直报"不知道要安装到哪个目录"。失败只允许短缓存，且 fresh 必须能穿透。
check('folder_paths caps how long a failure is cached', comfy.includes('NEGATIVE_TTL_MS') && comfy.includes('hit.value === null ? Math.min(maxAgeMs, NEGATIVE_TTL_MS)'))
check('folder_paths honours maxAgeMs: 0', comfy.includes('Number.isFinite(requested) && requested >= 0 ? requested : 60_000'))
// 同一份复盘：路径报告曾把"端点没自报"直接说成"ComfyUI 离线"。
check('paths report probes liveness before claiming offline', tools.includes('const live = await comfy.status(settings.origin)'))
// 复盘：pnginfo 只拿配置里的 modelsRoot 核对 LoRA，没配置时每个 LoRA 都显示"未找到同名文件"。
check('pnginfo resolves LoRA against the live models root', tools.includes('describeRecipe(recipe, pngLayout?.modelsRoot ?? settings.modelsRoot)'))
// 复盘：Civitai 一个模型多个版本，search 只吐 versions[0]，Anima 版本搜不到。
check('civitai search exposes every model version', civitaiSrc.includes('versions: versions.map(') && tools.includes('versionId=${version.versionId'))
check('token comes from the credential service', civitaiSrc.includes("CIVITAI_REF_NAME = 'CIVITAI_TOKEN'") && civitaiSrc.includes('credentials.resolve'))
check('token falls back to the environment', civitaiSrc.includes('process.env[CIVITAI_REF_NAME]'))
check('no tool parameter accepts a token', !tools.includes('token: { type:') && civitaiSrc.includes('describeNamedToken'))
check('errors are redacted', civitaiSrc.includes('export function redact') && civitaiSrc.includes('Bearer'))
check('partial downloads are cleaned up', read('lib/install.js').includes('.part\`') && read('lib/install.js').includes('fs.rm(partial'))
check('host exposes credential routes', hostSrc.includes("path: `${BASE}/cred`") && hostSrc.includes("path: `${BASE}/cred/import`"))
check('present token can be imported from the legacy file', civitaiSrc.includes('readLegacyToken') && hostSrc.includes('readLegacyToken'))
check('client registers an AI drawing settings page', clientSrc.includes(`name: 'settings.section', id: '${pkg.name}'`) && clientSrc.includes('Civitai 凭据'))
check('client never renders the token back', clientSrc.includes("type: 'password'") && !clientSrc.includes('value: status.masked'))
// 桌面版页面挂在 dsh-app://，相对路径到不了 Host 网关：凭据面板必须和其余接口一样走 hostJson。
check('credential panel goes through the host base', clientSrc.includes("hostJson('/cred'") && clientSrc.includes("hostJson('/cred/import'") && !clientSrc.includes('fetch(API_PREFIX'))
// 凭据服务可能在 bundle 挂载之后才注册：工具调用时要现取，不能只用 apply 时的那一份。
check('tools re-resolve the credential service per call', tools.includes('const credentialsNow') && tools.includes("activeContext?.get?.('credentials')") && tools.includes('resolveToken(credentialsNow())'))
check('401 explains whether a token was attached', tools.includes('已附带 token（来源') && tools.includes('没有可用的 token'))
check('persona never asks the user for a token', patch.includes('不要向用户索要 token'))
check('persona no longer reads a plaintext token file', !patch.includes('.dsh/civitai_token'))
check('persona uses the download tool', patch.includes('drawing_download({ action:'))


// —— 15. 模型元数据与触发词 ——
const hfSrc = read('lib/huggingface.js')
const installSrc = read('lib/install.js')
check('civitai exposes version metadata', civitaiSrc.includes('export async function versionMetadata') && civitaiSrc.includes('trainedWords'))
check('search results carry trigger words and page url', civitaiSrc.includes('trainedWords: normalizeTriggerWords(version?.trainedWords)') && civitaiSrc.includes('pageUrl:'))
check('hugging face exposes repo metadata', hfSrc.includes('export async function repoInfo') && hfSrc.includes('instance_prompt'))
check('install records are readable offline', installSrc.includes('export async function readProvenance'))
check('download stores metadata in the record', tools.includes('metadata,') && tools.includes('metadataError,'))
check('download prints trigger words', tools.includes('describeTriggerWords(metadata)'))
check('models expose triggerWords', tools.includes('triggerWords: triggerWordsOf(meta)'))
check('pnginfo attaches trigger words to requirements', tools.includes('triggerWords: triggerWordsOf(record?.metadata)'))
check('persona uses trigger words when present', patch.includes('触发词：drawing_models'))


// —— 16. persona 块的缩进必须完整（YAML 折了这行会直接启动失败）——
const personaBody = patch.split('prefix: |-\n')[1]?.split('          - id: tool-pwsh')[0] ?? ''
const personaLines = personaBody.split('\n').filter((line) => line !== '')
const badIndent = personaLines.filter((line) => !line.startsWith('                '))
check('persona block is indented under prefix', badIndent.length === 0, badIndent.slice(0, 2).join(' | '))


// —— 17. 触发词的三种形态 ——
check('civitai normalizes multi-word sets', civitaiSrc.includes('function normalizeTriggerWords') && civitaiSrc.includes('splitCommas'))
check('civitai keeps author alternatives', civitaiSrc.includes('function triggerAlternatives') && civitaiSrc.includes('triggerAlternatives: triggerAlternatives'))
check('civitai extracts trigger hints from descriptions', civitaiSrc.includes('export function extractTriggerHints'))
check('hugging face marks alternatives too', hfSrc.includes('triggerAlternatives'))
check('tools read both trainedWords and triggerWords', tools.includes('const triggerWordsOf') && tools.includes('meta?.trainedWords') && tools.includes('meta?.triggerWords'))
check('tools print sets and alternatives separately', tools.includes('function describeTriggerWords') && tools.includes('备选触发词'))
check('persona explains set vs alternatives vs hints', patch.includes('一组多个词就一起用') && patch.includes('只选其中一组') && patch.includes('描述里的触发提示'))


check('pnginfo marks trigger words the original prompt used', tools.includes('usedInImage') && tools.includes('原图用了'))


// —— 18. 野生模型的文件头元数据 ——
const safeSrc = read('lib/safetensors.js')
check('safetensors headers are read without loading weights', safeSrc.includes('readBigUInt64LE') && safeSrc.includes('__metadata__'))
check('header fields map to plugin fields', safeSrc.includes('ss_base_model_version') && safeSrc.includes('modelspec.trigger_phrase') && safeSrc.includes('ss_tag_frequency'))
check('generic training tags are filtered', safeSrc.includes('GENERIC_TAGS') && safeSrc.includes('tagCandidates'))
check('tools fall back to headers for wild files', tools.includes('headerInfoFor') && tools.includes('safe.inspectModelFile'))
check('models read headers only without source metadata', tools.includes('if (model.source !== null || model.triggerWords.length > 0'))
check('pnginfo also reads headers', tools.includes('header = await headerInfoFor(layout, hit.folder, hit.name)'))
check('persona explains wild models', patch.includes('野生模型') && patch.includes('建议强度'))
check('guides document wild loras', guideReadme.includes('野生 LoRA'))


// —— 19. 出图时机：讨论时不画 ——
check('persona gates drawing behind an explicit request', patch.includes('出图时机') && patch.includes('只有用户明确要图才生成'))
check('persona lists what does not count as a request', patch.includes('以下都不算要图') && patch.includes('讨论画面'))
check('persona forbids drawing on ambiguous intent', patch.includes('意图不明时不要画') && patch.includes('草案') && patch.includes('等用户确认'))
check('installing a model is not a drawing request', patch.includes('刚装好模型') && patch.includes('不等于要出图'))
check('one request yields one batch', patch.includes('一次请求只出一批') && patch.includes('不自动追加变体'))
check('analysis stops before generating', patch.includes('分析完就停下'))
check('persona no longer says describe-then-draw', !patch.includes('你就直接出图'))


// —— 20. 多来源与备用站点 ——
check('civitai declares a mirror host', civitaiSrc.includes("CIVITAI_HOSTS = ['https://civitai.com', 'https://civitai.red']"))
check('hugging face declares a mirror host', hfSrc.includes("HF_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']"))
check('host fallback retries on network and 5xx only', civitaiSrc.includes('function fetchWithHosts') && civitaiSrc.includes('response.status >= 500'))
check('download tries mirror candidates', tools.includes('https://civitai.red/api/download/models/') && tools.includes('hf.HF_HOSTS[1]'))
check('guides no longer tell the agent to curl a registry', !read('guides/classic.md').includes('Invoke-RestMethod') && !read('guides/moss.md').includes('Invoke-RestMethod'))


// —— 21. 站点成败要进结果 ——
check('host loops report each attempt', civitaiSrc.includes('onAttempt') && civitaiSrc.includes('report.attempts'))
check('search returns per-source states', tools.includes('sourceStates') && tools.includes('sources: sourceStates'))
check('search prints the fallback chain', tools.includes('来源状态') && tools.includes("' ✗'") === false && tools.includes('✗'))
check('failure does not stop the next source', tools.includes('失败站点已即时跳过'))
check('download records its host attempts', tools.includes('downloadAttempts') && tools.includes('sources: downloadAttempts'))
check('files reports its host', tools.includes('hostChain') && tools.includes("sources: [{ source: 'huggingface'"))


// —— 22. 多 LoRA 与 ComfyUI 可见性 ——
check('lora list accepts arrays', tools.includes('export function parseLorasArg') && tools.includes('Array.isArray(value) ? value : [value]'))
check('comfy normalizes lora stacks', comfySrc.includes('export function normalizeLoraList') && comfySrc.includes('strengthClip'))
check('each lora becomes a LoraLoader', comfySrc.includes("add('LoraLoader'") && comfySrc.includes('modelRef = [id, 0]') && comfySrc.includes('clipRef = [id, 1]'))
check('ui workflow builder exists', comfySrc.includes('export function toUiWorkflow') && comfySrc.includes('NODE_WIDGETS'))
check('submission embeds the ui workflow', comfySrc.includes('extra_pnginfo') && comfySrc.includes('uiWorkflow'))
check('run is saved into ComfyUI workflows', comfySrc.includes('saveUserWorkflow') && comfySrc.includes('userdata/'))
check('client id is stable for queue visibility', comfySrc.includes("const clientId = 'dsh-drawing-tools'"))
check('missing lora is rejected before submitting', tools.includes('LoRA 不存在：'))
check('generate reports its comfy origin', tools.includes('ComfyUI：') && tools.includes('result.workflowSaved'))


// —— 23. 输出路径规范化与路径对账 ——
const outSrc = read('lib/output.js')
check('output root is normalized', outSrc.includes('export function normalizeOutputRoot') && outSrc.includes('os.homedir()'))
check('image names are canonical', outSrc.includes('sanitizeSlug') && outSrc.includes('_s'))
check('collisions get a suffix', outSrc.includes('-${attempt}.png'))
check('a JSONL index is written', outSrc.includes('index.jsonl') && outSrc.includes('appendIndex'))
check('comfy paths prefer the runtime report', tools.includes('discoveredModelsRoot ?? settings.modelsRoot') && tools.includes('modelsRootMismatch'))
check('status prints the path reconciliation', tools.includes('路径:') && tools.includes('drawing_paths({ action'))
check('drawing_paths is registered', tools.includes('function pathsTool') && tools.includes('pathsTool(settings)'))
check('adopt writes discovered paths back', tools.includes('configEditorService.edit'))

// —— 24. 路径只以 ComfyUI 自报为准 ——
check('settings ignore path env vars', !tools.includes('process.env.COMFY_ROOT ||') && !tools.includes('process.env.COMFY_MODELS_ROOT)') && tools.includes('const configuredComfyRoot = config.comfyRoot || null'))
check('workflow dirs follow the reported root', tools.includes('function apiWorkflowsDirFor') && tools.includes("path.join(layout.comfyRoot, 'api-workflows')"))
check('ui workflow dir follows the reported root', tools.includes('function uiWorkflowsDirFor') && tools.includes("path.join(layout.comfyRoot, 'user', 'default', 'workflows')"))
check('pnginfo saves into the reported dirs', tools.includes('apiWorkflowsDirFor(settings, saveLayout)') && tools.includes('uiWorkflowsDirFor(settings, saveLayout)'))


// —— 25. 模型官方文档：获取、存储、使用 ——
const docSrc = read('lib/modeldocs.js')
check('docs live in a canonical place', docSrc.includes("DOCS_DIRNAME = '.dsh-docs'") && docSrc.includes('index.json'))
check('docs keep provenance', docSrc.includes('fetchedAt') && docSrc.includes('sha256') && docSrc.includes('source'))
check('hugging face docs include the model card', docSrc.includes('fetchHuggingFaceDocs') && docSrc.includes('/raw/main/README.md'))
check('civitai docs include description and trigger words', docSrc.includes('fetchCivitaiDocs') && docSrc.includes('trainedWords'))
check('local docs next to a model are found', docSrc.includes('findLocalDocs') && docSrc.includes('README.md'))
check('guide prefers model docs', tools.includes("modeldocs.readDoc(layout.modelsRoot, { modelName: modelArg })"))
check('modeldoc tool is registered', tools.includes('function modeldocTool') && tools.includes('modeldocTool(settings)'))
check('install captures official docs', tools.includes('modeldocs.fetchHuggingFaceDocs({ repo: args.repo') && tools.includes('docPath'))

// —— 26. 显卡差异：检测与建议 ——
const hwSrc = read('lib/hardware.js')
check('hardware detection exists', hwSrc.includes('export async function detectHardware') && hwSrc.includes('classifyVendor'))
check('recommendations are per vendor', hwSrc.includes('export function recommendFor') && hwSrc.includes("--use-pytorch-cross-attention") && hwSrc.includes("--use-quad-cross-attention"))
check('vram tiers are handled', hwSrc.includes('--lowvram') && hwSrc.includes('--novram'))
check('windows vram uses the registry, not AdapterRAM', hwSrc.includes('qwMemorySize'))
check('status prints hardware advice', tools.includes('hardware.detectHardware()') && tools.includes('offlineHardwareLines'))
check('cpu runs are called out', tools.includes('ComfyUI 正在用 CPU 运行'))
check('launcher picks args per vendor', read('scripts/start-comfyui.ps1').includes('nvidia') && read('scripts/start-comfyui.ps1').includes('rocm') === false && read('scripts/start-comfyui.ps1').includes('--use-quad-cross-attention'))

// —— 27. 不依赖 imgr 的原生内联 ——
check('generate returns native markdown', tools.includes('function localImageMarkdown') && tools.includes('markdown: localImageMarkdown'))
check('markdown uses the percent-encoded absolute path', tools.includes('encodeURIComponent(file)'))
check('persona uses native markdown only', patch.includes('DSH 原生渲染本机图片路径') && !patch.includes('show_image'))
check('docs no longer require the inline-image bundle', !read('README.md').includes('needs the `dsh-inline-image` bundle'))

// —— 28. 与 imgr 解绑 ——
check('no image plugin is referenced by code', !tools.includes('show_image') && !tools.includes('imgr') && !tools.includes('inline-image'))
check('no image plugin is referenced by docs', !read('README.md').includes('dsh-inline-image') && !read('README.zh-CN.md').includes('dsh-inline-image'))

// —— 29. 启动 ComfyUI：自动探测与写配置 ——
const launchSrc = read('lib/launch.js')
check('launch detection exists', launchSrc.includes('export function detectLaunch') && launchSrc.includes('describeLaunch'))
check('detection looks for main.py and interpreters', launchSrc.includes("path.join(candidate.root, 'main.py')") && launchSrc.includes("'.ext', 'python.exe'"))
check('host uses detection when launch is unset', hostSrc.includes('detectLaunch(') && hostSrc.includes("mode: 'auto'"))
check('host explains an unconfigured launch', hostSrc.includes('drawing_setup') && hostSrc.includes('自动启动未就绪'))
check('status reports launch detection', tools.includes('launchDetected') && tools.includes('可自动启动'))
check('drawing_setup is registered with detect and apply', tools.includes('function setupTool') && tools.includes("enum: ['detect', 'apply']") && tools.includes('setupTool(settings)'))
check('setup writes the host launch config', tools.includes('configEditorService.entries()') && tools.includes('launch: { ...(current?.launch ?? {}), ...launchConfig }'))
if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall offline-contract checks passed')

