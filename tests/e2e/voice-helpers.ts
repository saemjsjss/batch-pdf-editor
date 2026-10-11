import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addTextEdit, upload } from './helpers'

// Real offline speech recognition: Chromium's fake microphone loops a WAV file
// (synthetic espeak-ng voices) and the Vosk model in the page must recognise it.
export const fixtures = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')

export function micPlays(wav: string) {
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
}

export async function setUpLock(page: Page, voice: { preset: 'bismillah' } | { phrase: string }) {
  await page.goto('/')
  await page.getByRole('button', { name: /Lock settings/ }).click()
  const s = page.getByTestId('lock-settings')
  if (!(await s.getByLabel('Current password').count())) {
    await s.getByLabel('New password', { exact: true }).fill('office-1234')
    await s.getByLabel('Repeat new password').fill('office-1234')
    await s.getByRole('button', { name: 'Turn lock on' }).click()
  }
  await s.getByLabel('Current password').fill('office-1234')
  if ('preset' in voice) {
    await s.getByRole('button', { name: 'Use “Bismillah”' }).click()
    await expect(s.getByText('Voice unlock set: say “Bismillah”.')).toBeVisible()
  } else {
    await s.getByLabel('Voice passphrase').fill(voice.phrase)
    await s.getByRole('button', { name: /(Save|Replace) voice passphrase/ }).click()
    await expect(s.getByText('Voice passphrase saved.')).toBeVisible()
  }
  await page.keyboard.press('Escape')
}

export async function prepareBatch(page: Page) {
  await upload(page)
  await addTextEdit(page, 'voice edit')
}

