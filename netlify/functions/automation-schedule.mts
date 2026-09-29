import type { Config, Context } from '@netlify/functions';
import { dispatch } from './_shared/cron';

// Sends queued automated replies (retries included) and polls Threads replies as a webhook fallback.
export default async function (_request: Request, context: Context) {
  await dispatch('automation', context);
  console.log(JSON.stringify({ event: 'cron_dispatched', job: 'automation', at: new Date().toISOString() }));
}

export const config: Config = { schedule: '* * * * *' };
