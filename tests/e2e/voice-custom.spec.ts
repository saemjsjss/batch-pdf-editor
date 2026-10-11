import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { fixtures, micPlays, prepareBatch, setUpLock } from './voice-helpers'

micPlays(resolve(fixtures, 'passphrase.wav')) // says "green apple seven"

test('custom English phrase: wrong phrase is rejected, right phrase unlocks', async ({ page }) => {
  test.setTimeout(120_000)
  await setUpLock(page, { phrase: 'blue river castle' })
  await prepareBatch(page)
  await page.getByRole('button', { name: /Apply edits/ }).click()
  const dlg = page.getByTestId('unlock-dialog')
  await expect(dlg.getByTestId('heard')).toContainText('green apple seven', { timeout: 60_000 })
  await expect(dlg.getByRole('alert')).toHaveText(/did not match/)
  await expect(page.locator('.pk-result')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Lock settings/ }).click()
  const s = page.getByTestId('lock-settings')
  await s.getByLabel('Voice passphrase').fill('Green apple, seven')
  await s.getByRole('button', { name: 'Replace voice passphrase' }).click()
  await expect(s.getByText('Voice passphrase saved.')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Apply edits/ }).click()
  await expect(dlg).toBeHidden({ timeout: 60_000 })
  await expect(page.getByText('Done 3 / 3')).toBeVisible()
})
