# Batch PDF Editor - tiny local web server (no install needed).
# Serves the built app from ..\dist on http://localhost:5199 and opens your browser.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist'))
$rootPrefix = $root.TrimEnd('\') + '\'
$port = 5199
$url = "http://localhost:$port/"

if (-not (Test-Path (Join-Path $root 'index.html'))) {
  Write-Host "App files not found in $root" -ForegroundColor Red
  Read-Host 'Press Enter to close'; exit 1
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() } catch {
  # Already running (or port busy) - just open it.
  Start-Process $url; exit 0
}

$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8'
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'
  '.jpg'='image/jpeg'; '.ico'='image/x-icon'; '.ttf'='font/ttf'; '.woff'='font/woff'; '.woff2'='font/woff2'
  '.wasm'='application/wasm'; '.pdf'='application/pdf'; '.map'='application/json'
}

Write-Host ''
Write-Host '  Batch PDF Editor is running' -ForegroundColor Magenta
Write-Host "  Open: $url"
Write-Host '  Keep this window open while you work. Close it to stop the app.'
Write-Host ''
Start-Process $url

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/').Replace('/', '\')
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $res.StatusCode = 404; $b = [Text.Encoding]::UTF8.GetBytes('Not found')
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $res.Headers['Cache-Control'] = 'no-cache'
      $b = [IO.File]::ReadAllBytes($full)
    }
    $res.ContentLength64 = $b.Length
    if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($b, 0, $b.Length) }
  } catch { } finally { try { $res.OutputStream.Close() } catch { } }
}
