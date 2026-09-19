import type { Config, Context } from '@netlify/functions';
import { dispatch } from './_shared/cron';

export default async function (_request: Request, context: Context) {
  await dispatch('publish', context);
  console.log(JSON.stringify({event:'cron_dispatched',job:'publish',at:new Date().toISOString()}));
}

export const config: Config = { schedule: '* * * * *' };

