import { expect, test, type Page } from '@playwright/test'
import { addTextEdit, upload } from './helpers'

async function turnLockOn(page: Page, pw: string) {
  await page.getByRole('button', { name: /Lock settings/ }).click()
  const dlg = page.getByTestId('lock-settings')
  await dlg.getByLabel('New password', { exact: true }).fill(pw)
  await dlg.getByLabel('Repeat new password').fill(pw)
  await dlg.getByRole('button', { name: 'Turn lock on' }).click()
  await expect(dlg.getByText(/Lock is on/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Lock settings (lock on)' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('apply is free when no lock is set', async ({ page }) => {
  await upload(page)
  await addTextEdit(page, 'open')
  await page.getByRole('button', { name: /Apply edits/ }).click()
  await expect(page.getByTestId('unlock-dialog')).toHaveCount(0)
  await expect(page.getByText('Done 3 / 3')).toBeVisible()
})

test('password lock blocks apply until the right password is given', async ({ page }) => {
  await turnLockOn(page, 'office-1234')
  await upload(page)
  await addTextEdit(page, 'locked edit')

  await page.getByRole('button', { name: /Apply edits/ }).click()
  const dlg = page.getByTestId('unlock-dialog')
  await expect(dlg).toBeVisible()
  await expect(page.locator('.pk-result')).toHaveCount(0)

  await dlg.getByLabel('Password').fill('wrong')
  await dlg.getByRole('button', { name: 'Unlock' }).click()
  await expect(dlg.getByRole('alert')).toHaveText('Wrong password.')
  await expect(page.locator('.pk-result')).toHaveCount(0)

  await dlg.getByLabel('Password').fill('office-1234')
  await dlg.getByRole('button', { name: 'Unlock' }).click()
  await expect(dlg).toBeHidden()
  await expect(page.getByText('Done 3 / 3')).toBeVisible()

  // stays unlocked for a few minutes, "Lock now" re-locks
  await expect(page.getByText('Unlocked for 5 minutes')).toBeVisible()
  await page.getByRole('button', { name: /Apply edits/ }).click()
  await expect(dlg).toHaveCount(0)
  await page.getByRole('button', { name: 'Lock now' }).click()
  await page.getByRole('button', { name: /Apply edits/ }).click()
  await expect(page.getByTestId('unlock-dialog')).toBeVisible()
})

test('lock survives a reload and the password is not stored in plain text', async ({ page }) => {
  await turnLockOn(page, 'super-secret-99')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Lock settings (lock on)' })).toBeVisible()
  const stored = await page.evaluate(() => JSON.stringify(window.localStorage))
  expect(stored).not.toContain('super-secret-99')
})

test('voice passphrase can be set and offers voice unlock', async ({ page }) => {
  await turnLockOn(page, 'office-1234')
  await page.getByRole('button', { name: /Lock settings/ }).click()
  const s = page.getByTestId('lock-settings')
  await s.getByLabel('Current password').fill('office-1234')
  await s.getByLabel('Voice passphrase').fill('pink lotus morning')
  await s.getByRole('button', { name: 'Save voice passphrase' }).click()
  await expect(s.getByText('Voice passphrase saved.')).toBeVisible()
  await expect(s.getByText(/voice unlock on/)).toBeVisible()
  await page.keyboard.press('Escape')

  await upload(page)
  await addTextEdit(page, 'voice edit')
  await page.getByRole('button', { name: /Apply edits/ }).click()
  const voiceBtn = page.getByTestId('unlock-dialog').getByRole('button', { name: 'Unlock with voice' })
  await expect(voiceBtn).toBeVisible()
  await expect(voiceBtn).toBeEnabled() // model is installed by `npm run get-voice-model`
})

test('removing the lock needs the current password', async ({ page }) => {
  await turnLockOn(page, 'office-1234')
  await page.getByRole('button', { name: /Lock settings/ }).click()
  const s = page.getByTestId('lock-settings')
  await s.getByLabel('Current password').fill('nope')
  await s.getByRole('button', { name: 'Remove lock' }).click()
  await expect(s.getByRole('alert')).toContainText('wrong')
  await s.getByLabel('Current password').fill('office-1234')
  await s.getByRole('button', { name: 'Remove lock' }).click()
  await expect(s.getByText('Lock removed.')).toBeVisible()
  await expect(s.getByText(/Lock is OFF/)).toBeVisible()
})
