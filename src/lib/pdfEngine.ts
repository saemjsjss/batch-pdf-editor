// legacy build: polyfilled for older Chrome/Edge (the modern build needs Map.getOrInsertComputed)
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'
import type { TextSpan } from './pdfEdit'

export * from './pdfEdit'

// Each document gets its OWN module worker (Vite ?worker). Sharing one worker
// across documents breaks when a task is destroyed; a classic workerSrc worker
// hangs on render in the embedded browser. Per-doc module workers avoid both.

/**
 * Document cache: pdf.js does not tolerate repeated open/destroy cycles on
 * workers ("worker is being destroyed"), so each uploaded file's document is
 * opened once and kept alive until the file is removed.
 */
const docCache = new Map<string, pdfjs.PDFDocumentLoadingTask>()

export function getPdfDoc(id: string, data: ArrayBuffer): Promise<pdfjs.PDFDocumentProxy> {
  let task = docCache.get(id)
  if (!task) {
    const worker = new pdfjs.PDFWorker({
      port: new PdfWorker() as unknown as null,
    })
    task = pdfjs.getDocument({ data: data.slice(0), worker })
    task.promise.catch(() => docCache.delete(id))
    docCache.set(id, task)
  }
  return task.promise
}

export async function releasePdfDoc(id: string) {
  const task = docCache.get(id)
  docCache.delete(id)
  if (task) {
    try {
      await task.destroy()
    } catch {
      /* already broken */
    }
  }
}

export async function extractSpans(
  doc: pdfjs.PDFDocumentProxy,
  pageNum: number,
  scale: number,
): Promise<{ spans: TextSpan[]; viewportW: number; viewportH: number; pageH: number }> {
  {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const base = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const spans: TextSpan[] = []
    let i = 0
    for (const item of tc.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const t = item.transform
      // user-space: x = t[4], baseline y = t[5]; width/height in text space
      const ux = t[4]
      const uy = t[5]
      const size = Math.hypot(t[2], t[3]) || item.height
      const uw = item.width
      // viewport-space for overlay
      const tx = pdfjs.Util.transform(viewport.transform, t)
      const left = tx[4]
      const baselineVp = tx[5]
      const hVp = size * scale
      spans.push({
        id: `s${i++}`,
        str: item.str,
        x: ux,
        baselineY: uy,
        w: uw,
        size,
        left,
        top: baselineVp - hVp,
        width: uw * scale,
        height: hVp,
      })
    }
    return { spans, viewportW: viewport.width, viewportH: viewport.height, pageH: base.height }
  }
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
