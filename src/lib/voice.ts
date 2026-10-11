// Offline speech recognition for voice unlock (Vosk, runs in a Web Worker).
// The model (~40 MB) is fetched by `npm run get-voice-model` into public/models/
// and never leaves this PC — no audio is sent anywhere.
import type { Model } from 'vosk-browser'

export const VOICE_MODEL_PATH = 'models/vosk-model-small-en-us-0.15.tar.gz'

let modelPromise: Promise<Model> | null = null

/** Whether the offline model file is installed next to the app. */
export async function voiceModelInstalled(): Promise<boolean> {
  try {
    const r = await fetch(VOICE_MODEL_PATH, { method: 'HEAD' })
    return r.ok && Number(r.headers.get('content-length') ?? '1') > 1_000_000
  } catch {
    return false
  }
}

export function voiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined'
  )
}

function loadModel(): Promise<Model> {
  if (!modelPromise) {
    // absolute URL: the model loads inside a worker whose base URL is a blob:
    const url = new URL(VOICE_MODEL_PATH, window.location.href).href
    modelPromise = import('vosk-browser').then((m) => m.createModel(url, -1))
    modelPromise.catch(() => {
      modelPromise = null
    })
  }
  return modelPromise
}

export interface ListenOptions {
  /** live text while speaking */
  onPartial?: (text: string) => void
  /** called once the model is loaded and the mic is open */
  onReady?: () => void
  signal?: AbortSignal
  /** stop after this long even if the speaker keeps going */
  maxMs?: number
}

/**
 * Listen to the microphone until the first complete utterance (or maxMs) and
 * return its transcript. Resolves '' if nothing was understood.
 */
export async function listenOnce({ onPartial, onReady, signal, maxMs = 8000 }: ListenOptions = {}): Promise<string> {
  const model = await loadModel()
  if (signal?.aborted) return ''
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  })
  const ctx = new AudioContext()
  const recognizer = new model.KaldiRecognizer(ctx.sampleRate)
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but is what vosk-browser's acceptWaveform expects and works everywhere
  const proc = ctx.createScriptProcessor(4096, 1, 1)

  return new Promise<string>((resolve) => {
    let done = false
    let last = ''
    const finish = (text: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
      recognizer.remove()
      resolve(text.trim())
    }
    const timer = setTimeout(() => finish(last), maxMs)
    signal?.addEventListener('abort', () => finish(''))

    recognizer.on('result', (m) => {
      const text = (m as { result?: { text?: string } }).result?.text ?? ''
      if (text.trim()) finish(text)
    })
    recognizer.on('partialresult', (m) => {
      const p = (m as { result?: { partial?: string } }).result?.partial ?? ''
      if (p) {
        last = p
        onPartial?.(p)
      }
    })
    proc.onaudioprocess = (e) => {
      if (!done) recognizer.acceptWaveform(e.inputBuffer)
    }
    source.connect(proc)
    proc.connect(ctx.destination)
    onReady?.()
  })
}
