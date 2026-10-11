import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  Upload,
  Trash2,
  MousePointerClick,
  BoxSelect,
  Type,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Eye,
  BookMarked,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo2,
  Redo2,
  FileCheck2,
  AlertCircle,
  Square,
  Move,
  Lock,
  LockOpen,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { LockSettingsDialog, UnlockDialog } from '@/components/LockDialogs'
import { appLock } from '@/lib/lock'
import PdfPreview, { type RegionRect, type PreviewMode } from '@/components/PdfPreview'
import {
  applyEdits,
  downloadBytes,
  editedName,
  inspectPdf,
  releasePdfDoc,
  type EditOp,
  type PdfFileItem,
} from '@/lib/pdfEngine'

interface ResultItem {
  fileId: string
  name: string
  pageCount: number
  bytes?: Uint8Array
  error?: string
}

interface PendingEdit {
  rect: RegionRect
  fontSize: number
  originalText: string
  cover: boolean
}

interface Snippet {
  id: string
  name: string
  text: string
}

const TEMPLATES_KEY = 'batch-pdf-editor-templates'

const SEED_TEMPLATES: Snippet[] = [
  {
    id: 'seed-acceptance-paragraph',
    name: 'Acceptance paragraph (2025 Winter)',
    text: `위 사람이 2025학년도 겨울학기 한양대학교 국제교육원
한국어연수 과정에 합격하였음을 증명함.

This is to Certify that the applicant named above has been admitted to the
Korean Language Course of Hanyang University Institute of International Education
for 2025 Winter semester. This is a prerequisite program designed to improve korean
language proficiency, which is necessary for enrollment in the Bachelor of Business
Administration program which will start from 2026-09-01`,
  },
]

function loadTemplates(): Snippet[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    if (raw) return JSON.parse(raw) as Snippet[]
  } catch {
    /* corrupted -> reseed */
  }
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(SEED_TEMPLATES))
  return SEED_TEMPLATES
}

const uid = () => crypto.randomUUID()


