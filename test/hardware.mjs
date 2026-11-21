// Unit tests for GPU classification and launch-argument advice.
import { classifyVendor, recommendFor } from '../lib/hardware.js'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------- vendor classification
const cases = [
  ['NVIDIA GeForce RTX 4070', 'nvidia'],
  ['NVIDIA GeForce GTX 1660 SUPER', 'nvidia'],
  ['AMD Radeon RX 9070 XT', 'amd'],
  ['AMD Radeon(TM) Graphics', 'amd'],
  ['Intel(R) Arc(TM) A770 Graphics', 'intel'],
  ['Intel(R) UHD Graphics 630', 'intel'],
  ['Apple M3 Max', 'apple'],
  ['Microsoft Basic Display Adapter', 'none'],
]
for (const [name, expected] of cases) {
  check(`classify ${name}`, classifyVendor(name) === expected, classifyVendor(name))
}

// ---------------------------------------------------------------- recommendations
const nvidia = recommendFor({ vendor: 'nvidia', vramGB: 12, platform: 'win32' })
check('nvidia uses cuda attention', nvidia.flavor === 'cuda' && nvidia.args.includes('--use-pytorch-cross-attention'))
check('nvidia does not get AMD flags', !nvidia.args.includes('--use-quad-cross-attention') && !nvidia.args.includes('--force-fp32'))

const amdWin = recommendFor({ vendor: 'amd', vramGB: 16, platform: 'win32' })
check('amd on windows warns about rocm/directml', amdWin.flavor === 'rocm-or-directml' && amdWin.notes.join(' ').includes('DirectML'))
check('amd does not get cuda flags', !amdWin.args.includes('--use-pytorch-cross-attention'))

const amdSmall = recommendFor({ vendor: 'amd', vramGB: 4, platform: 'win32' })
check('low vram adds --lowvram', amdSmall.args.includes('--lowvram'))
const amdTiny = recommendFor({ vendor: 'nvidia', vramGB: 1.5 })
check('very low vram adds --novram', amdTiny.args.includes('--novram'))

const cpu = recommendFor({ vendor: 'none' })
check('no gpu falls back to --cpu with a warning', cpu.flavor === 'cpu' && cpu.args.includes('--cpu') && cpu.notes.join(' ').includes('慢'))

const intel = recommendFor({ vendor: 'intel', vramGB: 8 })
check('intel uses ipex', intel.flavor === 'ipex' && intel.args.includes('--use-ipex'))

const unknown = recommendFor({ vendor: 'unknown' })
check('unknown vendor asks for detection instead of guessing', unknown.notes.join(' ').includes('没识别'))

check('every recommendation previews frames', recommendFor({ vendor: 'nvidia' }).args.includes('--preview-method'))

console.log(failed === 0 ? '\nALL HARDWARE CHECKS PASSED' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
