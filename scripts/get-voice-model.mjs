// Downloads the offline English speech model used by voice unlock into public/models/.
// ~40 MB, fetched once; skipped if already present and complete.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const NAME = 'vosk-model-small-en-us-0.15.tar.gz'
const URLS = [
  `https://ccoreilly.github.io/vosk-browser/models/${NAME}`,
]
const EXPECTED_BYTES = 41_184_862

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = resolve(root, 'public', 'models', NAME)

if (existsSync(dest) && statSync(dest).size === EXPECTED_BYTES) {
  console.log(`Voice model already present: ${dest}`)
  process.exit(0)
}
mkdirSync(dirname(dest), { recursive: true })

let lastErr
for (const url of URLS) {
  const tmp = `${dest}.part`
  try {
    console.log(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
    const size = statSync(tmp).size
    if (size !== EXPECTED_BYTES) throw new Error(`unexpected size ${size} (expected ${EXPECTED_BYTES})`)
    renameSync(tmp, dest)
    console.log(`Saved ${dest} (${(size / 1e6).toFixed(1)} MB)`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    rmSync(tmp, { force: true })
    console.warn(`  failed: ${e.message}`)
  }
}
console.error(`Could not download the voice model: ${lastErr?.message}`)
process.exit(1)
