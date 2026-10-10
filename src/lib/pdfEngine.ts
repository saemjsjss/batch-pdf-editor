import * as pdfjs from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'

// Each document gets its OWN module worker (Vite ?worker). Sharing one worker
// across documents breaks when a task is destroyed; a classic workerSrc worker
// hangs on render in the embedded browser. Per-doc module workers avoid both.

/** Latin-1 check: Helvetica (WinAnsi) cannot encode Korean/CJK/etc. */
function needsUnicode(text: string): boolean {
  return /[^\x00-\xff]/.test(text)
}

let unicodeFontBytes: Promise<ArrayBuffer> | null = null
function getUnicodeFontBytes(): Promise<ArrayBuffer> {
  if (!unicodeFontBytes) {
    unicodeFontBytes = fetch('fonts/unicode.ttf').then((r) => {
      if (!r.ok) throw new Error(`Unicode font missing (${r.status})`)
      return r.arrayBuffer()
    })
    unicodeFontBytes.catch(() => {
      unicodeFontBytes = null
    })
  }
  return unicodeFontBytes
}

let unicodeBoldBytes: Promise<ArrayBuffer> | null = null
function getUnicodeBoldBytes(): Promise<ArrayBuffer> {
  if (!unicodeBoldBytes) {
    unicodeBoldBytes = fetch('fonts/unicode-bold.ttf').then((r) => {
      if (!r.ok) throw new Error(`Unicode bold font missing (${r.status})`)
      return r.arrayBuffer()
    })
    unicodeBoldBytes.catch(() => {
      unicodeBoldBytes = null
    })
  }
  return unicodeBoldBytes
}

export interface PdfFileItem {
  id: string
  name: string
  data: ArrayBuffer
  pageCount: number
  /** first-page size in points, used for layout-match badges */
  pageW?: number
  pageH?: number
}

/** A clickable text span found in the preview PDF. */
export interface TextSpan {
  id: string
  str: string
  /** PDF user-space geometry (points, bottom-left origin) */
  x: number
  baselineY: number
  w: number
  size: number
  /** Viewport geometry in px (top-left origin) for overlay positioning */
  left: number
  top: number
  width: number
  height: number
}

/** One edit to be applied to every uploaded PDF. */
export interface EditOp {
  id: string
  /** 1-based page number */
  page: number
  /** cover rectangle in PDF user space (y = bottom edge) */
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  originalText: string
  newText: string
  /** draw a cover rectangle over the region (false = pure text overlay) */
  cover: boolean
  bold: boolean
  /** horizontal alignment of each line inside the region */
  align: 'left' | 'center' | 'right'
  /** cover color, 0-255 */
  bg: { r: number; g: number; b: number }
  /** 'move': shift the existing page content of the rect by dx/dy (pt, y up). Runs before text edits. */
  type?: 'move'
  dx?: number
  dy?: number
}

/** Page count via pdf-lib — cheap, no worker, safe for bulk uploads. */
export async function countPages(data: ArrayBuffer): Promise<number> {
  const doc = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  return doc.getPageCount()
}

/** Page count + first-page size via pdf-lib — cheap, no worker, bulk-safe. */
export async function inspectPdf(
  data: ArrayBuffer,
): Promise<{ pageCount: number; pageW: number; pageH: number }> {
  const doc = await PDFDocument.load(data.slice(0), {
    ignoreEncryption: true,
    updateMetadata: false,
  })
  const first = doc.getPage(0)
  const { width, height } = first ? first.getSize() : { width: 0, height: 0 }
  return { pageCount: doc.getPageCount(), pageW: width, pageH: height }
}

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

/** Build the cover rect (user space) for a span-based edit. */
export function spanToRect(span: TextSpan) {
  const size = span.size
  return {
    x: span.x - size * 0.06,
    y: span.baselineY - size * 0.24,
    w: span.w + size * 0.12,
    h: size * 1.2,
    fontSize: size,
  }
}

/** Word-wrap text to a width at a given font size; honors \n. */
function wrapText(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxW) {
        line = candidate
      } else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

