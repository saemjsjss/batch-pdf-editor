import { useEffect, useRef, useState } from 'react'
import { extractSpans, getPdfDoc, type TextSpan, type EditOp } from '@/lib/pdfEngine'

export interface RegionRect {
  /** user space (points, y = bottom edge) */
  x: number
  y: number
  w: number
  h: number
  fontSize: number
}

export type PreviewMode = 'click' | 'draw' | 'text' | 'place'

interface Props {
  fileId: string
  fileData: ArrayBuffer
  page: number
  scale: number
  mode: PreviewMode
  edits: EditOp[]
  /** result-preview mode: render only, no selection/drawing */
  readonly?: boolean
  /** pending edit rect — shown as a dashed pink box; draggable/resizable in draw/place mode */
  pendingRect?: RegionRect | null
  /** place mode: click point in user space (center of the square to place) */
  onPlacePoint?: (cx: number, cy: number) => void
  /** draw/place mode: pending box moved or resized (user space, y = bottom edge) */
  onPendingMove?: (rect: { x: number; y: number; w: number; h: number }) => void
  /** dragging a committed edit box on the page */
  onEditDragStart?: () => void
  onEditMove?: (id: string, pos: { x: number; y: number }) => void
  onEditDragEnd?: () => void
  onLineClick: (rect: RegionRect, text: string) => void
  onRegionDrawn: (rect: RegionRect) => void
  /** click point in user space (baseline-left of the new text) */
  onTextPoint: (x: number, baselineY: number) => void
}

/**
 * Select the contiguous text run containing the clicked span: same baseline,
 * merging fragments only while the horizontal gap stays small (word spacing).
 * Distant columns (label vs value) are NOT merged into one selection.
 */
function runOf(spans: TextSpan[], clicked: TextSpan): { rect: RegionRect; text: string } {
  const tol = clicked.size * 0.6
  const row = spans
    .filter((s) => Math.abs(s.baselineY - clicked.baselineY) <= tol)
    .sort((a, b) => a.x - b.x)
  const idx = row.findIndex((s) => s.id === clicked.id)
  if (idx === -1) {
    return {
      rect: {
        x: clicked.x - clicked.size * 0.06,
        y: clicked.baselineY - clicked.size * 0.24,
        w: clicked.w + clicked.size * 0.12,
        h: clicked.size * 1.2,
        fontSize: clicked.size,
      },
      text: clicked.str,
    }
  }
  const gapLimit = clicked.size * 0.6
  let lo = idx
  let hi = idx
  while (lo > 0 && row[lo].x - (row[lo - 1].x + row[lo - 1].w) < gapLimit) lo--
  while (hi < row.length - 1 && row[hi + 1].x - (row[hi].x + row[hi].w) < gapLimit) hi++
  const run = row.slice(lo, hi + 1)
  let text = ''
  let prevEnd: number | null = null
  for (const s of run) {
    if (prevEnd !== null && s.x - prevEnd > s.size * 0.25) text += ' '
    text += s.str
    prevEnd = s.x + s.w
  }
  const x0 = Math.min(...run.map((s) => s.x))
  const x1 = Math.max(...run.map((s) => s.x + s.w))
  const size = Math.max(...run.map((s) => s.size))
  const baseline = clicked.baselineY
  return {
    rect: {
      x: x0 - size * 0.06,
      y: baseline - size * 0.24,
      w: x1 - x0 + size * 0.12,
      h: size * 1.2,
      fontSize: size,
    },
    text,
  }
}

