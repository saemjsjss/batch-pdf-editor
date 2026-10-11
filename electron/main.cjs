// Bismillah PDF Editor — Windows desktop shell (staff edition).
// Serves the built app from app://local/ (a secure, standard scheme so the
// microphone, module workers and localStorage behave like a normal website),
// with no menu bar and no developer tools.
const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SCHEME = 'app'
const HOST = 'local'
const ROOT = path.join(__dirname, '..', 'dist-staff')

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win = null

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    protocol.handle(SCHEME, (req) => {
      const url = new URL(req.url)
      let rel = decodeURIComponent(url.pathname)
      if (rel === '/' || rel === '') rel = '/index.html'
      const file = path.normalize(path.join(ROOT, rel))
      if (!file.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 })
      if (req.method === 'HEAD') {
        try {
          const { size } = fs.statSync(file)
          return new Response(null, { status: 200, headers: { 'content-length': String(size) } })
        } catch {
          return new Response(null, { status: 404 })
        }
      }
      return net.fetch(pathToFileURL(file).toString())
    })

    // only the microphone, only for our own pages
    const ours = (u) => typeof u === 'string' && u.startsWith(`${SCHEME}://${HOST}/`)
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      const audioOnly = permission === 'media' && !(details.mediaTypes || []).includes('video')
      cb(audioOnly && ours(details.requestingUrl || wc.getURL()))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
      permission === 'media' && ours(`${origin}/`),
    )

    Menu.setApplicationMenu(null)
    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1000,
      minHeight: 640,
      title: 'Bismillah PDF Editor',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      backgroundColor: '#fdf2f6',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
        spellcheck: false,
      },
    })
    win.once('ready-to-show', () => {
      win.maximize()
      win.show()
    })
    // links to the outside world open in the normal browser, never inside the app
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (!ours(url)) e.preventDefault()
    })
    win.loadURL(`${SCHEME}://${HOST}/`)
  })

  app.on('window-all-closed', () => app.quit())
}