const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<PdfFileItem[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.25)
  const [mode, setMode] = useState<PreviewMode>('click')
  const [edits, setEdits] = useState<EditOp[]>([])
  const [results, setResults] = useState<ResultItem[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** when set, the center pane shows this edited result instead of the source */
  const [resultView, setResultView] = useState<{
    fileId: string
    name: string
    data: ArrayBuffer
    pageCount: number
  } | null>(null)

  const [pending, setPending] = useState<PendingEdit | null>(null)
  const [newText, setNewText] = useState('')
  const [bold, setBold] = useState(false)
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('left')
  const [bgColor, setBgColor] = useState('#ffffff')
  const [templates, setTemplates] = useState<Snippet[]>(loadTemplates)
  const [lockOn, setLockOn] = useState(() => appLock().status().enabled)
  const [, setLockRev] = useState(0)
  const [showUnlock, setShowUnlock] = useState(false)
  const [showLockSettings, setShowLockSettings] = useState(false)


  /** undo / redo stacks for the edit list */
  const [past, setPast] = useState<EditOp[][]>([])
  const [future, setFuture] = useState<EditOp[][]>([])

  function commitEdits(next: EditOp[]) {
    setPast((p) => [...p.slice(-49), edits])
    setFuture([])
    setEdits(next)
    setResults([])
    setResultView(null)
  }

  function undo() {
    if (!past.length) return
    const prev = past[past.length - 1]
    setPast(past.slice(0, -1))
    setFuture([edits, ...future].slice(0, 50))
    setEdits(prev)
    setResults([])
    setResultView(null)
  }

  function redo() {
    if (!future.length) return
    const [next, ...rest] = future
    setPast([...past, edits])
    setFuture(rest)
    setEdits(next)
    setResults([])
    setResultView(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function persistTemplates(next: Snippet[]) {
    setTemplates(next)
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(next))
  }

  function saveTemplate() {
    const text = newText.trim()
    if (!text) return
    const name = window.prompt('Template name:', text.slice(0, 40))?.trim()
    if (!name) return
    persistTemplates([...templates.filter((t) => t.name !== name), { id: uid(), name, text }])
  }

  function deleteTemplate(id: string) {
    persistTemplates(templates.filter((t) => t.id !== id))
  }

  const previewFile = files.find((f) => f.id === previewId) ?? null
  const previewIdx = files.findIndex((f) => f.id === previewId)

  /** layout comparison against the first (template) file */
  function layoutMatch(f: PdfFileItem): boolean {
    const first = files[0]
    if (!first || f.id === first.id) return true
    if (f.pageCount !== first.pageCount) return false
    if (f.pageW && first.pageW && f.pageH && first.pageH) {
      return Math.abs(f.pageW - first.pageW) < 2 && Math.abs(f.pageH - first.pageH) < 2
    }
    return true
  }
  const mismatches = files.slice(1).filter((f) => !layoutMatch(f))

  async function handleUpload(list: FileList | null) {
    if (!list) return
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name))
    if (!pdfs.length) return
    setUploading(true)
    const items: PdfFileItem[] = []
    for (const f of pdfs) {
      const data = await f.arrayBuffer()
      let meta = { pageCount: 0, pageW: 0, pageH: 0 }
      try {
        meta = await inspectPdf(data)
      } catch {
        /* unreadable -> zeros */
      }
      items.push({ id: uid(), name: f.name, data, ...meta })
    }
    setFiles((prev) => {
      const next = [...prev, ...items]
      if (!previewId && items.length) setPreviewId(items[0].id)
      return next
    })
    setResults([])
    setResultView(null)
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeFile(id: string) {
    releasePdfDoc(id)
    setFiles((prev) => prev.filter((f) => f.id !== id))
    setResults((prev) => prev.filter((r) => r.fileId !== id))
    if (previewId === id) {
      const rest = files.filter((f) => f.id !== id)
      setPreviewId(rest[0]?.id ?? null)
      setPage(1)
    }
  }

  function clearAll() {
    for (const f of files) releasePdfDoc(f.id)
    setFiles([])
    setResults([])
    setResultView(null)
    setPreviewId(null)
    setEdits([])
    setPending(null)
    setPast([])
    setFuture([])
    setProgress(null)
    setPage(1)
  }

  function startPending(rect: RegionRect, originalText: string, cover: boolean) {
    setPending({ rect, fontSize: rect.fontSize, originalText, cover })
    setNewText(cover ? originalText : '')
    setEditingId(null)
  }

  function handleLineClick(rect: RegionRect, text: string) {
    startPending(rect, text, true)
  }

  function handleRegionDrawn(rect: RegionRect) {
    if (mode === 'move') {
      // move area: the rect selects existing content to shift, not a cover box
      startPending({ ...rect, fontSize: 11.89 }, '(move area)', true)
      setNewText('')
      setMoveDelta({ dx: 0, dy: 0 })
      return
    }
    // drawn boxes get the standard body size, not a size derived from box height,
    // and default to centered text inside the box
    startPending({ ...rect, fontSize: 11.89 }, '(custom region)', true)
    setNewText('')
    setAlign('center')
  }

  /** dx/dy (pt) for the pending move-area edit; y up, so "down" = negative dy */
  const [moveDelta, setMoveDelta] = useState({ dx: 0, dy: 0 })
  /** when set, the composer is re-adjusting this committed move edit */
  const [editingId, setEditingId] = useState<string | null>(null)

  /** reopen a committed move-area edit for re-nudging */
  function reopenMoveEdit(e: EditOp) {
    const hex =
      '#' + [e.bg.r, e.bg.g, e.bg.b].map((v) => v.toString(16).padStart(2, '0')).join('')
    setBgColor(hex)
    setMoveDelta({ dx: e.dx ?? 0, dy: e.dy ?? 0 })
    setPending({
      rect: { x: e.x, y: e.y, w: e.w, h: e.h, fontSize: e.fontSize },
      fontSize: e.fontSize,
      originalText: '(move area)',
      cover: true,
    })
    setNewText('')
    setEditingId(e.id)
    setPage(e.page)
    setMode('move')
  }

  // arrow-key nudging while a move-area edit is pending (1pt, Shift = 5pt)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pending || pending.originalText !== '(move area)') return
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      const step = e.shiftKey ? 5 : 1
      if (e.key === 'ArrowLeft') setMoveDelta((d) => ({ ...d, dx: d.dx - step }))
      else if (e.key === 'ArrowRight') setMoveDelta((d) => ({ ...d, dx: d.dx + step }))
      else if (e.key === 'ArrowUp') setMoveDelta((d) => ({ ...d, dy: d.dy + step }))
      else if (e.key === 'ArrowDown') setMoveDelta((d) => ({ ...d, dy: d.dy - step }))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  function handleTextPoint(x: number, baselineY: number) {
    const fontSize = 12
    startPending(
      { x, y: baselineY - fontSize * 0.24, w: 10_000, h: fontSize * 1.2, fontSize },
      '(new text)',
      false,
    )
  }

  /** side length (pt) for the placeable square */
  const [boxSide, setBoxSide] = useState(60)

  function handlePlacePoint(cx: number, cy: number) {
    if (pending && pending.originalText === '(placed box)') {
      // re-center the existing square at the clicked point
      const { w, h } = pending.rect
      setPending({ ...pending, rect: { ...pending.rect, x: cx - w / 2, y: cy - h / 2 } })
      return
    }
    const s = boxSide
    startPending({ x: cx - s / 2, y: cy - s / 2, w: s, h: s, fontSize: 11.89 }, '(placed box)', true)
    setNewText('')
    setAlign('center')
  }

  function movePending(rect: { x: number; y: number; w: number; h: number }) {
    setPending((p) => (p ? { ...p, rect: { ...p.rect, ...rect } } : p))
  }

  /** committed-edit dragging: history is committed once, on drag end */
  const editDragSnapshot = useRef<EditOp[] | null>(null)

  function onEditDragStart() {
    editDragSnapshot.current = edits
  }

  function onEditMove(id: string, pos: { x: number; y: number }) {
    setEdits((prev) => prev.map((e) => (e.id === id ? { ...e, ...pos } : e)))
  }

  function onEditDragEnd() {
    const snap = editDragSnapshot.current
    editDragSnapshot.current = null
    if (!snap) return
    setPast((p) => [...p.slice(-49), snap])
    setFuture([])
    setResults([])
    setResultView(null)
  }

  function addEdit() {
    if (!pending) return
    const hex = bgColor.replace('#', '')
    const bg = {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
    if (pending.originalText === '(move area)') {
      const op: EditOp = {
        id: editingId ?? uid(),
        type: 'move',
        page,
        ...pending.rect,
        fontSize: pending.fontSize,
        originalText: '(move area)',
        newText: '',
        cover: false,
        bold: false,
        align: 'left',
        bg,
        dx: moveDelta.dx,
        dy: moveDelta.dy,
      }
      // update-in-place keeps undo honest: history stores the pre-update edit
      commitEdits(editingId ? edits.map((x) => (x.id === editingId ? op : x)) : [...edits, op])
    } else {
      commitEdits([
        ...edits,
        {
          id: uid(),
          page,
          ...pending.rect,
          fontSize: pending.fontSize,
          originalText: pending.originalText,
          newText,
          cover: pending.cover,
          bold,
          align,
          bg,
        },
      ])
    }
    setPending(null)
    setNewText('')
    setEditingId(null)
  }

  const lockStatus = appLock().status()
  const lockAsk =
    lockStatus.voicePreset === 'bismillah' ? '“Bismillah”' : lockStatus.voice ? 'your phrase' : 'the password'

  function requestApply() {
    if (!files.length || !edits.length || busy) return
    // asks every time: say the voice word (or type it / the password), then Apply continues
    if (appLock().status().enabled) setShowUnlock(true)
    else void applyAll()
  }

  async function applyAll() {
    if (!files.length || !edits.length) return
    setBusy(true)
    setProgress({ done: 0, total: files.length })
    setResultView(null)
    const out: ResultItem[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      try {
        const bytes = await applyEdits(f.data, edits)
        out.push({ fileId: f.id, name: editedName(f.name), pageCount: f.pageCount, bytes })
      } catch (err) {
        out.push({ fileId: f.id, name: f.name, pageCount: f.pageCount, error: String(err) })
      }
      setProgress({ done: i + 1, total: files.length })
    }
    setResults(out)
    setBusy(false)
  }

  function viewResult(r: ResultItem) {
    if (!r.bytes) return
    setResultView({
      fileId: r.fileId,
      name: r.name,
      data: r.bytes.slice().buffer,
      pageCount: r.pageCount || 1,
    })
    setPage(1)
    setPending(null)
  }

  async function downloadZip() {
    const zip = new JSZip()
    for (const r of results) {
      if (r.bytes) zip.file(r.name, r.bytes)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'edited-pdfs.zip'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const okResults = results.filter((r) => r.bytes)

  function stepFile(d: number) {
    const i = previewIdx + d
    if (i < 0 || i >= files.length) return
    setPreviewId(files[i].id)
    setPage(1)
    setPending(null)
  }

  function stepResult(d: number) {
    if (!resultView) return
    const i = okResults.findIndex((r) => r.fileId === resultView.fileId) + d
    if (i < 0 || i >= okResults.length) return
    viewResult(okResults[i])
  }

  function editKind(e: EditOp): { icon: string; title: string; desc: React.ReactNode } {
    if (e.type === 'move') {
      const parts: string[] = []
      const dx = e.dx ?? 0
      const dy = e.dy ?? 0
      if (dx) parts.push(`${Math.abs(dx)}pt ${dx > 0 ? 'right' : 'left'}`)
      if (dy) parts.push(`${Math.abs(dy)}pt ${dy > 0 ? 'up' : 'down'}`)
      return {
        icon: '↕',
        title: `Move area · p${e.page}`,
        desc: `${Math.round(e.w)}×${Math.round(e.h)}pt region · ${parts.join(' + ') || 'no shift yet'}`,
      }
    }
    if (!e.cover) {
      return {
        icon: '+',
        title: 'Add text',
        desc: `"${truncate(e.newText, 40)}" · ${e.fontSize}pt${e.bold ? ' · bold' : ''} · p${e.page}`,
      }
    }
    if (e.originalText === '(placed box)') {
      return {
        icon: '▣',
        title: `Placed box · p${e.page}`,
        desc: e.newText
          ? `${Math.round(e.w)}pt box, write "${truncate(e.newText, 40)}"`
          : `${Math.round(e.w)}pt box cover`,
      }
    }
    if (e.originalText === '(custom region)') {
      return {
        icon: '▢',
        title: `Box · p${e.page}`,
        desc: e.newText
          ? `Cover region, write "${truncate(e.newText, 40)}"`
          : 'White cover region',
      }
    }
    return {
      icon: 'T',
      title: 'Replace text',
      desc: (
        <>
          <s>{truncate(e.originalText, 40)}</s> → {truncate(e.newText, 40) || '(erase)'} · p
          {e.page}
        </>
      ),
    }
  }

  return (
    <div
      className="min-h-screen"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleUpload(e.dataTransfer.files)
      }}
    >
      <header className="pk-header">
        <div className="pk-logo">
          <FileCheck2 className="h-5 w-5" />
        </div>
        <div>
          <h1>Bismillah PDF Editor</h1>
          <p>Edit once, apply to every PDF. Everything stays in your browser.</p>
        </div>
        <div className="pk-steps">
          <div className={`pk-step ${files.length ? 'done' : ''}`}>
            <b>{files.length ? '✓' : '1'}</b>Upload
          </div>
          <div className={`pk-step ${edits.length ? 'done' : ''}`}>
            <b>{edits.length ? '✓' : '2'}</b>Mark edits
          </div>
          <div className={`pk-step ${okResults.length ? 'done' : ''}`}>
            <b>{okResults.length ? '✓' : '3'}</b>Download
          </div>
        </div>
        <button
          className={`pk-lockbtn ${lockOn ? 'on' : ''}`}
          onClick={() => setShowLockSettings(true)}
          title="Password lock for Apply edits"
          aria-label={lockOn ? 'Lock settings (lock on)' : 'Lock settings (lock off)'}
        >
          {lockOn ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
          <span>{lockOn ? 'Locked' : 'Lock'}</span>
        </button>
      </header>

      <div className="pk-app">
        {/* LEFT: files */}
        <aside className="pk-card">
          <h2>
            PDF files
            <span className="flex items-center gap-2">
              <span className="pk-pill">{files.length}</span>
              {files.length > 0 && (
                <button
                  className="text-xs font-normal"
                  style={{ color: 'var(--pk-muted)' }}
                  onClick={clearAll}
                >
                  Clear all
                </button>
              )}
            </span>
          </h2>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <button
            className="pk-btn pk-btn-primary"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? 'Reading files…' : 'Upload PDFs'}
          </button>
          <ul className="pk-files">
            {files.map((f) => {
              const match = layoutMatch(f)
              const isTemplate = files[0]?.id === f.id
              return (
                <li
                  key={f.id}
                  className={`pk-file ${f.id === previewId ? 'active' : ''}`}
                  onClick={() => {
                    setPreviewId(f.id)
                    setPage(1)
                    setPending(null)
                    setResultView(null)
                  }}
                >
                  <div className="pk-thumb" />
                  <div className="min-w-0">
                    <div className="pk-fname">{f.name}</div>
                    <div className="pk-fsub">
                      {f.pageCount ? `${f.pageCount} page${f.pageCount > 1 ? 's' : ''}` : '—'}
                      {isTemplate ? ' · template' : ''}
                    </div>
                  </div>
                  <span className={`pk-badge ${match ? 'pk-b-ok' : 'pk-b-warn'}`}>
                    {match ? '✓' : '⚠ layout'}
                  </span>
                  <button
                    className="pk-fx"
                    title="Remove file"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFile(f.id)
                    }}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
          {!files.length && (
            <p className="pk-hint">
              Upload PDFs that share the same layout (e.g. invoices or letters with different
              numbers / names). Handles 60+ files at once.
            </p>
          )}
          <p className="pk-hint">Tip: drop more PDFs anywhere on the page.</p>
        </aside>

        {/* CENTER: preview */}
        <main className="pk-center">
          {resultView ? (
            <>
              <div className="pk-okbox flex items-center gap-2 flex-wrap">
                <FileCheck2 className="h-4 w-4 shrink-0" />
                <span className="flex-1 min-w-0 truncate">
                  Previewing edited result: <b>{resultView.name}</b>
                </span>
                <button className="pk-mini-btn" onClick={() => setResultView(null)}>
                  Back to original
                </button>
              </div>
              <div className="pk-stage">
                <PdfPreview
                  fileId={`result:${resultView.fileId}`}
                  fileData={resultView.data}
                  page={page}
                  scale={scale}
                  mode={mode}
                  edits={[]}
                  readonly
                  onLineClick={() => {}}
                  onRegionDrawn={() => {}}
                  onTextPoint={() => {}}
                />
              </div>
              <div className="pk-pager">
                <button
                  className="pk-icon-btn"
                  disabled={okResults.findIndex((r) => r.fileId === resultView.fileId) <= 0}
                  onClick={() => stepResult(-1)}
                  title="Previous PDF"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span>
                  Previewing <b>{resultView.name}</b> ·{' '}
                  {okResults.findIndex((r) => r.fileId === resultView.fileId) + 1} of{' '}
                  {okResults.length}
                </span>
                <button
                  className="pk-icon-btn"
                  disabled={
                    okResults.findIndex((r) => r.fileId === resultView.fileId) >=
                    okResults.length - 1
                  }
                  onClick={() => stepResult(1)}
                  title="Next PDF"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span style={{ color: 'var(--pk-muted)' }}>|</span>
                <button
                  className="pk-icon-btn"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  title="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span>
                  Page <b>{page}</b> / {resultView.pageCount}
                </span>
                <button
                  className="pk-icon-btn"
                  disabled={page >= resultView.pageCount}
                  onClick={() => setPage((p) => p + 1)}
                  title="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : previewFile ? (
            <>
              <div className="pk-toolbar">
                <button
                  className={`pk-tool ${mode === 'click' ? 'on' : ''}`}
                  onClick={() => setMode('click')}
                  title="Click text to replace just that text"
                >
                  <MousePointerClick className="h-4 w-4" /> Replace text
                </button>
                <button
                  className={`pk-tool ${mode === 'draw' ? 'on' : ''}`}
                  onClick={() => setMode('draw')}
                  title="Drag a rectangle over an area to cover and replace it"
                >
                  <BoxSelect className="h-4 w-4" /> Draw box
                </button>
                <button
                  className={`pk-tool ${mode === 'place' ? 'on' : ''}`}
                  onClick={() => setMode('place')}
                  title="Click to place a square, then drag it anywhere on the page"
                >
                  <Square className="h-4 w-4" /> Place box
                </button>
                <button
                  className={`pk-tool ${mode === 'move' ? 'on' : ''}`}
                  onClick={() => setMode('move')}
                  title="Drag a rectangle over existing content, then shift it with arrow keys or dx/dy"
                >
                  <Move className="h-4 w-4" /> Move area
                </button>
                <button
                  className={`pk-tool ${mode === 'text' ? 'on' : ''}`}
                  onClick={() => setMode('text')}
                  title="Click anywhere on the page to add new text there"
                >
                  <Type className="h-4 w-4" /> Add text
                </button>
                <span className="pk-sp" />
                <button
                  className="pk-icon-btn"
                  title="Undo (Ctrl+Z)"
                  disabled={!past.length}
                  onClick={undo}
                >
                  <Undo2 className="h-4 w-4" />
                </button>
                <button
                  className="pk-icon-btn"
                  title="Redo (Ctrl+Y)"
                  disabled={!future.length}
                  onClick={redo}
                >
                  <Redo2 className="h-4 w-4" />
                </button>
                <button
                  className="pk-icon-btn"
                  title="Zoom out"
                  onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
                >
                  <ZoomOut className="h-4 w-4" />
                </button>
                <span
                  className="text-[13px] w-12 text-center"
                  style={{ color: 'var(--pk-heading)' }}
                >
                  {Math.round(scale * 100)}%
                </span>
                <button
                  className="pk-icon-btn"
                  title="Zoom in"
                  onClick={() => setScale((s) => Math.min(3, s + 0.25))}
                >
                  <ZoomIn className="h-4 w-4" />
                </button>
              </div>

              <div className="pk-stage">
                <PdfPreview
                  fileId={previewFile.id}
                  fileData={previewFile.data}
                  page={page}
                  scale={scale}
                  mode={mode}
                  edits={edits}
                  pendingRect={pending?.rect ?? null}
                  pendingMove={
                    pending?.originalText === '(move area)'
                      ? { rect: pending.rect, dx: moveDelta.dx, dy: moveDelta.dy, bg: bgColor }
                      : null
                  }
                  skipMoveId={editingId}
                  onPlacePoint={handlePlacePoint}
                  onPendingMove={movePending}
                  onEditDragStart={onEditDragStart}
                  onEditMove={onEditMove}
                  onEditDragEnd={onEditDragEnd}
                  onLineClick={handleLineClick}
                  onRegionDrawn={handleRegionDrawn}
                  onTextPoint={handleTextPoint}
                />
              </div>
              <div className="pk-pager">
                <button
                  className="pk-icon-btn"
                  disabled={previewIdx <= 0}
                  onClick={() => stepFile(-1)}
                  title="Previous PDF"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="max-w-[45%] truncate">
                  Previewing <b>{previewFile.name}</b> · {previewIdx + 1} of {files.length}
                </span>
                <button
                  className="pk-icon-btn"
                  disabled={previewIdx >= files.length - 1}
                  onClick={() => stepFile(1)}
                  title="Next PDF"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span style={{ color: 'var(--pk-muted)' }}>|</span>
                <button
                  className="pk-icon-btn"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((p) => p - 1)
                    setPending(null)
                  }}
                  title="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span>
                  Page <b>{page}</b> / {previewFile.pageCount || '?'}
                </span>
                <button
                  className="pk-icon-btn"
                  disabled={page >= previewFile.pageCount}
                  onClick={() => {
                    setPage((p) => p + 1)
                    setPending(null)
                  }}
                  title="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : (
            <div className="pk-stage">
              <div
                className={`pk-drop ${dragOver ? 'over' : ''}`}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-10 w-10" />
                <b>Drag &amp; drop your PDFs here</b>
                <p>or click to browse — upload many files that share the same layout</p>
              </div>
            </div>
          )}
        </main>

        {/* RIGHT: composer + edits + downloads */}
        <aside>
          {pending && (
            <div className="pk-card" style={{ borderColor: 'var(--pk-primary)' }}>
              <h2>
                New edit — page {page}
                <span className="pk-pill">
                  {pending.originalText === '(move area)'
                    ? 'move area'
                    : pending.cover
                      ? pending.originalText === '(placed box)'
                        ? 'placed box'
                        : 'replace'
                      : 'add text'}
                </span>
              </h2>
              <div className="text-[13px] mb-3" style={{ color: 'var(--pk-text)' }}>
                {pending.originalText === '(move area)' ? (
                  <span style={{ color: 'var(--pk-muted)' }}>
                    Moving existing content — nudge with arrow keys (1 pt, Shift = 5 pt) or set
                    dx/dy below. PDF y goes up: dy −3 = 3 pt down. Drag the pink box to reselect
                    the area.
                  </span>
                ) : pending.originalText === '(placed box)' ? (
                  <span style={{ color: 'var(--pk-muted)' }}>
                    Box placed — drag the pink box on the page to move it, resize it from its
                    corner handle, or click elsewhere to re-place it.
                  </span>
                ) : pending.originalText === '(custom region)' ? (
                  <span style={{ color: 'var(--pk-muted)' }}>
                    Box drawn — drag the pink box on the page to move it, or resize it from its
                    corner handle.
                  </span>
                ) : (
                  <>
                    <span style={{ color: 'var(--pk-muted)' }}>
                      {pending.cover ? 'Replacing: ' : 'Adding text at clicked point'}
                    </span>
                    {pending.cover && (
                      <span className="font-medium break-all">{pending.originalText}</span>
                    )}
                  </>
                )}
              </div>
              {pending.originalText !== '(move area)' && (
                <>
                  <Textarea
                    autoFocus
                    placeholder="New text (empty = erase). Multi-line is fine — text wraps automatically."
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                    rows={3}
                  />
                  <div className="flex items-center gap-1.5 mt-2">
                    <select
                      className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm"
                      value=""
                      onChange={(e) => {
                        const t = templates.find((x) => x.id === e.target.value)
                        if (t) setNewText(t.text)
                      }}
                    >
                      <option value="" disabled>
                        Insert template…
                      </option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="pk-icon-btn"
                      title="Save the current text as a reusable template"
                      onClick={saveTemplate}
                      disabled={!newText.trim()}
                    >
                      <BookMarked className="h-4 w-4" />
                    </button>
                    {templates.length > 0 && (
                      <button
                        className="pk-icon-btn"
                        title="Delete a template…"
                        onClick={() => {
                          const names = templates.map((t) => t.name).join('\n')
                          const name = window.prompt(`Delete which template?\n${names}`)
                          const t = templates.find((x) => x.name === name)
                          if (t) deleteTemplate(t.id)
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-center gap-3 mt-3">
                {pending.originalText === '(move area)' && (
                  <>
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      style={{ color: 'var(--pk-muted)' }}
                    >
                      dx (pt)
                      <Input
                        type="number"
                        step={0.5}
                        className="w-20 h-8"
                        value={moveDelta.dx}
                        onChange={(e) =>
                          setMoveDelta((d) => ({ ...d, dx: Number(e.target.value) || 0 }))
                        }
                      />
                    </label>
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      style={{ color: 'var(--pk-muted)' }}
                    >
                      dy (pt)
                      <Input
                        type="number"
                        step={0.5}
                        className="w-20 h-8"
                        value={moveDelta.dy}
                        onChange={(e) =>
                          setMoveDelta((d) => ({ ...d, dy: Number(e.target.value) || 0 }))
                        }
                      />
                    </label>
                  </>
                )}
                {pending.originalText === '(placed box)' && (
                  <label
                    className="flex items-center gap-1.5 text-sm"
                    style={{ color: 'var(--pk-muted)' }}
                  >
                    Side
                    <Input
                      type="number"
                      min={6}
                      max={800}
                      className="w-20 h-8"
                      value={Math.round(pending.rect.w)}
                      onChange={(e) => {
                        const s = Math.max(6, Number(e.target.value) || 6)
                        setBoxSide(s)
                        setPending((p) => (p ? { ...p, rect: { ...p.rect, w: s, h: s } } : p))
                      }}
                    />
                  </label>
                )}
                {pending.originalText !== '(move area)' && (
                  <>
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      style={{ color: 'var(--pk-muted)' }}
                    >
                      Size
                      <Input
                        type="number"
                        min={4}
                        max={200}
                        className="w-20 h-8"
                        value={pending.fontSize}
                        onChange={(e) =>
                          setPending((p) =>
                            p ? { ...p, fontSize: Math.max(4, Number(e.target.value) || 4) } : p,
                          )
                        }
                      />
                    </label>
                    <label
                      className="flex items-center gap-1.5 text-sm cursor-pointer"
                      style={{ color: 'var(--pk-muted)' }}
                    >
                      <input
                        type="checkbox"
                        checked={bold}
                        onChange={(e) => setBold(e.target.checked)}
                        className="h-4 w-4 accent-[#E84A8A]"
                      />
                      <span className="font-bold">Bold</span>
                    </label>
                    <span className="flex items-center gap-0.5 rounded-md border p-0.5">
                      {(['left', 'center', 'right'] as const).map((a) => (
                        <button
                          key={a}
                          onClick={() => setAlign(a)}
                          className={`px-2 py-0.5 text-xs rounded capitalize ${
                            align === a ? 'text-white' : ''
                          }`}
                          style={
                            align === a
                              ? { background: 'var(--pk-primary)' }
                              : { color: 'var(--pk-muted)' }
                          }
                        >
                          {a === 'left' ? (
                            <AlignLeft className="h-3.5 w-3.5" />
                          ) : a === 'center' ? (
                            <AlignCenter className="h-3.5 w-3.5" />
                          ) : (
                            <AlignRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ))}
                    </span>
                  </>
                )}
                {pending.cover && (
                  <label
                    className="flex items-center gap-1.5 text-sm"
                    style={{ color: 'var(--pk-muted)' }}
                  >
                    Background
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      className="h-8 w-10 cursor-pointer rounded border"
                    />
                  </label>
                )}
              </div>
              <div className="flex gap-2 mt-3">
                <button className="pk-btn pk-btn-primary" onClick={addEdit}>
                  {editingId ? 'Update edit' : 'Add edit'}
                </button>
                <button
                  className="pk-btn pk-btn-soft"
                  onClick={() => {
                    setPending(null)
                    setEditingId(null)
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="pk-hint">
                {pending.originalText === '(move area)'
                  ? 'Moves the selected content itself (text stays sharp and selectable) — nothing is erased or retyped. Applied at the same position in every PDF.'
                  : pending.originalText === '(placed box)'
                    ? 'The pink square can be dragged anywhere on the page. It covers that spot and writes your text centered inside it, at the same position in every PDF.'
                    : pending.cover
                      ? 'Covers the original text with the background color and writes the new text on top, at the same spot in every PDF. Text auto-shrinks to fit.'
                      : 'Writes new text on top of the page at the clicked spot in every PDF, without covering anything.'}
              </p>
            </div>
          )}

          <div className="pk-card" style={pending ? { marginTop: 16 } : undefined}>
            <h2>
              Edits applied to all <span className="pk-pill">{edits.length}</span>
            </h2>
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              {edits.map((e) => {
                const k = editKind(e)
                return (
                  <div
                    className="pk-edit"
                    key={e.id}
                    onClick={e.type === 'move' ? () => reopenMoveEdit(e) : undefined}
                    style={{
                      cursor: e.type === 'move' ? 'pointer' : undefined,
                      borderColor: editingId === e.id ? 'var(--pk-primary)' : undefined,
                      background: editingId === e.id ? 'var(--pk-accent)' : undefined,
                    }}
                    title={e.type === 'move' ? 'Click to adjust dx/dy and nudge again' : undefined}
                  >
                    <div className="pk-eicon">{k.icon}</div>
                    <div className="min-w-0">
                      <div className="pk-etitle">{k.title}</div>
                      <div className="pk-edesc">{k.desc}</div>
                    </div>
                    <button
                      className="pk-x"
                      title="Delete edit"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        if (editingId === e.id) {
                          setEditingId(null)
                          setPending(null)
                        }
                        commitEdits(edits.filter((x) => x.id !== e.id))
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
              {!edits.length && (
                <p className="pk-hint" style={{ marginTop: 0 }}>
                  <b>Replace text</b>: click any word or value on the preview. <b>Draw box</b>:
                  drag a box over any area. <b>Add text</b>: click anywhere to place new text.
                  Each edit is applied at the same position in every PDF.
                </p>
              )}
            </div>

            {progress && (busy || results.length > 0) && (
              <div className="pk-progress">
                <div className="pk-bar">
                  <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
                <div className="pk-ptext">
                  <span>
                    {busy
                      ? `Processing ${progress.done} / ${progress.total}…`
                      : `Done ${progress.done} / ${progress.total}`}
                  </span>
                  <span>{Math.round((progress.done / progress.total) * 100)}%</span>
                </div>
              </div>
            )}

            <div className="pk-stack" style={{ marginTop: 14 }}>
              <button
                className="pk-btn pk-btn-primary"
                disabled={!files.length || !edits.length || busy}
                onClick={requestApply}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : lockOn ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <FileCheck2 className="h-4 w-4" />
                )}
                {busy && progress
                  ? `Applying… ${progress.done}/${progress.total}`
                  : `Apply edits to ${files.length} PDF${files.length === 1 ? '' : 's'}`}
              </button>
              <button
                className="pk-lock-row"
                onClick={() => setShowLockSettings(true)}
                data-testid="apply-lock-row"
              >
                {lockOn ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                <span>
                  {lockOn ? 'Voice password: ON' : 'Voice password: OFF'}
                  <small>{lockOn ? `Apply asks for ${lockAsk}` : 'Apply runs without asking'}</small>
                </span>
                <b>{lockOn ? 'Settings' : 'Set password'}</b>
              </button>
              {okResults.length >= 1 && (
                <button className="pk-btn pk-btn-soft" onClick={downloadZip}>
                  <Download className="h-4 w-4" /> Download all (.zip)
                </button>
              )}
            </div>

            {mismatches.length > 0 && (
              <div className="pk-warnbox">
                ⚠ <b>{mismatches[0].name}</b>
                {mismatches.length > 1 && (
                  <>
                    {' '}
                    and {mismatches.length - 1} more
                  </>
                )}{' '}
                {mismatches.length === 1 ? 'has' : 'have'} a different layout. Edits may land in
                the wrong place — check {mismatches.length === 1 ? 'it' : 'them'} in the preview.
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="pk-card" style={{ marginTop: 16 }}>
              <h2>
                Downloads{' '}
                <span className="pk-pill">
                  {okResults.length}/{results.length}
                </span>
              </h2>
              <div style={{ maxHeight: 260, overflow: 'auto' }}>
                {results.map((r) =>
                  r.bytes ? (
                    <div className="pk-result" key={r.fileId}>
                      <FileCheck2 className="h-4 w-4 shrink-0" style={{ color: 'var(--pk-ok)' }} />
                      <span className="truncate flex-1" title={r.name}>
                        {r.name}
                      </span>
                      <button className="pk-mini-btn" onClick={() => viewResult(r)}>
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </button>
                      <button className="pk-mini-btn" onClick={() => downloadBytes(r.bytes!, r.name)}>
                        <Download className="h-3.5 w-3.5" /> DL
                      </button>
                    </div>
                  ) : (
                    <div className="pk-result" key={r.fileId} style={{ borderColor: '#f3c2c2' }}>
                      <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                      <span className="truncate flex-1 text-red-600" title={r.error}>
                        {r.name} — failed
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      <footer className="pk-credit" data-testid="credit">
        <span>
          Created by <b>SAEMUR RAHMAN</b> — dedicated with personal time and money.
        </span>
        <span className="pk-credit-sub">Bismillah PDF Editor · Everything runs on this PC</span>
      </footer>

      <UnlockDialog
        open={showUnlock}
        onCancel={() => setShowUnlock(false)}
        onUnlocked={() => {
          setShowUnlock(false)
          void applyAll()
        }}
      />
      <LockSettingsDialog
        open={showLockSettings}
        onClose={() => setShowLockSettings(false)}
        onChanged={() => {
          setLockOn(appLock().status().enabled)
          setLockRev((r) => r + 1)
        }}
      />
    </div>
  )
}
