// Offline check for drawing_guide: no ComfyUI needed.
// Run: node test/guides.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { apply } from '../lib/tools.js'

const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const registered = []
const ctx = { effect: fn => fn(), tools: { register: d => (registered.push(d), () => {}) } }
apply(ctx, {})

const guide = registered.find(d => d.name === 'drawing_guide')
check('drawing_guide registered', Boolean(guide))
check('drawing_guide takes optional family', Boolean(guide?.parameters?.properties?.family) && !guide.parameters.required?.includes('family'))

for (const family of ['classic', 'anima', 'krea2', 'moss']) {
  const value = await guide.execute({ family }, {})
  check(`guide ${family} loads`, value.family === family && value.text.length > 500, `${value.text.length} chars`)
  check(`guide ${family} absolute path`, path.isAbsolute(value.path) && existsSync(value.path))
  check(`guide ${family} is markdown`, value.text.startsWith(`以下是 family=${family}`) && value.text.includes('# '))
}

const index = await guide.execute({}, {})
check('guide index lists families', ['classic', 'anima', 'krea2', 'moss'].every(f => index.text.includes(f)))
check('guide index path', index.family === 'index' && existsSync(index.path))

let rejected = false
try {
  await guide.execute({ family: 'sdxl' }, {})
} catch (error) {
  rejected = /family|未知模型族|invalid arguments/.test(error.message)
}
check('guide rejects unknown family', rejected)
check('drawing_guide concurrency safe', guide.isConcurrencySafe({ family: 'moss' }) === true)

console.log('')
if (failures.length) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('ALL GUIDE CHECKS PASSED')
