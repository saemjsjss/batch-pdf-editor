import { expect, test, type Page } from '@playwright/test'
import { addTextEdit, unlockByTyping, upload } from './helpers'

const settings = async (page: Page) => {
  await page.getByRole('button', { name: /Lock settings/ }).click()
  return page.getByTestId('lock-settings')
}
const apply = (page: Page) => page.getByRole('button', { name: /Apply edits/ }).click()

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('out of the box, Apply asks for Bismillah — every time', async ({ page }) => {
  await expect(page.getByTestId('apply-lock-row')).toContainText('Voice password: ON')
  await expect(page.getByTestId('apply-lock-row')).toContainText('Apply asks for “Bismillah”')
  await upload(page)
  await addTextEdit(page, 'locked edit')

  await apply(page)
  const dlg = page.getByTestId('unlock-dialog')
  await expect(dlg.getByText('Say “Bismillah” to apply the edits.')).toBeVisible()
  await expect(page.locator('.pk-result')).toHaveCount(0)

  await unlockByTyping(page, 'hello')
  await expect(dlg.getByRole('alert')).toHaveText('That\'s not “Bismillah”.')
  await expect(page.locator('.pk-result')).toHaveCount(0)

  await unlockByTyping(page, 'Bismillah')
  await expect(dlg).toBeHidden()
  await expect(page.getByText('Done 3 / 3')).toBeVisible()

  // asks again on the next Apply
  await apply(page)
  await expect(page.getByTestId('unlock-dialog')).toBeVisible()
})

test('turning the lock off lets Apply run without asking', async ({ page }) => {
  const s = await settings(page)
  await s.getByRole('button', { name: 'Turn lock off' }).click()
  await expect(s.getByText('Lock turned off.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('apply-lock-row')).toContainText('Voice password: OFF')
  await upload(page)
  await addTextEdit(page, 'open')
  await apply(page)
  await expect(page.getByTestId('unlock-dialog')).toHaveCount(0)
  await expect(page.getByText('Done 3 / 3')).toBeVisible()

  await page.reload()
  const s2 = await settings(page)
  await s2.getByRole('button', { name: 'Turn lock on (Bismillah)' }).click()
  await expect(s2.getByText('Lock is on: say “Bismillah”.')).toBeVisible()
})

test('admin password protects settings, unlocks Apply, and is never stored in plain text', async ({ page }) => {
  const s = await settings(page)
  await s.getByLabel('New password', { exact: true }).fill('office-1234')
  await s.getByLabel('Repeat new password').fill('office-1234')
  await s.getByRole('button', { name: 'Set password' }).click()
  await expect(s.getByText(/Password set/)).toBeVisible()
  await expect(s.getByRole('button', { name: 'Turn lock off' })).toBeDisabled()
  await page.keyboard.press('Escape')

  const stored = await page.evaluate(() => JSON.stringify(window.localStorage))
  expect(stored).not.toContain('office-1234')

  await page.reload()
  await upload(page)
  await addTextEdit(page, 'pw edit')
  await apply(page)
  const dlg = page.getByTestId('unlock-dialog')
  await expect(dlg.getByText(/or enter the password/)).toBeVisible()
  await unlockByTyping(page, 'wrong')
  await expect(dlg.getByRole('alert')).toHaveText('Wrong password.')
  await unlockByTyping(page, 'office-1234')
  await expect(page.getByText('Done 3 / 3')).toBeVisible()
})

test('with a password, turning the lock off needs it', async ({ page }) => {
  const s = await settings(page)
  await s.getByLabel('New password', { exact: true }).fill('office-1234')
  await s.getByLabel('Repeat new password').fill('office-1234')
  await s.getByRole('button', { name: 'Set password' }).click()
  await s.getByLabel('Current password').fill('nope')
  await s.getByRole('button', { name: 'Turn lock off' }).click()
  await expect(s.getByRole('alert')).toContainText('wrong')
  await s.getByLabel('Current password').fill('office-1234')
  await s.getByRole('button', { name: 'Turn lock off' }).click()
  await expect(s.getByText('Lock turned off.')).toBeVisible()
  await expect(s.getByText(/Lock is OFF/)).toBeVisible()
})

test('the Apply panel opens the lock settings', async ({ page }) => {
  await page.getByTestId('apply-lock-row').click()
  await expect(page.getByTestId('lock-settings')).toBeVisible()
})
