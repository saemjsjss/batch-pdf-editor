import { useEffect, useRef, useState } from 'react'
import { KeyRound, Loader2, Lock, Mic, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { appLock, LockError, MIN_PASSWORD } from '@/lib/lock'
import { listenOnce, voiceModelInstalled, voiceSupported } from '@/lib/voice'

const errText = (e: unknown) => (e instanceof LockError ? e.message : `Something went wrong: ${String(e)}`)

function useVoiceAvailable(open: boolean): 'checking' | 'yes' | 'no-model' | 'unsupported' {
  const supported = voiceSupported()
  const [model, setModel] = useState<'checking' | 'yes' | 'no-model'>('checking')
  useEffect(() => {
    if (!open || !supported) return
    let live = true
    voiceModelInstalled().then((ok) => live && setModel(ok ? 'yes' : 'no-model'))
    return () => {
      live = false
    }
  }, [open, supported])
  return supported ? model : 'unsupported'
}

/** Asks for the admin password (or spoken passphrase) before Apply edits runs. */
export function UnlockDialog({
  open,
  onUnlocked,
  onCancel,
}: {
  open: boolean
  onUnlocked: () => void
  onCancel: () => void
}) {
  const lock = appLock()
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [listening, setListening] = useState<'off' | 'loading' | 'on'>('off')
  const [heard, setHeard] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const voiceState = useVoiceAvailable(open && lock.status().voice)

  useEffect(() => {
    if (!open) {
      setPw('')
      setError('')
      setHeard('')
      abortRef.current?.abort()
      setListening('off')
    }
  }, [open])

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!pw) return
    setChecking(true)
    setError('')
    try {
      if (await lock.verifyPassword(pw)) onUnlocked()
      else setError('Wrong password.')
    } catch (err) {
      setError(errText(err))
    } finally {
      setChecking(false)
      setPw('')
    }
  }

  async function speak() {
    setError('')
    setHeard('')
    const ac = new AbortController()
    abortRef.current = ac
    setListening('loading')
    try {
      const text = await listenOnce({
        signal: ac.signal,
        onReady: () => setListening('on'),
        onPartial: setHeard,
      })
      setListening('off')
      if (ac.signal.aborted) return
      setHeard(text)
      if (!text) return setError("Didn't catch that — try again, a little closer to the mic.")
      setChecking(true)
      if (await lock.verifyVoice(text)) onUnlocked()
      else setError('Passphrase did not match.')
    } catch (err) {
      setListening('off')
      const name = (err as { name?: string })?.name
      setError(
        name === 'NotAllowedError'
          ? 'Microphone permission was blocked. Allow it in the browser, or type the password.'
          : name === 'NotFoundError'
            ? 'No microphone found. Type the password instead.'
            : errText(err),
      )
    } finally {
      setChecking(false)
    }
  }

  const showVoice = lock.status().voice

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="unlock-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" style={{ color: 'var(--pk-primary)' }} /> Unlock to apply edits
          </DialogTitle>
          <DialogDescription>Applying edits is locked. Enter the admin password to continue.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="pk-stack">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            aria-label="Password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <button type="submit" className="pk-btn pk-btn-primary" disabled={!pw || checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Unlock
          </button>
        </form>
        {showVoice && (
          <div className="pk-stack" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="pk-btn pk-btn-soft"
              disabled={voiceState !== 'yes' || checking}
              onClick={listening === 'off' ? speak : () => abortRef.current?.abort()}
            >
              {listening === 'loading' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className={`h-4 w-4 ${listening === 'on' ? 'animate-pulse' : ''}`} />
              )}
              {listening === 'loading'
                ? 'Loading voice model…'
                : listening === 'on'
                  ? 'Listening… say your passphrase'
                  : 'Unlock with voice'}
            </button>
            {voiceState === 'no-model' && (
              <p className="pk-hint">Voice model not installed on this PC — use the password.</p>
            )}
            {voiceState === 'unsupported' && (
              <p className="pk-hint">This browser can't use the microphone here — use the password.</p>
            )}
            {heard && (
              <p className="pk-hint" data-testid="heard">
                Heard: “{heard}”
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Admin settings: set / change / remove the password and the voice passphrase. */
export function LockSettingsDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const lock = appLock()
  const [status, setStatus] = useState(lock.status())
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [phrase, setPhrase] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const voiceState = useVoiceAvailable(open)

  useEffect(() => {
    if (open) setStatus(lock.status())
    else {
      setCurrent('')
      setNext('')
      setConfirm('')
      setPhrase('')
      setMsg(null)
    }
  }, [open, lock])

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: ok })
      setStatus(lock.status())
      setCurrent('')
      setNext('')
      setConfirm('')
      setPhrase('')
      onChanged()
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  function savePassword(e: React.FormEvent) {
    e.preventDefault()
    if (next !== confirm) return setMsg({ ok: false, text: 'The two new passwords do not match.' })
    void run(
      () => lock.setPassword(next, status.enabled ? current : undefined),
      status.enabled ? 'Password changed.' : 'Lock is on. Apply edits now needs this password.',
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="lock-settings">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" style={{ color: 'var(--pk-primary)' }} /> Apply-edits lock
          </DialogTitle>
          <DialogDescription>
            {status.enabled
              ? `Lock is ON${status.voice ? ' · voice unlock on' : ''}. Staff need the password to apply edits.`
              : 'Lock is OFF. Anyone using this PC can apply edits.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={savePassword} className="pk-stack">
          {status.enabled && (
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              aria-label="Current password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={`New password (${MIN_PASSWORD}+ characters)`}
            aria-label="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Repeat new password"
            aria-label="Repeat new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <button className="pk-btn pk-btn-primary" disabled={busy || !next || (status.enabled && !current)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {status.enabled ? 'Change password' : 'Turn lock on'}
          </button>
        </form>

        {status.enabled && (
          <div className="pk-stack" style={{ borderTop: '1px solid var(--pk-border)', paddingTop: 12 }}>
            <b className="text-sm" style={{ color: 'var(--pk-heading)' }}>
              Voice unlock (optional)
            </b>
            <p className="pk-hint" style={{ marginTop: 0 }}>
              A spoken passphrase in English, recognised offline on this PC. Anyone who overhears it can use
              it — choose an unusual phrase and keep the password as the main lock.
            </p>
            {voiceState === 'no-model' && (
              <p className="pk-hint text-red-600">Voice model file is missing from this install, so voice unlock will not work on this PC.</p>
            )}
            <Input
              placeholder='Passphrase, e.g. "pink lotus morning"'
              aria-label="Voice passphrase"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <button
              type="button"
              className="pk-btn pk-btn-soft"
              disabled={busy || !phrase || !current}
              onClick={() =>
                run(() => lock.setVoicePhrase(phrase, current), 'Voice passphrase saved.')
              }
            >
              <Mic className="h-4 w-4" /> {status.voice ? 'Replace voice passphrase' : 'Save voice passphrase'}
            </button>
            <div className="flex gap-2">
              {status.voice && (
                <button
                  type="button"
                  className="pk-btn pk-btn-soft"
                  disabled={busy || !current}
                  onClick={() => run(() => lock.clearVoicePhrase(current), 'Voice unlock turned off.')}
                >
                  Turn voice off
                </button>
              )}
              <button
                type="button"
                className="pk-btn pk-btn-soft"
                disabled={busy || !current}
                onClick={() => run(() => lock.removeLock(current), 'Lock removed.')}
              >
                Remove lock
              </button>
            </div>
            {!current && (
              <p className="pk-hint" style={{ marginTop: 0 }}>
                Enter the current password above to change voice settings or remove the lock.
              </p>
            )}
          </div>
        )}

        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>
            {msg.text}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
