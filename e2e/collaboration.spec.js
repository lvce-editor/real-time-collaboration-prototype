import { test, expect } from '@playwright/test'
async function pair(browser) {
  const hc = await browser.newContext(), gc = await browser.newContext()
  const host = await hc.newPage(), guest = await gc.newPage()
  await host.goto('/'); await host.getByLabel('Your name').fill('Host'); await host.getByRole('button', { name: 'Host project', exact: true }).click()
  await expect(host.locator('#connection')).toHaveText('Connected')
  const invitation = await host.getByLabel('Invite link').inputValue()
  await guest.goto(invitation); await guest.getByLabel('Your name').fill('Guest'); await guest.getByRole('button', { name: 'Join project' }).click()
  await expect(guest.locator('#connection')).toHaveText('Connected')
  return { host, guest, hc, gc, invitation, close: async () => { await gc.close(); await hc.close() } }
}
async function grant(host, guest) {
  await guest.getByRole('button', { name: 'Request write access' }).click()
  await expect(host.locator('#members')).toContainText('requests write access')
  await host.getByRole('button', { name: 'Allow Guest' }).click()
  await expect(guest.locator('#permission')).toHaveText('Write access')
}
const editor = page => page.locator('.cm-content')
async function append(page, text) { await editor(page).click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text) }

test('invitations, read-only guest, approval, propagation and revocation', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await expect(editor(p.guest)).toHaveAttribute('contenteditable', 'false')
    await grant(p.host, p.guest)
    await append(p.guest, 'Guest contribution')
    await expect(editor(p.host)).toContainText('Guest contribution')
    await p.host.getByRole('button', { name: 'Revoke Guest' }).click()
    await expect(editor(p.guest)).toHaveAttribute('contenteditable', 'false')
  } finally { await p.close() }
})
test('concurrent editors keep both contributions and converge', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await Promise.all([append(p.host, 'HOST'), append(p.guest, 'GUEST')])
    await expect(editor(p.host)).toContainText('HOST'); await expect(editor(p.host)).toContainText('GUEST')
    const documentText = page => editor(page).evaluate(element => {
      const copy = element.cloneNode(true)
      copy.querySelectorAll('.remote-cursor').forEach(cursor => cursor.remove())
      return [...copy.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')
    })
    await expect.poll(async () => (await documentText(p.host)) === (await documentText(p.guest))).toBe(true)
  } finally { await p.close() }
})
test('project files remain separate and synchronize to a late joiner', async ({ browser }) => {
  const p = await pair(browser)
  const lateContext = await browser.newContext()
  try {
    await p.host.getByRole('button', { name: 'src/main.js', exact: true }).click()
    await append(p.host, '\n// shared code')
    const late = await lateContext.newPage(); await late.goto(p.invitation); await late.getByRole('button', { name: 'Join project' }).click()
    await late.getByRole('button', { name: 'src/main.js', exact: true }).click()
    await expect(editor(late)).toContainText('// shared code')
    await expect(editor(p.guest)).not.toContainText('// shared code')
  } finally { await lateContext.close(); await p.close() }
})
test('colored participant cursors follow edits and disappear on departure', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await editor(p.guest).click(); await p.guest.keyboard.press('ControlOrMeta+End')
    await expect(p.host.locator('.remote-cursor-label')).toHaveText('Guest')
    await append(p.host, 'prefix')
    await expect(p.host.locator('.remote-cursor')).toHaveCount(1)
    await p.guest.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(p.host.locator('.remote-cursor')).toHaveCount(0)
  } finally { await p.close() }
})
test('reload reconnects with retained writer identity and project', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest); await append(p.guest, 'Retained edit')
    await expect(editor(p.host)).toContainText('Retained edit')
    await p.guest.reload()
    await expect(p.guest.locator('#connection')).toHaveText('Connected')
    await expect(p.guest.locator('#permission')).toHaveText('Write access')
    await expect(editor(p.guest)).toContainText('Retained edit')
    await expect(p.host.locator('#members .member')).toHaveCount(2)
  } finally { await p.close() }
})
test('transport reconnect disables edits while offline and catches up', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await p.gc.setOffline(true)
    await expect(p.guest.locator('#permission')).toContainText('Disconnected', { timeout: 10_000 })
    await append(p.host, 'While away')
    await p.gc.setOffline(false)
    await expect(p.guest.locator('#connection')).toHaveText('Connected')
    await expect(editor(p.guest)).toContainText('While away')
  } finally { await p.gc.setOffline(false); await p.close() }
})
test('output channel verbosity changes observable logging and persists', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await p.host.getByLabel('Log verbosity').selectOption('off'); await p.host.getByRole('button', { name: 'Clear output' }).click()
    await append(p.host, 'quiet'); await expect(editor(p.guest)).toContainText('quiet')
    await expect(p.host.getByRole('log')).toBeEmpty()
    await p.host.getByLabel('Log verbosity').selectOption('trace')
    await append(p.host, 'verbose')
    await expect(p.host.getByRole('log')).toContainText('send update')
    await expect(p.host.getByRole('log')).toContainText('receive ack')
    await p.host.reload(); await expect(p.host.getByLabel('Log verbosity')).toHaveValue('trace')
  } finally { await p.close() }
})
test('invalid invitation produces actionable error', async ({ page }) => {
  await page.goto('/#does-not-exist'); await page.getByRole('button', { name: 'Join project' }).click()
  await expect(page.getByRole('alert')).toContainText('Session unavailable or expired')
})
test('host imports a text folder and downloads its edited contents', async ({ page }) => {
  const { fileURLToPath } = await import('node:url')
  const { readFile } = await import('node:fs/promises')
  await page.goto('/')
  await page.locator('#folder').setInputFiles(fileURLToPath(new URL('./fixtures/project', import.meta.url)))
  await page.getByRole('button', { name: 'Host project', exact: true }).click()
  await page.getByRole('button', { name: 'src/hello.js', exact: true }).click()
  await expect(editor(page)).toContainText('Shared folder')
  await append(page, '// downloaded')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download file' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('hello.js')
  expect(await readFile(await download.path(), 'utf8')).toContain('// downloaded')
})
