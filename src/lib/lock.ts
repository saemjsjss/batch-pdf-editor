// Apply-edits lock: an admin password (and optional spoken passphrase) that
// must be entered before edits are applied. Secrets are never stored — only
// PBKDF2-SHA256 hashes with a random salt, kept in this browser's localStorage.
//
// This is a workplace deterrent, not DRM: the app runs entirely in the browser,
// so someone with developer tools on the same PC could bypass it.

export const LOCK_KEY = 'batch-pdf-editor-lock-v1'
export const ATTEMPTS_KEY = 'batch-pdf-editor-lock-attempts'
export const ITERATIONS = 210_000
export const MIN_PASSWORD = 4
export const MAX_FAILS = 5
export const BASE_COOLDOWN_MS = 30_000

interface Hashed {
  salt: string
  hash: string
  /** voice only: number of words in the phrase, so it can be found inside a longer transcript */
  words?: number
}
export interface LockConfig {
  v: 1
  iterations: number
  pw: Hashed
  voice?: Hashed
}
interface Attempts {
  fails: number
  until: number
  strikes: number
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** Lowercase, drop punctuation, collapse spaces — what the recogniser and a typed phrase share. */
export function normalizePhrase(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validatePhrase(s: string): string | null {
  const n = normalizePhrase(s)
  if (n.split(' ').filter(Boolean).length < 2 || n.length < 8)
    return 'Use at least 2 words (8+ letters), e.g. "pink lotus morning".'
  if (/[^a-z0-9 ]/.test(n)) return 'Use English words only — the offline voice model is English.'
  return null
}

async function derive(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  )
  return b64(new Uint8Array(bits))
}

async function hashNew(secret: string, iterations: number): Promise<Hashed> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { salt: b64(salt), hash: await derive(secret, salt, iterations) }
}

async function matches(secret: string, h: Hashed, iterations: number) {
  return safeEqual(await derive(secret, unb64(h.salt), iterations), h.hash)
}

export class LockError extends Error {}

export function createLock(store: StorageLike, now: () => number = Date.now) {
  const read = (): LockConfig | null => {
    try {
      const raw = store.getItem(LOCK_KEY)
      if (!raw) return null
      const c = JSON.parse(raw) as LockConfig
      return c && c.v === 1 && c.pw?.hash ? c : null
    } catch {
      return null
    }
  }
  const write = (c: LockConfig | null) =>
    c ? store.setItem(LOCK_KEY, JSON.stringify(c)) : store.removeItem(LOCK_KEY)

  const readAttempts = (): Attempts => {
    try {
      const a = JSON.parse(store.getItem(ATTEMPTS_KEY) || '') as Attempts
      if (typeof a.fails === 'number') return a
    } catch {
      /* none */
    }
    return { fails: 0, until: 0, strikes: 0 }
  }
  const writeAttempts = (a: Attempts) => store.setItem(ATTEMPTS_KEY, JSON.stringify(a))

  /** ms left before another attempt is allowed (0 = allowed now) */
  const cooldownLeft = () => Math.max(0, readAttempts().until - now())

  const recordResult = (ok: boolean) => {
    if (ok) return writeAttempts({ fails: 0, until: 0, strikes: 0 })
    const a = readAttempts()
    a.fails += 1
    if (a.fails >= MAX_FAILS) {
      a.strikes += 1
      a.until = now() + BASE_COOLDOWN_MS * 2 ** (a.strikes - 1)
      a.fails = 0
    }
    writeAttempts(a)
  }

  const guard = () => {
    const left = cooldownLeft()
    if (left > 0) throw new LockError(`Too many wrong attempts. Try again in ${Math.ceil(left / 1000)}s.`)
  }

  const checkPassword = async (pw: string) => {
    const c = read()
    if (!c) return true
    guard()
    const ok = await matches(pw, c.pw, c.iterations)
    recordResult(ok)
    return ok
  }

  const requirePassword = async (pw: string) => {
    if (!(await checkPassword(pw))) throw new LockError('Current password is wrong.')
  }

  return {
    status() {
      const c = read()
      return { enabled: !!c, voice: !!c?.voice }
    },
    cooldownLeft,

    /** Set the first password, or change it (requires the current one). */
    async setPassword(next: string, current?: string) {
      if (next.length < MIN_PASSWORD)
        throw new LockError(`Password must be at least ${MIN_PASSWORD} characters.`)
      const c = read()
      if (c) await requirePassword(current ?? '')
      const iterations = c?.iterations ?? ITERATIONS
      write({ v: 1, iterations, pw: await hashNew(next, iterations), voice: c?.voice })
    },

    async removeLock(current: string) {
      await requirePassword(current)
      write(null)
    },

    async setVoicePhrase(phrase: string, current: string) {
      const c = read()
      if (!c) throw new LockError('Set a password first.')
      const err = validatePhrase(phrase)
      if (err) throw new LockError(err)
      await requirePassword(current)
      const n = normalizePhrase(phrase)
      write({ ...c, voice: { ...(await hashNew(n, c.iterations)), words: n.split(' ').length } })
    },

    async clearVoicePhrase(current: string) {
      const c = read()
      if (!c) return
      await requirePassword(current)
      write({ ...c, voice: undefined })
    },

    /** True when unlocked (or no lock set). Wrong attempts count toward the cooldown. */
    verifyPassword: checkPassword,

    async verifyVoice(transcript: string) {
      const c = read()
      if (!c?.voice) return false
      guard()
      // the recogniser may catch a stray word before/after — try each window of the phrase length
      const words = normalizePhrase(transcript).split(' ').filter(Boolean)
      const n = c.voice.words ?? words.length
      let ok = false
      for (let i = 0; i + n <= words.length && i < 6 && !ok; i++)
        ok = await matches(words.slice(i, i + n).join(' '), c.voice, c.iterations)
      recordResult(ok)
      return ok
    },
  }
}

export type Lock = ReturnType<typeof createLock>

let shared: Lock | null = null
/** The app-wide lock backed by localStorage. */
export function appLock(): Lock {
  if (!shared) shared = createLock(window.localStorage)
  return shared
}
