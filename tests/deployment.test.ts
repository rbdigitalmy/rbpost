import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Netlify owns deployment scheduling without a competing Vercel cron', () => {
  assert.equal(fs.existsSync('vercel.json'), false);
  const config = fs.readFileSync('netlify.toml', 'utf8');
  assert.match(config, /directory\s*=\s*"netlify\/functions"/);
  const publish = fs.readFileSync('netlify/functions/publish-schedule.mts', 'utf8');
  const refresh = fs.readFileSync('netlify/functions/refresh-schedule.mts', 'utf8');
  const worker = fs.readFileSync('netlify/functions/cron-worker-background.mts', 'utf8');
  assert.match(publish, /schedule:\s*'\* \* \* \* \*'/);
  assert.match(refresh, /schedule:\s*'0 2 \* \* \*'/);
  assert.match(worker, /authorized\(request\)/);
  assert.match(worker, /\/api\/cron\/\$\{job\}/);
});

test('public legal documents and operational configuration are present', () => {
  for (const file of ['src/app/privacy/page.tsx','src/app/terms/page.tsx','src/app/data-deletion/page.tsx','src/app/robots.ts','src/app/sitemap.ts']) {
    assert.equal(fs.existsSync(file), true, file);
  }
  const example = fs.readFileSync('.env.example', 'utf8');
  assert.match(example, /^ALERT_WEBHOOK_URL=/m);
});
