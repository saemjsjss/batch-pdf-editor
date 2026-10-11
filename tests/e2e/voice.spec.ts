import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addTextEdit, upload } from './helpers'

// Real offline speech recognition: Chromium's fake microphone plays a recorded (espeak-ng)
// "green apple seven" and the Vosk model in the page must recognise it.
const wav = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/passphrase.wav')

test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
  },
  permissions: ['microphone'],
})

test('spoken passphrase unlocks apply; a wrong phrase does not', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/')
  // set password + voice phrase
  await page.getByRole('button', { name: /Lock settings/ }).click()
  const s = page.getByTestId('lock-settings')
  await s.getByLabel('New password', { exact: true }).fill('office-1234')
  await s.getByLabel('Repeat new password').fill('office-1234')
  await s.getByRole('button', { name: 'Turn lock on' }).click()
  await s.getByLabel('Current password').fill('office-1234')
  await s.getByLabel('Voice passphrase').fill('blue river castle') // wrong phrase first
  await s.getByRole('button', { name: 'Save voice passphrase' }).click()
  await expect(s.getByText('Voice passphrase saved.')).toBeVisible()
  await page.keyboard.press('Escape')

  await upload(page)
  await addTextEdit(page, 'voice edit')
  await page.getByRole('button', { name: /Apply edits/ }).click()
  const dlg = page.getByTestId('unlock-dialog')
  await dlg.getByRole('button', { name: 'Unlock with voice' }).click()
  await expect(dlg.getByTestId('heard')).toContainText('green apple seven', { timeout: 60_000 })
  await expect(dlg.getByRole('alert')).toHaveText(/did not match|Didn't catch/)
  await expect(page.locator('.pk-result')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // now set the phrase the "speaker" actually says
  await page.getByRole('button', { name: /Lock settings/ }).click()
  await s.getByLabel('Current password').fill('office-1234')
  await s.getByLabel('Voice passphrase').fill('Green apple, seven')
  await s.getByRole('button', { name: 'Replace voice passphrase' }).click()
  await expect(s.getByText('Voice passphrase saved.')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Apply edits/ }).click()
  await dlg.getByRole('button', { name: 'Unlock with voice' }).click()
  await expect(dlg).toBeHidden({ timeout: 60_000 })
  await expect(page.getByText('Done 3 / 3')).toBeVisible()
})
