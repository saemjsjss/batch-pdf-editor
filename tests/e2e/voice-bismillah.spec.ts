import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { fixtures, micPlays, prepareBatch, setUpLock } from './voice-helpers'

micPlays(resolve(process.env.BISMILLAH_WAV || resolve(fixtures, 'bismillah.wav')))

test.describe('Bismillah unlocks and Apply continues', () => {
  test('say Bismillah → edits are applied', async ({ page }) => {
    test.setTimeout(120_000)
    await setUpLock(page, { preset: 'bismillah' })
    await prepareBatch(page)
    await page.getByRole('button', { name: /Apply edits/ }).click()
    const dlg = page.getByTestId('unlock-dialog')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByText(/Say “Bismillah” to apply the edits/)).toBeVisible()
    // no clicks: listening starts by itself, and apply continues once it hears the phrase
    await expect(dlg).toBeHidden({ timeout: 60_000 })
    await expect(page.getByText('Done 3 / 3')).toBeVisible()
  })
})
