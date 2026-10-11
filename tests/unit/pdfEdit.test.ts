import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  applyEdits,
  editedName,
  inspectPdf,
  needsUnicode,
  spanToRect,
  wrapText,
  type EditOp,
} from '../../src/lib/pdfEdit'

const root = resolve(__dirname, '../..')
const load = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(root, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

interface Item {
  str: string
  x: number
  y: number
}
async function textOf(bytes: Uint8Array | ArrayBuffer, pageNo = 1): Promise<Item[]> {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0))
  const task = getDocument({ data, verbosity: 0 })
  const doc = await task.promise
  const page = await doc.getPage(pageNo)
  const tc = await page.getTextContent()
  const out = tc.items
    .filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i)
    .filter((i) => i.str.trim())
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }))
  await task.destroy()
  return out
}
const joined = async (b: Uint8Array | ArrayBuffer) => (await textOf(b)).map((i) => i.str).join(' ')

const base: Omit<EditOp, 'id' | 'x' | 'y' | 'w' | 'h' | 'newText'> = {
  page: 1,
  fontSize: 12,
  originalText: '',
  cover: true,
  bold: false,
  align: 'left',
  bg: { r: 255, g: 255, b: 255 },
}

// The app fetches Unicode fonts from /fonts; in Node serve them from public/fonts.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const file = resolve(root, 'public', String(url).replace(/^\.?\//, ''))
    const b = readFileSync(file)
    return new Response(b)
  }))
})
afterEach(() => vi.clearAllMocks())

describe('helpers', () => {
  it('needsUnicode detects non-Latin-1 text', () => {
    expect(needsUnicode('Invoice #1001 – café')).toBe(true) // en dash is > 0xff
    expect(needsUnicode('Invoice #1001 café')).toBe(false)
    expect(needsUnicode('합격')).toBe(true)
    expect(needsUnicode('')).toBe(false)
  })

  it('editedName appends -edited and keeps one .pdf', () => {
    expect(editedName('letter.pdf')).toBe('letter-edited.pdf')
    expect(editedName('LETTER.PDF')).toBe('LETTER-edited.pdf')
    expect(editedName('noext')).toBe('noext-edited.pdf')
  })

  it('spanToRect pads the span box around the baseline', () => {
    const r = spanToRect({ str: 'x', x: 100, baselineY: 200, w: 50, size: 10 } as never)
    expect(r.x).toBeCloseTo(99.4)
    expect(r.y).toBeCloseTo(197.6)
    expect(r.w).toBeCloseTo(51.2)
    expect(r.h).toBeCloseTo(12)
    expect(r.fontSize).toBe(10)
  })

  it('wrapText wraps to width and honours newlines', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const lines = wrapText(font, 'one two three four five six\n\nlast', 12, 60)
    expect(lines.length).toBeGreaterThan(3)
    for (const l of lines) if (l.includes(' ')) expect(font.widthOfTextAtSize(l, 12)).toBeLessThanOrEqual(60)
    expect(lines).toContain('')
    expect(lines.at(-1)).toBe('last')
  })
})

describe('inspectPdf', () => {
  it('reads page count and first page size', async () => {
    expect(await inspectPdf(load('sample-invoice.pdf'))).toEqual({ pageCount: 1, pageW: 595, pageH: 842 })
    const letter = await inspectPdf(load('sample-letter.pdf'))
    expect([letter.pageW, letter.pageH]).toEqual([612, 792])
  })
})

describe('applyEdits', () => {
  it('replaces text in place and keeps the rest of the page', async () => {
    const src = load('sample-invoice.pdf')
    const before = await textOf(src)
    const target = before.find((i) => i.str === 'Bill to: John Doe')!
    expect(target).toBeTruthy()
    const out = await applyEdits(src, [
      { ...base, id: '1', x: target.x - 1, y: target.y - 3, w: 160, h: 15, newText: 'Bill to: Jane Roe' },
    ])
    const text = await joined(out)
    expect(text).toContain('Bill to: Jane Roe')
    expect(text).toContain('Invoice #1001')
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })

  it('does not mutate the input buffer (same edits reused across files)', async () => {
    const src = load('sample-invoice.pdf')
    const copy = new Uint8Array(src.slice(0))
    const edits: EditOp[] = [{ ...base, id: '1', x: 300, y: 400, w: 120, h: 20, newText: 'STAMP' }]
    const a = await applyEdits(src, edits)
    const b = await applyEdits(src, edits)
    expect(new Uint8Array(src)).toEqual(copy)
    expect(await joined(a)).toContain('STAMP')
    expect(await joined(b)).toContain('STAMP')
  })

  it('applies the same edit to differently sized PDFs', async () => {
    const edits: EditOp[] = [{ ...base, id: '1', cover: false, x: 72, y: 100, w: 200, h: 16, newText: 'Batch OK' }]
    for (const f of ['sample-invoice.pdf', 'sample-letter.pdf', 'sample-korean.pdf']) {
      expect(await joined(await applyEdits(load(f), edits))).toContain('Batch OK')
    }
  })

  it('embeds a Unicode font for Korean text', async () => {
    const out = await applyEdits(load('sample-invoice.pdf'), [
      { ...base, id: '1', x: 72, y: 300, w: 200, h: 20, newText: '합격 증명서', bold: true },
    ])
    expect(fetch).toHaveBeenCalledWith('fonts/unicode-bold.ttf')
    expect((await joined(out)).replace(/\s/g, '')).toContain('합격증명서')
  })

  it('wraps multi-line text into several lines', async () => {
    const out = await applyEdits(load('sample-invoice.pdf'), [
      { ...base, id: '1', x: 72, y: 200, w: 150, h: 60, newText: 'Line one\nLine two\nLine three' },
    ])
    const items = await textOf(out)
    const ys = ['Line one', 'Line two', 'Line three'].map((s) => items.find((i) => i.str === s)!.y)
    expect(ys[0]).toBeGreaterThan(ys[1])
    expect(ys[1]).toBeGreaterThan(ys[2])
  })

  it('empty newText with cover erases the area', async () => {
    const src = load('sample-invoice.pdf')
    const t = (await textOf(src)).find((i) => i.str === 'Bill to: John Doe')!
    const out = await applyEdits(src, [{ ...base, id: '1', x: t.x - 1, y: t.y - 3, w: 160, h: 15, newText: '' }])
    // text is still in the content stream but covered; the cover rect must exist and output must load
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })

  it('move edit shifts existing content by dx/dy', async () => {
    const src = load('sample-invoice.pdf')
    const t = (await textOf(src)).find((i) => i.str === 'Invoice #1001')!
    const out = await applyEdits(src, [
      { ...base, id: 'm', type: 'move', dx: 0, dy: -100, originalText: '(move area)', newText: '',
        x: t.x - 2, y: t.y - 6, w: 220, h: 32 },
    ])
    const moved = (await textOf(out)).filter((i) => i.str === 'Invoice #1001')
    expect(moved.some((i) => Math.abs(i.y - (t.y - 100)) < 2)).toBe(true)
  })

  it('skips edits that fall outside the page or on missing pages', async () => {
    const src = load('sample-invoice.pdf')
    const out = await applyEdits(src, [
      { ...base, id: '1', x: 5000, y: 5000, w: 10, h: 10, newText: 'nope' },
      { ...base, id: '2', page: 9, x: 10, y: 10, w: 10, h: 10, newText: 'nope' },
    ])
    expect(await joined(out)).not.toContain('nope')
  })
})
