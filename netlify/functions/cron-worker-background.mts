import type { Context } from '@netlify/functions';
import { alertOperations, authorized, type CronJob, cronSecret, siteOrigin } from './_shared/cron';

export default async function (request: Request, context: Context) {
  const startedAt = Date.now();
  let job: CronJob | 'unknown' = 'unknown';
  try {
    if (request.method !== 'POST') return new Response('Method not allowed', {status:405});
    if (!authorized(request)) return new Response('Unauthorized', {status:401});
    const body = await request.json() as {job?: unknown};
    if (body.job !== 'publish' && body.job !== 'refresh') return new Response('Invalid job', {status:400});
    job = body.job;
    const response = await fetch(`${siteOrigin(context)}/api/cron/${job}`, {
      headers: {authorization:`Bearer ${cronSecret()}`},
      signal: AbortSignal.timeout(12 * 60_000),
    });
    const result = await response.text();
    if (!response.ok) throw new Error(`Cron API returned ${response.status}: ${result.slice(0, 500)}`);
    console.log(JSON.stringify({event:'cron_completed',job,status:response.status,duration_ms:Date.now()-startedAt,result:result.slice(0,500)}));
    return new Response(null, {status:204});
  } catch (error) {
    const detail = {job,duration_ms:Date.now()-startedAt,type:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'Unknown cron failure'};
    console.error(JSON.stringify({event:'cron_failed',...detail}));
    try { await alertOperations('cron_failed', detail); } catch (alertError) { console.error(JSON.stringify({event:'alert_failed',type:alertError instanceof Error?alertError.name:'unknown'})); }
    throw error;
  }
}
