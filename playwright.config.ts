import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:30_000,
 use:{baseURL:'http://127.0.0.1:3000',headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',screenshot:'only-on-failure',trace:'retain-on-failure'},
 reporter:'list',outputDir:'.local/test-results',
});
