// Offline check for the original-bytes store: pasting an image must keep a copy
// of the untouched upload, because the attachment pipeline re-encodes it to JPEG.
// Run: node test/original-store.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-original-'))
process.env.DSH_HOME = home

const { originalsDir, originalRecord, readOriginal, saveOriginal, sha256Hex } = await import('../lib/pnginfo.js')

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bytes = readFileSync(path.join(root, 'test/fixtures/anima-cam-recipe.png'))
const sha = sha256Hex(bytes)
const sourcePath = 'C:\\Users\\someone\\Desktop\\lora-cam-high-11111_00001_.png'

check('stores an original upload', saveOriginal(bytes, { sha256: sha, name: 'lora-cam-high-11111_00001_.png', sourcePath }).sha256 === sha)
const stored = readOriginal(sha)
check('reads the exact bytes back', stored !== null && Buffer.compare(stored.bytes, bytes) === 0)
check('keeps the source path', stored?.record.sourcePath === sourcePath, String(stored?.record.sourcePath))
check('writes into <DSH_HOME>/drawing-pnginfo/originals', originalsDir().startsWith(path.join(home, 'drawing-pnginfo', 'originals')))

const before = saveOriginal(bytes, { sha256: sha }).savedAt
const again = saveOriginal(bytes, { sha256: sha })
check('re-saving the same image is idempotent', again.sha256 === sha && typeof again.savedAt === 'string' && typeof before === 'string')

let rejected = false
try { saveOriginal(bytes, { sha256: 'f'.repeat(64) }) } catch { rejected = true }
check('rejects bytes that do not match the declared hash', rejected)

check('unknown hash reads as null', readOriginal('a'.repeat(64)) === null && originalRecord('a'.repeat(64)) === null)

rmSync(home, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\n${failed} original-store check(s) failed`)
  process.exit(1)
}
console.log('\nALL ORIGINAL-STORE CHECKS PASSED')