export default function PdfPreview({
  fileId,
  fileData,
  page,
  scale,
  mode,
  edits,
  readonly = false,
  pendingRect = null,
  onPlacePoint,
  onPendingMove,
  onEditDragStart,
  onEditMove,
  onEditDragEnd,
  onLineClick,
  onRegionDrawn,
  onTextPoint,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [spans, setSpans] = useState<TextSpan[]>([])
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [pageH, setPageH] = useState(0)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let stage = 'start'
    let renderTask: import('pdfjs-dist').RenderTask | null = null
    setLoading(true)
    setError(null)
    const watchdog = setTimeout(() => {
      if (!cancelled)
        setError(`Still busy at step "${stage}" after 10s — likely a worker/communication hang.`)
    }, 10_000)
    ;(async () => {
      try {
        stage = 'open document'
        const doc = await getPdfDoc(fileId, fileData)
        if (cancelled) return
        stage = 'get page'
        const pg = await doc.getPage(page)
        const viewport = pg.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!
        stage = 'render page'
        renderTask = pg.render({ canvas, canvasContext: ctx, viewport })
        await renderTask.promise
        if (cancelled) return
        stage = 'extract text'
        const r = await extractSpans(doc, page, scale)
        if (cancelled) return
        setSpans(r.spans)
        setDims({ w: r.viewportW, h: r.viewportH })
        setPageH(r.pageH)
        stage = 'done'
      } catch (err) {
        if (!cancelled) setError(`Step "${stage}": ${String((err as Error)?.message || err)}`)
      } finally {
        clearTimeout(watchdog)
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(watchdog)
      try {
        renderTask?.cancel()
      } catch {
        /* already finished */
      }
    }
  }, [fileId, fileData, page, scale])

  const localPos = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (readonly || mode !== 'draw') return
    const p = localPos(e)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = localPos(e)
    setDrag({ ...drag, x1: p.x, y1: p.y })
  }
  const onPointerUp = () => {
    if (!drag) return
    const left = Math.min(drag.x0, drag.x1)
    const top = Math.min(drag.y0, drag.y1)
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    setDrag(null)
    if (w < 6 || h < 6) return
    // px -> user space
    const ux = left / scale
    const uyTop = top / scale
    const uw = w / scale
    const uh = h / scale
    onRegionDrawn({
      x: ux,
      y: pageH - uyTop - uh,
      w: uw,
      h: uh,
      fontSize: Math.max(6, uh * 0.6),
    })
  }

  const onOverlayClick = (e: React.MouseEvent) => {
    if (readonly) return
    const p = localPos(e)
    if (mode === 'text') {
      // clicked point = baseline-left of the text to add
      onTextPoint(p.x / scale, pageH - p.y / scale)
    } else if (mode === 'place') {
      if (suppressPlaceClick.current) {
        suppressPlaceClick.current = false
        return
      }
      // clicked point = center of the square to place
      onPlacePoint?.(p.x / scale, pageH - p.y / scale)
    }
  }

  /** dragging state: move/resize the pending box, or move a committed edit box */
  const boxMoveRef = useRef<{
    kind: 'move' | 'resize' | 'edit'
    px: number
    py: number
    rect: { x: number; y: number; w: number; h: number }
    editId?: string
  } | null>(null)
  const suppressPlaceClick = useRef(false)

  const boxInteractive = mode === 'place' || mode === 'draw'

  const onBoxPointerDown = (e: React.PointerEvent, kind: 'move' | 'resize') => {
    if (readonly || !boxInteractive || !pendingRect) return
    e.stopPropagation()
    e.preventDefault()
    const p = localPos(e)
    boxMoveRef.current = {
      kind,
      px: p.x,
      py: p.y,
      rect: { x: pendingRect.x, y: pendingRect.y, w: pendingRect.w, h: pendingRect.h },
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onEditPointerDown = (e: React.PointerEvent, edit: EditOp) => {
    if (readonly) return
    e.stopPropagation()
    e.preventDefault()
    const p = localPos(e)
    boxMoveRef.current = {
      kind: 'edit',
      px: p.x,
      py: p.y,
      rect: { x: edit.x, y: edit.y, w: edit.w, h: edit.h },
      editId: edit.id,
    }
    onEditDragStart?.()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onBoxPointerMove = (e: React.PointerEvent) => {
    const m = boxMoveRef.current
    if (!m) return
    const p = localPos(e)
    const dx = (p.x - m.px) / scale
    const dy = (p.y - m.py) / scale
    if (Math.abs(p.x - m.px) + Math.abs(p.y - m.py) > 3) suppressPlaceClick.current = true
    if (m.kind === 'edit') {
      if (m.editId) onEditMove?.(m.editId, { x: m.rect.x + dx, y: m.rect.y - dy })
      return
    }
    if (!pendingRect) return
    if (m.kind === 'move') {
      onPendingMove?.({ ...m.rect, x: m.rect.x + dx, y: m.rect.y - dy })
    } else {
      // corner resize: top-left edge stays, box grows toward the dragged corner
      const w = Math.max(10, m.rect.w + dx)
      const h = Math.max(10, m.rect.h + dy)
      onPendingMove?.({ x: m.rect.x, y: m.rect.y - (h - m.rect.h), w, h })
    }
  }
  const onBoxPointerUp = (e: React.PointerEvent) => {
    const m = boxMoveRef.current
    if (!m) return
    boxMoveRef.current = null
    if (m.kind === 'edit') onEditDragEnd?.()
    e.stopPropagation()
  }

  const pageEdits = edits.filter((e) => e.page === page)

  return (
    <div className="inline-block relative bg-white shadow-md" ref={wrapRef}>
      <canvas ref={canvasRef} className="block" />
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm text-muted-foreground">
          Rendering…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-6 text-sm text-red-600 text-center">
          Preview failed: {error}
        </div>
      )}
      {/* overlay layer */}
      <div
        className={`absolute inset-0 ${
          mode === 'draw'
            ? 'cursor-crosshair'
            : mode === 'text'
              ? 'cursor-text'
              : mode === 'place'
                ? 'cursor-cell'
                : ''
        }`}
        style={{ width: dims.w, height: dims.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onOverlayClick}
      >
        {!readonly &&
          mode === 'click' &&
          spans.map((s) => (
            <button
              key={s.id}
              title={s.str}
              onClick={() => {
                const { rect, text } = runOf(spans, s)
                onLineClick(rect, text)
              }}
              className="absolute rounded-[2px] transition-colors hover:bg-blue-400/30 hover:outline hover:outline-1 hover:outline-blue-500"
              style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
            />
          ))}
        {!readonly && pendingRect && (
          <div
            className={`absolute border-2 border-dashed ${boxInteractive ? 'cursor-move' : ''}`}
            style={{
              left: pendingRect.x * scale,
              top: (pageH - pendingRect.y - pendingRect.h) * scale,
              width: Math.min(pendingRect.w, 2000) * scale,
              height: pendingRect.h * scale,
              borderColor: '#E84A8A',
              background: 'rgba(232,74,138,0.15)',
              touchAction: 'none',
              pointerEvents: boxInteractive ? 'auto' : 'none',
              zIndex: 10,
            }}
            title={boxInteractive ? 'Drag to move · corner handle to resize' : undefined}
            onPointerDown={(e) => onBoxPointerDown(e, 'move')}
            onPointerMove={onBoxPointerMove}
            onPointerUp={onBoxPointerUp}
            onClick={(e) => e.stopPropagation()}
          >
            {boxInteractive && (
              <div
                style={{
                  position: 'absolute',
                  right: -6,
                  bottom: -6,
                  width: 12,
                  height: 12,
                  background: '#E84A8A',
                  borderRadius: 3,
                  border: '2px solid #fff',
                  cursor: 'nwse-resize',
                }}
                title="Drag to resize"
                onPointerDown={(e) => onBoxPointerDown(e, 'resize')}
                onPointerMove={onBoxPointerMove}
                onPointerUp={onBoxPointerUp}
              />
            )}
          </div>
        )}
        {pageEdits.map((e) => (
          <div
            key={e.id}
            className={`absolute border-2 flex items-center justify-center overflow-hidden ${
              readonly ? 'pointer-events-none' : 'cursor-move'
            } ${
              e.cover
                ? 'border-amber-500 bg-amber-400/25'
                : 'border-green-600 border-dashed bg-green-400/10'
            }`}
            style={{
              left: e.x * scale,
              top: (pageH - e.y - e.h) * scale,
              width: Math.min(e.w, 400) * scale,
              height: e.h * scale,
              touchAction: 'none',
              zIndex: 5,
            }}
            title={readonly ? undefined : 'Drag to move this edit'}
            onPointerDown={(ev) => onEditPointerDown(ev, e)}
            onPointerMove={onBoxPointerMove}
            onPointerUp={onBoxPointerUp}
            onClick={(ev) => ev.stopPropagation()}
          >
            <span
              className="text-[10px] text-amber-900 truncate px-0.5"
              style={{ fontWeight: e.bold ? 700 : 500 }}
            >
              {e.newText || (e.cover ? '(blank)' : '')}
            </span>
          </div>
        ))}
        {drag && (
          <div
            className="absolute border-2 border-dashed border-blue-600 bg-blue-400/20 pointer-events-none"
            style={{
              left: Math.min(drag.x0, drag.x1),
              top: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
            }}
          />
        )}
      </div>
    </div>
  )
}
