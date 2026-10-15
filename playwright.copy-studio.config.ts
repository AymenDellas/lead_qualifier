import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/copy-studio/browser',
  outputDir: './tmp/copy-studio-test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    channel: 'chrome',
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/api/copy-studio/health',
    reuseExistingServer: true,
    timeout: 180000,
  },
});
