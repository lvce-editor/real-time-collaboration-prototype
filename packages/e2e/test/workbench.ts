import { expect, type Page } from '@playwright/test'
export const snapshot = (page: Page) => page.evaluate(() => (globalThis as any).lvceCollaboration.snapshot())
export async function ready(page: Page) {
  await page.waitForFunction(() => !!(globalThis as any).lvceCollaboration)
}
export async function action(page: Page, id: string, args = {}) {
  await ready(page)
  await page.evaluate(({ id, args }) => (globalThis as any).lvceCollaboration.action(id, args), { id, args })
}
export const editor = (page: Page) => page.locator('.Editor:visible')
export async function joined(page: Page) {
  await ready(page)
  await expect.poll(async () => (await snapshot(page)).connected).toBe(true)
  await expect(editor(page).locator('textarea')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-collaboration-connected', 'true')
  await expect.poll(async () => (await snapshot(page)).log).toContain('Joined collaboration')
}
export async function append(page: Page, text: string) {
  await editor(page).locator('textarea').focus()
  await expect(editor(page).locator('textarea')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
  await expect.poll(async () => Object.values((await snapshot(page)).texts).some(value => String(value).includes(text))).toBe(true)
}
export async function openFile(page: Page, file: string) {
  await page.evaluate(async file => {
    const url = '/56b33a7/packages/renderer-process/dist/rendererProcessMain.js'
    const runtime = await import(url)
    await runtime.executeCommand('Collaboration.openFile', `memfs:///collaboration/${file}`)
  }, file)
  await expect(page.getByRole('tab').filter({ hasText: file.split('/').at(-1)! }).first()).toBeVisible()
  await expect(editor(page).locator('textarea')).toBeVisible()
}
export async function pair(browser: any) {
  const hc = await browser.newContext(), gc = await browser.newContext()
  const host = await hc.newPage(), guest = await gc.newPage()
  await host.goto('/'); await action(host, 'Host project', { name: 'Host' }); await joined(host)
  const invitation = (await snapshot(host)).invitation
  await guest.goto(invitation); await action(guest, 'Join project', { name: 'Guest' }); await joined(guest)
  return { host, guest, hc, gc, invitation, close: async () => { await gc.close(); await hc.close() } }
}
export async function grant(host: Page, guest: Page) {
  await action(guest, 'Request write access')
  const id = (await snapshot(guest)).self.id
  await expect.poll(async () => (await snapshot(host)).members.find((m: any) => m.id === id)?.requested).toBe(true)
  await action(host, 'Permission', { id, role: 'writer' })
  await expect(guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'false')
}
export async function revoke(host: Page, guest: Page) {
  await action(host, 'Permission', { id: (await snapshot(guest)).self.id, role: 'reader' })
}
export const documentText = (page: Page) => editor(page).locator('.EditorRow').evaluateAll(rows => rows.map(row => row.textContent).join('\n'))
