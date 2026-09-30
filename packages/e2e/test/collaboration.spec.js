import { test, expect } from '@playwright/test'
import { mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
const editor = page => page.locator('#editor')
async function append(page, text) { await expect(editor(page)).toHaveAttribute('data-ready', 'true'); await editor(page).click(); await expect(page.getByRole('textbox', { name: 'LVCE editor input' })).toBeFocused(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text) }

test('invitations, read-only guest, approval, propagation and revocation', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await expect(editor(p.guest)).toHaveAttribute('data-readonly', 'true')
    await grant(p.host, p.guest)
    await append(p.guest, 'Guest contribution')
    await expect(editor(p.host)).toContainText('Guest contribution')
    await p.host.getByRole('button', { name: 'Revoke Guest' }).click()
    await expect(editor(p.guest)).toHaveAttribute('data-readonly', 'true')
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
      return [...copy.querySelectorAll('.EditorRow')].map(line => line.textContent).join('\n')
    })
    await expect.poll(async () => (await documentText(p.host)) === (await documentText(p.guest))).toBe(true)
  } finally { await p.close() }
})
test('published collaboration demo shows shared edits and a remote cursor', async ({ browser }) => {
  const videoDir = process.env.DEMO_VIDEO_DIR
  if (videoDir) await mkdir(videoDir, { recursive: true })
  const hostContext = await browser.newContext(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {})
  const guestContext = await browser.newContext(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {})
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  let hostVideo
  try {
    await host.goto('/')
    await host.getByLabel('Your name').fill('Host')
    await host.getByRole('button', { name: 'Host project', exact: true }).click()
    await expect(host.locator('#connection')).toHaveText('Connected')
    const invitation = await host.getByLabel('Invite link').inputValue()
    await guest.goto(invitation)
    await guest.getByLabel('Your name').fill('Guest')
    await guest.getByRole('button', { name: 'Join project' }).click()
    await expect(guest.locator('#connection')).toHaveText('Connected')
    await grant(host, guest)
    await append(host, 'Hello from the host. ')
    await append(guest, 'The guest is editing too.')
    await expect(editor(host)).toContainText('The guest is editing too.')
    await editor(guest).click()
    await guest.keyboard.press('ControlOrMeta+End')
    await expect(host.locator('.remote-cursor-label')).toHaveText('Guest')
    await expect(host.locator('.remote-cursor')).toBeVisible()
    if (videoDir) hostVideo = host.video()
  } finally {
    await guestContext.close()
    await hostContext.close()
  }
  if (videoDir && hostVideo) await copyFile(await hostVideo.path(), resolve(videoDir, 'collaboration-demo.webm'))
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

test('native selection deletion converges with a concurrent insert', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await editor(p.guest).click()
    await expect(p.guest.getByRole('textbox', { name: 'LVCE editor input' })).toBeFocused()
    await p.guest.keyboard.press('ControlOrMeta+Home')
    await p.guest.keyboard.press('Shift+ArrowRight')
    await p.guest.keyboard.press('Shift+ArrowRight')
    await expect(p.host.locator('.remote-selection').first()).toHaveCSS('width', /[1-9]/)
    await Promise.all([p.guest.keyboard.press('Backspace'), append(p.host, 'CONCURRENT')])
    await expect(editor(p.host)).toContainText('CONCURRENT')
    await expect(editor(p.guest)).toContainText('CONCURRENT')
    await expect(p.host.locator('.EditorRow').first()).toHaveText('Shared project')
    await expect(p.guest.locator('.EditorRow').first()).toHaveText('Shared project')
  } finally { await p.close() }
})

test('file switches dispose native workers and retain one editable view', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Host project', exact: true }).click()
  await expect(editor(page)).toHaveAttribute('data-ready', 'true')
  const sheets = await page.evaluate(() => document.adoptedStyleSheets.length)
  for (let i = 0; i < 4; i++) {
    const file = i % 2 === 0 ? 'src/main.js' : 'README.md'
    await page.getByRole('button', { name: file, exact: true }).click()
    await expect(page.locator('#filename')).toHaveText(file)
    await expect(editor(page)).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('.Editor')).toHaveCount(1)
    await expect.poll(() => page.workers().length).toBe(3)
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(sheets)
  }
  await append(page, 'after switching')
  await expect(editor(page)).toContainText('after switching')
  await expect(page.getByRole('log')).not.toContainText('Editor error')
})

test('rejected native edits are discarded on authoritative reconnect', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    const transport = p.guest.workers().find(worker => worker.url().endsWith('/transport-worker.js'))
    // Delay the revocation notification to reproduce a real in-flight write:
    // the server has revoked access while this client still believes it can edit.
    await transport.evaluate(() => {
      const post = globalThis.postMessage.bind(globalThis)
      globalThis.postMessage = data => {
        if (data.type === 'message' && data.message.type === 'member' && data.message.member.role === 'reader') return
        post(data)
      }
    })
    await p.host.getByRole('button', { name: 'Revoke Guest' }).click()
    await expect(p.host.getByRole('button', { name: 'Allow Guest' })).toBeVisible()
    await append(p.guest, 'REJECTED')
    await expect(p.guest.getByRole('log')).toContainText('Reconnected to authority')
    await expect(editor(p.guest)).toHaveAttribute('data-ready', 'true')
    await expect(editor(p.guest)).not.toContainText('REJECTED')
    await expect(editor(p.host)).not.toContainText('REJECTED')
    await expect(p.guest.locator('#permission')).toHaveText('Read-only')
    await grant(p.host, p.guest)
    await append(p.guest, 'ACCEPTED')
    await expect(editor(p.host)).toContainText('ACCEPTED')
    await expect(editor(p.host)).not.toContainText('REJECTED')
  } finally { await p.close() }
})

test('typing after remote updates supports native newline and local undo', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await append(p.host, 'HOST')
    await expect(editor(p.guest)).toContainText('HOST')
    await append(p.guest, 'GUEST')
    await expect(editor(p.host)).toContainText('GUEST')
    await append(p.host, 'SECOND')
    await expect(editor(p.guest)).toContainText('SECOND')
    await p.host.keyboard.press('Enter')
    await p.host.keyboard.insertText('new line')
    await expect(p.guest.locator('.EditorRow').last()).toHaveText('new line')
    await p.host.keyboard.press('ControlOrMeta+z')
    await expect(editor(p.guest)).not.toContainText('new line')
    await expect(editor(p.guest)).toContainText('GUEST')
    await expect(p.host.getByRole('log')).not.toContainText('Editor error')
  } finally { await p.close() }
})
