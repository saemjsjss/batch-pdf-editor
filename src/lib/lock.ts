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
  /** admin password (optional — without it, the voice word alone unlocks) */
  pw?: Hashed
  /** lock switched off by the admin */
  off?: boolean
  /** custom English passphrase (hashed) */
  voice?: Hashed
  /** built-in non-English passphrase, e.g. 'bismillah' (not secret — anyone may say it) */
  voicePreset?: VoicePresetId
}

/**
 * Built-in passphrases for words the English model doesn't know. The recogniser is
 * restricted to these sound-alike word sequences (+ "[unk]"), and only an exact
 * match unlocks — tested against several voices and wrong phrases.
 */
export const VOICE_PRESETS = {
  bismillah: {
    label: 'Bismillah',
    variants: ['bis me la', 'this me la', 'biz me la', 'is me la', 'this me laugh', 'miss me la'],
  },
} as const
export type VoicePresetId = keyof typeof VOICE_PRESETS

export function presetMatches(id: VoicePresetId, transcript: string): boolean {
  const t = normalizePhrase(transcript)
  return (VOICE_PRESETS[id].variants as readonly string[]).includes(t)
}

/** word list for a grammar-restricted recogniser */
export function presetGrammar(id: VoicePresetId): string[] {
  return [...VOICE_PRESETS[id].variants, '[unk]']
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
  /** Out of the box (nothing saved yet) Apply asks for the spoken “Bismillah”. */
  const DEFAULT: LockConfig = { v: 1, iterations: ITERATIONS, voicePreset: 'bismillah' }

  /** null = lock turned off */
  const read = (): LockConfig | null => {
    try {
      const raw = store.getItem(LOCK_KEY)
      if (!raw) return DEFAULT
      const c = JSON.parse(raw) as LockConfig
      if (!c || c.v !== 1) return DEFAULT
      if (c.off) return null
      return c
    } catch {
      return DEFAULT
    }
  }
  const write = (c: LockConfig) => store.setItem(LOCK_KEY, JSON.stringify(c))
  const base = (c: LockConfig | null): LockConfig => ({ v: 1, iterations: c?.iterations ?? ITERATIONS })
  const presetOf = (c: LockConfig | null) =>
    c?.voicePreset && VOICE_PRESETS[c.voicePreset] ? c.voicePreset : undefined

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

  /** true if the password matches; false when wrong or when no password is set */
  const checkPassword = async (pw: string) => {
    const c = read()
    if (!c?.pw) return false
    guard()
    const ok = await matches(pw, c.pw, c.iterations)
    recordResult(ok)
    return ok
  }

  /** settings changes need the admin password — only once one has been set */
  const requireAdmin = async (current: string | undefined) => {
    if (!read()?.pw) return
    if (!(await checkPassword(current ?? ''))) throw new LockError('Current password is wrong.')
  }

  const verifyVoice = async (transcript: string) => {
    const c = read()
    const preset = presetOf(c)
    // built-in phrase: not a secret, so misses don't count toward the cooldown
    if (preset) return presetMatches(preset, transcript)
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
  }

  return {
    status() {
      const c = read()
      const preset = presetOf(c)
      const voice = !!(c && (c.voice || preset))
      return {
        enabled: !!c && (!!c.pw || voice),
        hasPassword: !!c?.pw,
        voice,
        voicePreset: preset,
        voiceLabel: preset ? VOICE_PRESETS[preset].label : c?.voice ? 'custom phrase' : undefined,
      }
    },
    cooldownLeft,

    /** Set the first password, or change it (requires the current one). */
    async setPassword(next: string, current?: string) {
      if (next.length < MIN_PASSWORD)
        throw new LockError(`Password must be at least ${MIN_PASSWORD} characters.`)
      await requireAdmin(current)
      const c = read()
      const it = c?.iterations ?? ITERATIONS
      write({ ...base(c), voice: c?.voice, voicePreset: c?.voicePreset, pw: await hashNew(next, it) })
    },

    /** Turn the whole lock off (Apply runs without asking). */
    async removeLock(current?: string) {
      await requireAdmin(current)
      write({ ...base(read()), off: true })
    },

    async setVoicePhrase(phrase: string, current?: string) {
      const err = validatePhrase(phrase)
      if (err) throw new LockError(err)
      await requireAdmin(current)
      const c = read()
      const n = normalizePhrase(phrase)
      const voice = { ...(await hashNew(n, c?.iterations ?? ITERATIONS)), words: n.split(' ').length }
      write({ ...base(c), pw: c?.pw, voice })
    },

    async setVoicePreset(id: VoicePresetId, current?: string) {
      if (!VOICE_PRESETS[id]) throw new LockError('Unknown voice preset.')
      await requireAdmin(current)
      const c = read()
      write({ ...base(c), pw: c?.pw, voicePreset: id })
    },

    async clearVoicePhrase(current?: string) {
      await requireAdmin(current)
      const c = read()
      write({ ...base(c), pw: c?.pw, off: !c?.pw })
    },

    verifyPassword: checkPassword,
    verifyVoice,

    /**
     * What the unlock box accepts when typed: the password if one is set,
     * otherwise the voice word itself (for PCs without a microphone).
     */
    async verifyTyped(text: string) {
      const c = read()
      if (!c) return true
      if (c.pw) return checkPassword(text)
      const preset = presetOf(c)
      if (preset) return normalizePhrase(text) === normalizePhrase(VOICE_PRESETS[preset].label)
      return verifyVoice(text)
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
