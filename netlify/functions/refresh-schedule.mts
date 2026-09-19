import type { Config, Context } from '@netlify/functions';
import { dispatch } from './_shared/cron';

export default async function (_request: Request, context: Context) {
  await dispatch('refresh', context);
  console.log(JSON.stringify({event:'cron_dispatched',job:'refresh',at:new Date().toISOString()}));
}

export const config: Config = { schedule: '0 2 * * *' };

