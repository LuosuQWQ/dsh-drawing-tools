// Unit tests for the two credential sources behind the settings panel.
import { describeNamedToken, setNamedToken, clearNamedToken, credentialRefFor, redact } from '../lib/civitai.js'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const makeService = () => {
  const store = new Map()
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? null : { value, source: 'credentials' }
    },
    async describe(ref) {
      const value = store.get(ref)
      return value === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: 'credentials', writable: true, masked: '••••' }
    },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}

const envBefore = { CIVITAI_TOKEN: process.env.CIVITAI_TOKEN, HF_TOKEN: process.env.HF_TOKEN }
delete process.env.CIVITAI_TOKEN
delete process.env.HF_TOKEN

// ---------------------------------------------------------------- 两个来源各自独立
const service = makeService()
await setNamedToken(service, 'HF_TOKEN', 'hf_test_value')
const hf = await describeNamedToken(service, 'HF_TOKEN')
const civitai = await describeNamedToken(service, 'CIVITAI_TOKEN')
check('hugging face token is stored under its own ref', service.store.has(credentialRefFor('HF_TOKEN')))
check('hugging face reports configured', hf.configured === true, JSON.stringify(hf))
check('hugging face does not configure civitai', civitai.configured === false, JSON.stringify(civitai))
check('describe never returns the value', !JSON.stringify(hf).includes('hf_test_value'))
check('a second save replaces the value', await (async () => {
  await setNamedToken(service, 'HF_TOKEN', 'hf_second')
  return service.store.get(credentialRefFor('HF_TOKEN')) === 'hf_second'
})())
await clearNamedToken(service, 'HF_TOKEN')
check('clear only drops that source', service.store.size === 0)

// civitai 的写入不影响 HF
await setNamedToken(service, 'CIVITAI_TOKEN', 'civitai_value')
check('civitai token does not configure hugging face', (await describeNamedToken(service, 'HF_TOKEN')).configured === false)
await clearNamedToken(service, 'CIVITAI_TOKEN')

// ---------------------------------------------------------------- 环境变量兜底按名字取
process.env.HF_TOKEN = 'hf_from_env'
const envHf = await describeNamedToken(null, 'HF_TOKEN')
const envCivitai = await describeNamedToken(null, 'CIVITAI_TOKEN')
check('environment fallback reads the requested name', envHf.configured === true && envHf.source === 'env', JSON.stringify(envHf))
check('environment fallback does not leak across sources', envCivitai.configured === false, JSON.stringify(envCivitai))
delete process.env.HF_TOKEN

// 凭据库优先于环境变量：这是一致的规则，不要改成 env 优先
process.env.HF_TOKEN = 'hf_from_env'
await setNamedToken(service, 'HF_TOKEN', 'hf_from_store')
check('stored value outranks the environment', (await describeNamedToken(service, 'HF_TOKEN')).source !== 'env')
await clearNamedToken(service, 'HF_TOKEN')
delete process.env.HF_TOKEN

// ---------------------------------------------------------------- 错误路径
let emptyRejected = false
try { await setNamedToken(service, 'HF_TOKEN', '   ') } catch { emptyRejected = true }
check('an empty token is rejected', emptyRejected)
let noService = false
try { await setNamedToken(null, 'HF_TOKEN', 'hf_x') } catch (error) { noService = /HF_TOKEN/.test(String(error?.message)) }
check('a missing credential service explains the env fallback', noService)
let clearFails = false
try { await clearNamedToken(null, 'HF_TOKEN') } catch { clearFails = true }
check('clearing without a service fails loudly', clearFails)

// ---------------------------------------------------------------- 脱敏
check('redaction hides bearer tokens', !redact('authorization: Bearer hf_abcdefghij').includes('hf_abcdefghij'))
check('redaction hides query tokens', !redact('https://x/y?token=hf_abcdefghij&z=1').includes('hf_abcdefghij'))

for (const [name, value] of Object.entries(envBefore)) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all credential checks passed')
