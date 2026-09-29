@AGENTS.md

## Deploying to production

- Production is built by Netlify (Linux) from `main`. Deploy by pushing to `main`; do not put `[skip netlify]` in the head commit.
- Never run `netlify deploy --prod` (or any local `netlify deploy` build) from Windows. The build runs on this machine, so `sharp` is bundled without its Linux binary and every `/api/*` route and cron job returns 500 (`Cannot find package 'sharp-...'`). This took production down on 2026-09-29.
- After each deploy, check `https://rbpost.netlify.app/api/health` returns 200 (`npm run verify:live` covers this).
- Secrets in Netlify (e.g. `META_WEBHOOK_VERIFY_TOKEN`) cannot be read back; changing one needs a redeploy to take effect.
