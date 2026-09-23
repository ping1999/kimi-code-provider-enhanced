import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    channel: process.env['KPE_BROWSER_CHANNEL'] ?? 'msedge',
    headless: true,
  },
});
