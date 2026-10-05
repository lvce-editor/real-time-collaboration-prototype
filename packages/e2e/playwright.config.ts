import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './test', workers: 1, retries: 0, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox-cursor-alignment', grep: /remote cursor aligns with rendered text/, use: { browserName: 'firefox' } },
  ],
  webServer: [
    { command: 'npm start', cwd: '../..', url: 'http://127.0.0.1:3000', reuseExistingServer: false },
    { command: 'npm run dev', cwd: '../..', env: { PORT: '3001' }, url: 'http://127.0.0.1:3001', reuseExistingServer: false },
  ],
})
