import { test, expect } from '@playwright/test'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { action, append, documentText, editor, grant, joined, openFile, pair, ready, revoke, snapshot } from './workbench.ts'

test('complete LVCE workbench exposes collaboration through its command palette and Output', async ({ page }) => {
  await page.goto('/'); await ready(page)
  await expect(page.getByRole('menubar')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Explorer', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+P')
  const input = page.locator('.QuickPick input')
  await input.fill('>Collaboration: Session controls')
  await expect(page.getByText('Collaboration: Session controls', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Host project', { exact: true })).toBeVisible()
  await page.getByRole('option', { name: 'Host project', exact: true }).click()
  await expect(page.locator('.QuickPick input')).toHaveValue('Collaborator')
  await page.locator('.QuickPick input').fill('Host')
  await page.keyboard.press('Enter'); await joined(page)
  await expect(page.getByRole('tree', { name: 'Files Explorer' })).toContainText('README.md')
  await action(page, 'Show Output')
  await expect(page.locator('.Output')).toContainText('Joined collaboration')
  await expect(page.locator('#workspace')).toHaveCount(0)
})
test('invitations, read-only guest, approval, propagation and revocation', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await expect(editor(p.guest).locator('textarea')).toHaveAttribute('readonly', '')
    await editor(p.guest).locator('textarea').focus(); await p.guest.keyboard.insertText('DENIED'); await expect(editor(p.host)).not.toContainText('DENIED')
    await action(p.guest, 'Request write access')
    const participants = action(p.host, 'Participants')
    await p.host.getByRole('option').filter({ hasText: 'Guest · reader' }).click()
    await participants
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'false')
    await append(p.guest, 'Guest contribution')
    await expect(editor(p.host)).toContainText('Guest contribution')
    await revoke(p.host, p.guest)
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'true')
  } finally { await p.close() }
})
test('concurrent editors keep both contributions and converge', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    await Promise.all([append(p.host, 'HOST'), append(p.guest, 'GUEST')])
    await expect(editor(p.host)).toContainText('HOST'); await expect(editor(p.host)).toContainText('GUEST')
    await expect.poll(async () => (await documentText(p.host)) === (await documentText(p.guest))).toBe(true)
  } finally { await p.close() }
})
test('published collaboration demo shows four participants collaborating for one minute', async ({ browser }) => {
  test.setTimeout(120_000)
  const videoDir = process.env.DEMO_VIDEO_DIR ? resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.env.DEMO_VIDEO_DIR) : undefined
  if (videoDir) await mkdir(videoDir, { recursive: true })
  const context = await browser.newContext(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {})
  const guests: any[] = []; let video
  try {
    const host = await context.newPage(); await host.goto('/'); await action(host, 'Host project', { name: 'Host' }); await joined(host)
    const invitation = (await snapshot(host)).invitation
    for (const name of ['Guest One', 'Guest Two', 'Guest Three']) {
      const context = await browser.newContext(), page = await context.newPage(); guests.push({ context, page, name })
      await page.goto(invitation); await action(page, 'Join project', { name }); await joined(page); await grant(host, page)
    }
    await action(host, 'Show Output')
    await append(host, 'Host: welcome to our shared session.\n')
    const started = Date.now()
    for (let round = 0; round < 12; round++) {
      const guest = guests[round % guests.length]
      const contribution = `${guest.name} contribution ${round + 1}.\n`
      await append(guest.page, contribution); await expect(editor(host)).toContainText(contribution)
      await expect(host.locator('.remote-cursor-label').filter({ hasText: guest.name })).toBeVisible()
      await expect(host.locator('.remote-cursor')).toHaveCount(3)
      await host.waitForTimeout(Math.max(0, 5_000 - ((Date.now() - started) % 5_000)))
    }
    await append(host, 'Host: all four editors contributed.\n')
    for (const guest of guests) await expect.poll(async () => await documentText(host) === await documentText(guest.page)).toBe(true)
    if (videoDir) video = host.video()
  } finally { await Promise.all(guests.map(g => g.context.close())); await context.close() }
  if (videoDir && video) await copyFile(await video.path(), resolve(videoDir, 'collaboration-demo.webm'))
})
test('project files remain separate and synchronize to a late joiner', async ({ browser }) => {
  const p = await pair(browser), context = await browser.newContext()
  try {
    await openFile(p.host, 'src/main.js'); await append(p.host, '\n// shared code')
    const late = await context.newPage(); await late.goto(p.invitation); await action(late, 'Join project', { name: 'Late' }); await joined(late)
    await openFile(late, 'src/main.js'); await expect(editor(late)).toContainText('// shared code')
    await expect(editor(p.guest)).not.toContainText('// shared code')
  } finally { await context.close(); await p.close() }
})
test('colored participant cursors follow edits and disappear on departure', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest); await append(p.guest, 'cursor')
    await expect(p.host.locator('.remote-cursor-label')).toContainText('Guest')
    await expect(p.host.locator('.collaboration-avatar')).toHaveText('G')
    await append(p.host, 'prefix'); await expect(p.host.locator('.remote-cursor')).toHaveCount(1)
    await action(p.guest, 'Leave'); await expect(p.host.locator('.remote-cursor')).toHaveCount(0)
  } finally { await p.close() }
})
test('reload reconnects with retained writer identity and project', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest); await append(p.guest, 'Retained edit'); await expect(editor(p.host)).toContainText('Retained edit')
    const id = (await snapshot(p.guest)).self.id
    await p.guest.reload(); await joined(p.guest)
    expect((await snapshot(p.guest)).self.id).toBe(id)
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'false')
    await expect(editor(p.guest)).toContainText('Retained edit')
    expect((await snapshot(p.host)).members.length).toBe(2)
  } finally { await p.close() }
})
test('transport reconnect disables edits while offline and catches up', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest); await p.gc.setOffline(true)
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'true', { timeout: 10_000 })
    await append(p.host, 'While away'); await p.gc.setOffline(false); await joined(p.guest)
    await expect(editor(p.guest)).toContainText('While away')
  } finally { await p.gc.setOffline(false); await p.close() }
})
test('output channel verbosity changes observable logging and persists', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await action(p.host, 'Log verbosity', { level: 'off' }); await action(p.host, 'Clear output')
    await append(p.host, 'quiet'); await expect(editor(p.guest)).toContainText('quiet')
    expect((await snapshot(p.host)).log).toBe('')
    await action(p.host, 'Log verbosity', { level: 'trace' }); await append(p.host, 'verbose')
    await expect.poll(async () => (await snapshot(p.host)).log).toContain('send update')
    await expect.poll(async () => (await snapshot(p.host)).log).toContain('receive ack')
    await p.host.reload(); await joined(p.host)
    expect(await p.host.evaluate(() => localStorage.getItem('collaboration.logLevel'))).toBe('trace')
  } finally { await p.close() }
})
test('invalid invitation produces actionable error', async ({ page }) => {
  await page.goto('/#does-not-exist'); await ready(page)
  await expect(action(page, 'Join project', { name: 'Guest' })).rejects.toThrow('Session unavailable or expired')
})
test('host imports a text folder and downloads its edited contents', async ({ page }) => {
  await page.goto('/'); await ready(page)
  const chooser = page.waitForEvent('filechooser')
  const host = action(page, 'Host folder', { name: 'Host' })
  await (await chooser).setFiles(fileURLToPath(new URL('./fixtures/project', import.meta.url)))
  await host; await joined(page); await openFile(page, 'src/hello.js')
  await expect(editor(page)).toContainText('Shared folder'); await append(page, '// downloaded')
  const downloadPromise = page.waitForEvent('download'); await action(page, 'Download file')
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('hello.js')
  expect(await readFile((await download.path())!, 'utf8')).toContain('// downloaded')
})
test('native selection deletion converges with a concurrent insert', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest); await editor(p.guest).locator('textarea').focus()
    await p.guest.keyboard.press('ControlOrMeta+Home'); await p.guest.keyboard.press('Shift+ArrowRight'); await p.guest.keyboard.press('Shift+ArrowRight')
    await expect(p.host.locator('.remote-selection').first()).toHaveCSS('width', /[1-9]/)
    await Promise.all([p.guest.keyboard.press('Backspace'), append(p.host, 'CONCURRENT')])
    await expect(editor(p.host)).toContainText('CONCURRENT'); await expect(editor(p.guest)).toContainText('CONCURRENT')
    await expect(editor(p.host).locator('.EditorRow').first()).toHaveText('Shared project')
    await expect(editor(p.guest).locator('.EditorRow').first()).toHaveText('Shared project')
  } finally { await p.close() }
})
test('closing workbench editors releases bindings and reopening retains shared text', async ({ page }) => {
  await page.goto('/'); await action(page, 'Host project', { name: 'Host' }); await joined(page)
  const count = page.workers().length
  for (let i = 0; i < 4; i++) {
    await openFile(page, 'src/main.js'); await append(page, `switch-${i}`)
    await expect(editor(page)).toContainText(`switch-${i}`)
    await page.getByRole('tab').filter({ hasText: 'main.js' }).getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('.Editor:visible')).toHaveCount(1)
    await expect.poll(() => page.workers().length).toBeLessThanOrEqual(count + 2)
  }
  await openFile(page, 'src/main.js'); await expect(editor(page)).toContainText('switch-3')
})
test('rejected native edits are discarded on authoritative reconnect', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    const transport = p.guest.workers().find((w: any) => w.url().endsWith('/transport-worker.js'))
    await transport.evaluate(() => {
      const post = globalThis.postMessage.bind(globalThis)
      globalThis.postMessage = data => { if (data.type === 'message' && data.message.type === 'member' && data.message.member.role === 'reader') return; post(data) }
    })
    await revoke(p.host, p.guest)
    const id = (await snapshot(p.guest)).self.id
    await expect.poll(async () => (await snapshot(p.host)).members.find((m: any) => m.id === id).role).toBe('reader')
    await editor(p.guest).locator('textarea').focus(); await p.guest.keyboard.press('ControlOrMeta+End'); await p.guest.keyboard.insertText('REJECTED')
    await expect.poll(async () => (await snapshot(p.guest)).log).toContain('Reconnected to authority')
    await expect(editor(p.guest)).not.toContainText('REJECTED'); await expect(editor(p.host)).not.toContainText('REJECTED')
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'true')
    await expect.poll(async () => (await snapshot(p.guest)).self.role).toBe('reader')
    await expect(p.guest.locator('body')).toHaveAttribute('data-collaboration-connected', 'true')
    await grant(p.host, p.guest); await append(p.guest, 'ACCEPTED'); await expect(editor(p.host)).toContainText('ACCEPTED')
  } finally { await p.close() }
})
test('typing after remote updates supports native newline and local undo', async ({ browser }) => {
  const p = await pair(browser)
  try {
    await grant(p.host, p.guest)
    for (const [page, other, text] of [[p.host, p.guest, 'HOST'], [p.guest, p.host, 'GUEST'], [p.host, p.guest, 'SECOND']]) {
      await append(page, text); await expect(editor(other)).toContainText(text)
    }
    await p.host.keyboard.press('Enter'); await p.host.keyboard.insertText('new line')
    await expect(editor(p.guest).locator('.EditorRow').last()).toHaveText('new line')
    await p.host.keyboard.press('ControlOrMeta+z'); await expect(editor(p.guest)).not.toContainText('new line')
    await expect(editor(p.guest)).toContainText('GUEST')
  } finally { await p.close() }
})
