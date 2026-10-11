import { expect, test } from '@playwright/test'
import { addTextEdit, pdfText, upload } from './helpers'

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  ;(page as unknown as { _errors: string[] })._errors = errors
  await page.goto('/')
})

test('loads, accepts a batch and flags layout differences', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Bismillah PDF Editor' })).toBeVisible()
  await expect(page.getByTestId('credit')).toContainText('Created by SAEMUR RAHMAN')
  await expect(page).toHaveTitle('Bismillah PDF Editor')
  await upload(page)
  await expect(page.locator('.pk-file')).toHaveCount(3)
  await expect(page.getByText(/different layout/)).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()
})

test('add text once, apply to every PDF, download the edited file', async ({ page }) => {
  await upload(page)
  await addTextEdit(page, 'E2E STAMP 2026')
  await page.getByRole('button', { name: /Apply edits to 3 PDFs/ }).click()
  await expect(page.getByText('Done 3 / 3')).toBeVisible()
  await expect(page.locator('.pk-result')).toHaveCount(3)

  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.pk-result').first().getByRole('button', { name: 'DL' }).click(),
  ])
  expect(dl.suggestedFilename()).toBe('sample-invoice-edited.pdf')
  const path = await dl.path()
  expect(await pdfText(path)).toContain('E2E STAMP 2026')

  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Download all/ }).click(),
  ])
  expect(zip.suggestedFilename()).toBe('edited-pdfs.zip')
  expect((page as unknown as { _errors: string[] })._errors).toEqual([])
})

test('undo removes the last edit', async ({ page }) => {
  await upload(page)
  await addTextEdit(page, 'to be undone')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.pk-edit')).toHaveCount(0)
})
