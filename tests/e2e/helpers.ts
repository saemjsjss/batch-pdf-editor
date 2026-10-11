import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const samples = ['sample-invoice.pdf', 'sample-letter.pdf', 'sample-korean.pdf'].map((f) => resolve(root, f))

export async function upload(page: Page, files = samples) {
  await page.locator('input[type=file]').setInputFiles(files)
  await expect(page.getByText(`Apply edits to ${files.length} PDF`)).toBeVisible()
}

/** Add-text tool: click on the page preview, type, commit. */
export async function addTextEdit(page: Page, text: string, at = { x: 120, y: 420 }) {
  await page.getByRole('button', { name: 'Add text' }).click()
  const overlay = page.locator('.cursor-text').first()
  await expect(overlay).toBeVisible()
  await overlay.click({ position: at })
  await page.getByPlaceholder(/New text/).fill(text)
  await page.getByRole('button', { name: 'Add edit' }).click()
  await expect(page.locator('.pk-edit')).toHaveCount(1)
}

export async function pdfText(path: string): Promise<string> {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 })
  const doc = await task.promise
  const parts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent()
    for (const it of tc.items) if ('str' in it) parts.push(it.str)
  }
  await task.destroy()
  return parts.join(' ')
}

/** Unlock dialog without a microphone: type the voice word (or the password). */
export async function unlockByTyping(page: Page, text = 'Bismillah') {
  const dlg = page.getByTestId('unlock-dialog')
  await expect(dlg).toBeVisible()
  const box = dlg.getByLabel(/Type the phrase|Password/)
  await box.fill(text)
  await dlg.getByRole('button', { name: 'Unlock', exact: true }).click()
}
