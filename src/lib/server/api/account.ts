import 'server-only';
import { z } from 'zod';
import { generationSchema, timezoneSchema } from '../../domain';
import { AppError, checkDB, db, json, jsonBody, rate, requireSubscription } from '../core';
import { generate } from '../ai';
import { cancelBilling, checkout, portal } from '../billing';
import { startThreads } from '../threads';
import { startInstagram } from '../instagram';
import { storeImage } from '../images';
import type { ApiRequest } from './types';

/** AI generation, uploads, social connections, billing, profile settings and account deletion. */
export async function accountRoutes({ req, method, path, route, user }: ApiRequest): Promise<Response | null> {
  if (method === 'POST' && route === 'ai/copy') {
    await rate(user.id, 'ai', 6);
    const input = generationSchema.parse(await jsonBody(req));
    return json(await generate(user.id, 'copy', input));
  }
  if (method === 'POST' && route === 'ai/image') {
    await rate(user.id, 'ai', 6);
    const input = z
      .object({ prompt: z.string().trim().min(3).max(3000), post_id: z.uuid().optional() })
      .parse(await jsonBody(req));
    return json(await generate(user.id, 'image', input));
  }
  if (method === 'POST' && route === 'uploads') {
    await rate(user.id, 'upload', 10);
    await requireSubscription(user.id);
    if (Number(req.headers.get('content-length') || 0) > 4_300_000) throw new AppError('Gambar maksimum 4 MB.', 413);
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size > 4 * 1024 * 1024) throw new AppError('Pilih gambar maksimum 4 MB.', 413);
    return json({ image_url: await storeImage(Buffer.from(await file.arrayBuffer()), user.id) });
  }
  if (method === 'GET' && route === 'auth/threads') {
    await rate(user.id, 'oauth', 6);
    return json(await startThreads(user.id));
  }
  if (method === 'GET' && route === 'auth/instagram') {
    await rate(user.id, 'oauth', 6);
    return json(await startInstagram(user.id));
  }
  if (method === 'POST' && (route === 'auth/threads/disconnect' || route === 'auth/instagram/disconnect')) {
    const { error } = await db()
      .from('social_accounts')
      .update({
        status: 'disconnected',
        access_token_encrypted: null,
        expires_at: null,
        scopes: null,
        webhooks_subscribed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('platform', path[1]);
    checkDB(error);
    return json({ disconnected: true });
  }
  if (method === 'POST' && route === 'billing/checkout') {
    await rate(user.id, 'billing', 5);
    const input = z.object({ plan_id: z.enum(['starter', 'pro', 'business']) }).parse(await jsonBody(req));
    return json(await checkout(user.id, user.email || '', input.plan_id));
  }
  if (method === 'POST' && route === 'billing/portal') {
    await rate(user.id, 'billing', 5);
    return json(await portal(user.id));
  }
  if (method === 'PATCH' && route === 'settings') {
    const profile = z
      .object({
        name: z.string().trim().min(1).max(80),
        timezone: timezoneSchema,
        language: z.enum(['Bahasa Melayu', 'English']),
      })
      .parse(await jsonBody(req));
    const { error } = await db()
      .from('users')
      .update({ ...profile, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    checkDB(error);
    return json(profile);
  }
  if (method === 'DELETE' && route === 'account') {
    const client = db();
    await cancelBilling(user.id);
    for (;;) {
      const listed = await client.storage.from('post-images').list(user.id, { limit: 100 });
      checkDB(listed.error);
      if (!listed.data?.length) break;
      const removed = await client.storage
        .from('post-images')
        .remove(listed.data.map(file => `${user.id}/${file.name}`));
      checkDB(removed.error);
    }
    const deleted = await client.auth.admin.deleteUser(user.id);
    checkDB(deleted.error);
    return json({ deleted: true });
  }
  return null;
}
