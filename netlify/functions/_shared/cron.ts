import type { Context } from '@netlify/functions';
import { timingSafeEqual } from 'node:crypto';

export type CronJob = 'publish' | 'refresh';

export function cronSecret() {
  const secret = Netlify.env.get('CRON_SECRET');
  if (!secret) throw new Error('CRON_SECRET is not configured.');
  return secret;
}

export function authorized(request: Request) {
  const provided = request.headers.get('authorization') || '';
  const expected = `Bearer ${cronSecret()}`;
  return provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function siteOrigin(context: Context) {
  const value = context.site.url || Netlify.env.get('URL') || Netlify.env.get('NEXT_PUBLIC_APP_URL');
  if (!value) throw new Error('The deployed site URL is unavailable.');
  return new URL(value).origin;
}

export async function dispatch(job: CronJob, context: Context) {
  const response = await fetch(`${siteOrigin(context)}/.netlify/functions/cron-worker-background`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cronSecret()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ job }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) throw new Error(`Background cron dispatch failed with status ${response.status}.`);
}

export async function alertOperations(event: string, detail: Record<string, unknown>) {
  const target = Netlify.env.get('ALERT_WEBHOOK_URL');
  if (!target) return;
  const url = new URL(target);
  if (url.protocol !== 'https:') throw new Error('ALERT_WEBHOOK_URL must use HTTPS.');
  await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text:`RB Post alert: ${event}`,event,...detail}),
    signal: AbortSignal.timeout(5_000),
  });
}
