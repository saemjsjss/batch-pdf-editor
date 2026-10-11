import { describe, expect, it } from 'vitest'
import {
  createLock,
  normalizePhrase,
  presetGrammar,
  presetMatches,
  validatePhrase,
  LOCK_KEY,
  MAX_FAILS,
  type StorageLike,
} from '../../src/lib/lock'

function memStore(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe('lock', () => {
  it('out of the box Apply asks for “Bismillah” (no password needed)', async () => {
    const lock = createLock(memStore())
    expect(lock.status()).toMatchObject({ enabled: true, hasPassword: false, voicePreset: 'bismillah' })
    expect(await lock.verifyTyped('Bismillah')).toBe(true)
    expect(await lock.verifyTyped('bismillah!')).toBe(true)
    expect(await lock.verifyTyped('hello')).toBe(false)
    expect(await lock.verifyVoice('this me la')).toBe(true)
    expect(await lock.verifyPassword('anything')).toBe(false)
  })

  it('can be turned off and on again without a password', async () => {
    const lock = createLock(memStore())
    await lock.removeLock()
    expect(lock.status().enabled).toBe(false)
    expect(await lock.verifyTyped('anything')).toBe(true)
    await lock.setVoicePreset('bismillah')
    expect(lock.status()).toMatchObject({ enabled: true, voicePreset: 'bismillah' })
  })

  it('with an admin password, typing the password unlocks and the word alone does not', async () => {
    const lock = createLock(memStore())
    await lock.setPassword('admin-pass')
    expect(lock.status()).toMatchObject({ enabled: true, hasPassword: true, voicePreset: 'bismillah' })
    expect(await lock.verifyTyped('admin-pass')).toBe(true)
    expect(await lock.verifyTyped('Bismillah')).toBe(false)
    expect(await lock.verifyVoice('bis me la')).toBe(true)
    await expect(lock.removeLock('nope')).rejects.toThrow(/wrong/)
  })

  it('stores only a salted hash, never the password', async () => {
    const store = memStore()
    const lock = createLock(store)
    await lock.setPassword('hangeul2026')
    const raw = store.data.get(LOCK_KEY)!
    expect(raw).not.toContain('hangeul2026')
    expect(JSON.parse(raw).pw.salt).toBeTruthy()
    expect(await lock.verifyPassword('hangeul2026')).toBe(true)
    expect(await lock.verifyPassword('wrong')).toBe(false)
  })

  it('rejects short passwords and needs the current one to change/remove', async () => {
    const lock = createLock(memStore())
    await expect(lock.setPassword('abc')).rejects.toThrow(/at least/)
    await lock.setPassword('first-pass')
    await expect(lock.setPassword('second-pass', 'nope')).rejects.toThrow(/wrong/)
    await lock.setPassword('second-pass', 'first-pass')
    expect(await lock.verifyPassword('second-pass')).toBe(true)
    await expect(lock.removeLock('first-pass')).rejects.toThrow()
    await lock.removeLock('second-pass')
    expect(lock.status().enabled).toBe(false)
    expect(lock.status().hasPassword).toBe(false)
  })

  it('cools down after repeated wrong attempts, and the cooldown expires', async () => {
    let t = 1_000_000
    const lock = createLock(memStore(), () => t)
    await lock.setPassword('correct-horse')
    for (let i = 0; i < MAX_FAILS; i++) expect(await lock.verifyPassword('bad')).toBe(false)
    await expect(lock.verifyPassword('correct-horse')).rejects.toThrow(/Too many/)
    t += 31_000
    expect(await lock.verifyPassword('correct-horse')).toBe(true)
  })

  it('voice phrase: normalised, needs password to set, matches inside a longer transcript', async () => {
    const lock = createLock(memStore())
    await lock.setPassword('admin-pass')
    await expect(lock.setVoicePhrase('pink lotus morning', 'bad')).rejects.toThrow()
    await lock.setVoicePhrase('Pink Lotus, morning!', 'admin-pass')
    expect(lock.status().voice).toBe(true)
    expect(await lock.verifyVoice('pink lotus morning')).toBe(true)
    expect(await lock.verifyVoice('the pink lotus morning')).toBe(true)
    expect(await lock.verifyVoice('pink lotus evening')).toBe(false)
    await lock.clearVoicePhrase('admin-pass')
    expect(await lock.verifyVoice('pink lotus morning')).toBe(false)
  })

  it('validates phrases', () => {
    expect(normalizePhrase('  Hello,   World! ')).toBe('hello world')
    expect(validatePhrase('open')).toMatch(/2 words/)
    expect(validatePhrase('합격 증명서 입니다')).toMatch(/English/)
    expect(validatePhrase('pink lotus morning')).toBeNull()
  })
})

describe('Bismillah preset', () => {
  it('matches only the sound-alike sequences the recogniser produces', () => {
    for (const t of ['bis me la', 'this me la', 'This me laugh', 'biz me la']) expect(presetMatches('bismillah', t)).toBe(true)
    for (const t of ['[unk]', 'la [unk]', 'this is me laugh', 'unk this me la', '', 'open the door'])
      expect(presetMatches('bismillah', t)).toBe(false)
    expect(presetGrammar('bismillah')).toContain('[unk]')
  })

  it('needs the password to turn on, and misses never trigger the password cooldown', async () => {
    const lock = createLock(memStore())
    await lock.setPassword('admin-pass')
    await expect(lock.setVoicePreset('bismillah', 'wrong')).rejects.toThrow()
    await lock.setVoicePreset('bismillah', 'admin-pass')
    expect(lock.status()).toMatchObject({ voice: true, voicePreset: 'bismillah', voiceLabel: 'Bismillah' })
    for (let i = 0; i < MAX_FAILS * 2; i++) expect(await lock.verifyVoice('hello there')).toBe(false)
    expect(await lock.verifyVoice('bis me la')).toBe(true)
    expect(await lock.verifyPassword('admin-pass')).toBe(true) // not cooled down
  })

  it('custom phrase and preset replace each other', async () => {
    const lock = createLock(memStore())
    await lock.setPassword('admin-pass')
    await lock.setVoicePreset('bismillah', 'admin-pass')
    await lock.setVoicePhrase('green apple seven', 'admin-pass')
    expect(lock.status().voicePreset).toBeUndefined()
    expect(await lock.verifyVoice('bis me la')).toBe(false)
    expect(await lock.verifyVoice('green apple seven')).toBe(true)
  })
})

describe('staff edition (fixed lock)', () => {
  it('always asks for Bismillah, and settings changes have no effect', async () => {
    const store = memStore()
    const fixed = { v: 1 as const, iterations: 1000, voicePreset: 'bismillah' as const }
    const lock = createLock(store, Date.now, { fixed })
    store.setItem(LOCK_KEY, JSON.stringify({ v: 1, iterations: 1000, off: true }))
    expect(lock.status()).toMatchObject({ enabled: true, voicePreset: 'bismillah', hasPassword: false })
    await lock.removeLock()
    expect(lock.status().enabled).toBe(true)
    expect(await lock.verifyTyped('Bismillah')).toBe(true)
    expect(await lock.verifyTyped('anything')).toBe(false)
  })
})
