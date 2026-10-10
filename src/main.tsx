import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

// Some embedded browsers throttle requestAnimationFrame for unfocused panels,
// which permanently stalls pdf.js canvas rendering. Detect a dead rAF and
// fall back to timer-based scheduling so rendering always progresses.
let rafFired = false
window.requestAnimationFrame(() => {
  rafFired = true
})
setTimeout(() => {
  if (!rafFired) {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(performance.now()), 16)) as typeof window.requestAnimationFrame
    window.cancelAnimationFrame = ((id: number) =>
      window.clearTimeout(id)) as typeof window.cancelAnimationFrame
  }
}, 500)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
