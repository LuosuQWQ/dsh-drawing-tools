// 复跑工作流（drawing_workflow run）必须把 UI 工作流写进 ComfyUI 的 Workflows 列表，
// 否则画布里只能看到旧文件，截出来的图和工作流对不上。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/comfy-client.js', import.meta.url), 'utf8')
const start = source.indexOf('export async function runWorkflow')
if (start < 0) throw new Error('runWorkflow not found')
const body = source.slice(start, start + 4000)

const checks = [
  ['rerun saves the UI workflow', /saveUserWorkflow\(origin, `dsh-run-/.test(body)],
  ['rerun reports workflowSaved', /workflowSaved/.test(body)],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failed += 1
}
if (failed > 0) process.exit(1)
console.log('ALL WORKFLOW-SAVE CHECKS PASSED')
