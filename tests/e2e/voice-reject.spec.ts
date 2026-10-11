import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { fixtures, micPlays, prepareBatch, setUpLock } from './voice-helpers'

micPlays(resolve(fixtures, 'hello.wav'))

test.describe('Bismillah ignores other speech', () => {
  test('saying something else does not unlock', async ({ page }) => {
    test.setTimeout(120_000)
    await setUpLock(page, { preset: 'bismillah' })
    await prepareBatch(page)
    await page.getByRole('button', { name: /Apply edits/ }).click()
    const dlg = page.getByTestId('unlock-dialog')
    await expect(dlg.getByRole('alert')).toHaveText(/Didn't hear “Bismillah”|Didn't catch that/, { timeout: 60_000 })
    await expect(dlg).toBeVisible()
    await expect(page.locator('.pk-result')).toHaveCount(0)
    // password still works
    await dlg.getByLabel('Password').fill('office-1234')
    await dlg.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByText('Done 3 / 3')).toBeVisible()
  })
})
