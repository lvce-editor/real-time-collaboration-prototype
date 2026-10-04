import { test, expect } from '@playwright/test'
import { action, append, editor, grant, joined, revoke, snapshot } from './workbench.ts'
test.use({ baseURL: 'http://127.0.0.1:3001' })
test('dev command automatically joins tabs and browsers with working WebRTC and cleanup', async ({ browser }) => {
  const context = await browser.newContext(), other = await browser.newContext()
  try {
    // Record peer startup even if negotiation finishes before the editor opens.
    await context.addInitScript(() => localStorage.setItem('collaboration.logLevel', 'debug'))
    const host = await context.newPage(); await host.goto('/'); await joined(host); await action(host, 'Log verbosity', { level: 'debug' })
    expect((await snapshot(host)).self.name).toBe('user-1')
    const guest = await context.newPage()
    // Delay native editor loading while the host's WebRTC offer arrives.
    await guest.route('**/editor-worker/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 1000))
      await route.continue()
    })
    await guest.goto('/'); await joined(guest); await action(guest, 'Log verbosity', { level: 'debug' })
    expect((await snapshot(guest)).self.name).toBe('user-2')
    await expect.poll(async () => (await snapshot(host)).log).toContain('WebRTC peer connected')
    await expect.poll(async () => (await snapshot(guest)).log).toContain('WebRTC peer connected')
    await expect(guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'true')
    await grant(host, guest); await append(host, 'Host peer edit'); await expect(editor(guest)).toContainText('Host peer edit')
    await expect.poll(async () => (await snapshot(guest)).log).toContain('WebRTC receive update')
    await append(guest, 'Guest peer edit'); await expect(editor(host)).toContainText('Guest peer edit')
    await expect.poll(async () => (await snapshot(host)).log).toContain('WebRTC receive update')
    await expect.poll(async () => (await snapshot(host)).log).toContain('WebRTC receive cursor')
    await expect(host.locator('.remote-cursor-label')).toContainText('user-2')
    const colors = (await snapshot(host)).members.map((m: any) => m.color)
    expect(new Set(colors).size).toBe(2)
    const late = await other.newPage(); await late.goto('/'); await joined(late)
    expect((await snapshot(late)).self.name).toBe('user-3'); await expect(editor(late)).toContainText('Guest peer edit')
    await revoke(host, guest); await expect(guest.locator('body')).toHaveAttribute('data-collaboration-readonly', 'true')
    await guest.close()
    await expect.poll(async () => (await snapshot(host)).members.find((m: any) => m.name === 'user-2')?.online).toBe(false)
    await expect.poll(async () => (await snapshot(host)).log).toContain('WebRTC peer disconnected')
    await expect(host.locator('.remote-cursor-label').filter({ hasText: 'user-2' })).toHaveCount(0)
    await late.reload(); await joined(late)
    expect((await snapshot(late)).self.name).toBe('user-4'); await expect(editor(late)).toContainText('Guest peer edit')
  } finally { await other.close(); await context.close() }
})