/** Apply a list of edits to one PDF, return the new PDF bytes. */
export async function applyEdits(data: ArrayBuffer, edits: EditOp[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(data.slice(0), { ignoreEncryption: true })
  // untouched source for 'move' edits — clips are embedded from here so the
  // original content is never degraded by covering
  const src = edits.some((e) => e.type === 'move')
    ? await PDFDocument.load(data.slice(0), { ignoreEncryption: true })
    : null
  const helvetica = await doc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold)
  let unicodeFont: PDFFont | null = null
  let unicodeBold: PDFFont | null = null
  const getUnicodeFont = async (bold: boolean): Promise<PDFFont> => {
    doc.registerFontkit(fontkit)
    if (bold) {
      if (!unicodeBold)
        unicodeBold = await doc.embedFont(await getUnicodeBoldBytes(), { subset: true })
      return unicodeBold
    }
    if (!unicodeFont)
      unicodeFont = await doc.embedFont(await getUnicodeFontBytes(), { subset: true })
    return unicodeFont
  }
  const pages = doc.getPages()

  // move edits first, then text edits
  const ordered = [...edits].sort(
    (a, b) => (a.type === 'move' ? 0 : 1) - (b.type === 'move' ? 0 : 1),
  )

  for (const e of ordered) {
    const page = pages[e.page - 1]
    if (!page) continue
    const { width: pw, height: ph } = page.getSize()
    const x = Math.max(0, Math.min(e.x, pw))
    const y = Math.max(0, Math.min(e.y, ph))
    const w = Math.min(e.w, pw - x)
    const h = Math.min(e.h, ph - y)
    if (w <= 0 || h <= 0) continue

    if (e.type === 'move') {
      if (!src) continue
      const srcPage = src.getPage(e.page - 1)
      if (!srcPage) continue
      const dx = e.dx ?? 0
      const dy = e.dy ?? 0
      // vector-preserving clip of the untouched page content
      const clip = await doc.embedPage(srcPage, { left: x, bottom: y, right: x + w, top: y + h })
      const color = rgb(e.bg.r / 255, e.bg.g / 255, e.bg.b / 255)
      // clear source AND destination, then re-draw the clip at the destination
      page.drawRectangle({ x, y, width: w, height: h, color })
      page.drawRectangle({ x: x + dx, y: y + dy, width: w, height: h, color })
      page.drawPage(clip, { x: x + dx, y: y + dy, width: w, height: h })
      continue
    }

    const text = e.newText
    let font: PDFFont = helvetica
    let size = e.fontSize
    let lines: string[] = []
    if (text) {
      font = needsUnicode(text)
        ? await getUnicodeFont(e.bold)
        : e.bold
          ? helveticaBold
          : helvetica
      lines = wrapText(font, text, size, w - 2)
      // single-line overflow in a bounded region: shrink a bit, never below 55%
      if (e.cover && lines.length === 1) {
        const minSize = Math.max(4, size * 0.55)
        while (size > minSize && font.widthOfTextAtSize(lines[0], size) > w - 2) size -= 0.5
      }
    }
    const lineHeight = size * 1.28
    const blockH = lines.length ? lines.length * lineHeight + size * 0.1 : 0

    if (e.cover) {
      // cover grows downward when the wrapped text needs more room than the region
      const coverH = Math.max(h, Math.min(blockH, y + h))
      page.drawRectangle({
        x,
        y: y + h - coverH,
        width: w,
        height: coverH,
        color: rgb(e.bg.r / 255, e.bg.g / 255, e.bg.b / 255),
      })
    }

    if (lines.length) {
      // text that fits inside the region is centered vertically;
      // overflowing text stays top-aligned so the downward-grown cover still matches
      const centered = e.cover && blockH > 0 && blockH <= h
      let baseline = centered ? y + (h + blockH) / 2 - size * 0.82 : y + h - size * 0.82
      for (const line of lines) {
        if (!line) {
          baseline -= lineHeight
          continue
        }
        let tx = x + 1
        if (e.align !== 'left') {
          const lw = font.widthOfTextAtSize(line, size)
          tx = e.align === 'center' ? x + (w - lw) / 2 : x + w - lw - 1
        }
        page.drawText(line, {
          x: tx,
          y: baseline,
          size,
          font,
          color: rgb(0, 0, 0),
        })
        baseline -= lineHeight
      }
    }
  }

  return doc.save()
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

export function editedName(name: string) {
  return name.replace(/\.pdf$/i, '') + '-edited.pdf'
}
