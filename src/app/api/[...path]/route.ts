import { mediaPath } from '@/lib/media';
import {
  AppError,
  checkDB,
  cronAuth,
  db,
  ensureProfile,
  errorResponse,
  json,
  logTechnical,
  requireUser,
  sameOrigin,
} from '@/lib/server/core';
import { paymentWebhook } from '@/lib/server/billing';
import { finishThreads, refreshTokens, runDuePosts } from '@/lib/server/threads';
import { finishInstagram } from '@/lib/server/instagram';
import { postRoutes } from '@/lib/server/api/posts';
import { accountRoutes } from '@/lib/server/api/account';
import { adminRoutes } from '@/lib/server/api/admin';
import { automationRoutes } from '@/lib/server/api/automations';
import type { RouteModule } from '@/lib/server/api/types';
import { processAutomationQueue, receiveWebhook, runAutomation, webhookChallenge } from '@/lib/server/automation';
import { errorSummary } from '@/lib/provider-errors';
import { after } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 240;
type Context = { params: Promise<{ path: string[] }> };
const modules: RouteModule[] = [postRoutes, accountRoutes, adminRoutes, automationRoutes];
async function handle(req: Request, context: Context) {
  try {
    const { path } = await context.params;
    const route = path.join('/');
    const method = req.method;
    if (method === 'GET' && route === 'health') {
      const started = Date.now();
      const client = db();
      const { error } = await client.from('plans').select('id', { count: 'exact', head: true }).eq('active', true);
      checkDB(error);
      return json({
        status: 'ok',
        database: 'ok',
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - started,
      });
    }
    if (method === 'POST' && route === 'webhooks/payment') return json(await paymentWebhook(req));
    if (route === 'webhooks/instagram' || route === 'webhooks/threads') {
      if (method === 'GET') return webhookChallenge(req);
      if (method !== 'POST') throw new AppError('Method not allowed', 405);
      const { queued } = await receiveWebhook(route === 'webhooks/instagram' ? 'instagram' : 'threads', req);
      // Acknowledge now; the minute cron picks up anything this run does not finish.
      if (queued)
        after(() =>
          processAutomationQueue(20_000).catch(e =>
            logTechnical(null, null, 'automation_after_failed', errorSummary(e)),
          ),
        );
      return json({ received: true });
    }
    if (method === 'GET' && route.startsWith('cron/')) {
      cronAuth(req);
      if (route === 'cron/publish') return json(await runDuePosts());
      if (route === 'cron/refresh') return json(await refreshTokens());
      if (route === 'cron/automation') return json(await runAutomation());
      throw new AppError('Not found', 404);
    }
    if (['POST', 'PATCH', 'DELETE'].includes(method)) sameOrigin(req);
    const user = await requireUser();
    await ensureProfile(user);
    if (method === 'GET' && route === 'auth/threads/callback') return await finishThreads(req, user.id);
    if (method === 'GET' && route === 'auth/instagram/callback') return await finishInstagram(req, user.id);
    if (method === 'GET' && route === 'media') {
      let stored: string;
      try {
        stored = mediaPath(
          `/api/media?path=${encodeURIComponent(new URL(req.url).searchParams.get('path') || '')}`,
          user.id,
        );
      } catch {
        throw new AppError('Gambar tidak ditemui.', 404);
      }
      const { data, error } = await db().storage.from('post-images').download(stored);
      checkDB(error);
      if (!data) throw new AppError('Gambar tidak ditemui.', 404);
      return new Response(data, {
        headers: {
          'Content-Type': data.type,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    for (const handler of modules) {
      const response = await handler({ req, method, path, route, user });
      if (response) return response;
    }
    throw new AppError('Endpoint tidak ditemui.', 404);
  } catch (e) {
    return await errorResponse(e);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
