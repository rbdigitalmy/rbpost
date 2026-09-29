import 'server-only';
import { z } from 'zod';
import { AppError, checkDB, db, json, jsonBody, requireAdmin } from '../core';
import { models } from '../ai';
import type { ApiRequest } from './types';

export async function adminRoutes({ req, method, path, route, user }: ApiRequest): Promise<Response | null> {
  if (path[0] === 'admin') {
    requireAdmin(user.id);
    if (method === 'GET' && route === 'admin') {
      // MRR comes from the amount each subscriber is actually billed (synced from Stripe), not today's list price.
      const c = db();
      const [metrics, plans, settings] = await Promise.all([
        c.rpc('admin_metrics'),
        c.from('plans').select('*').order('monthly_price'),
        models(),
      ]);
      checkDB(metrics.error);
      checkDB(plans.error);
      const m = metrics.data as {
        users: number;
        subscribers: number;
        mrr: number | string;
        aiCostUsd: number | string;
        images: number;
        published: number;
        failed: number;
        unknownCosts: number;
      };
      return json({
        users: m.users,
        subscribers: m.subscribers,
        mrr: Number(m.mrr),
        aiCost: Number(m.aiCostUsd) * Number(process.env.USD_MYR_RATE || 4.5),
        images: m.images,
        published: m.published,
        failed: m.failed,
        unknownCosts: m.unknownCosts,
        infra: Number(process.env.MONTHLY_INFRA_COST_MYR || 0),
        plans: plans.data,
        settings,
      });
    }
    if (method === 'GET' && route === 'admin/generations') {
      const c = db();
      const { data, error } = await c
        .from('generations')
        .select('id,user_id,type,model,provider_id,created_at')
        .eq('status', 'uncertain')
        .order('created_at')
        .limit(100);
      checkDB(error);
      const ids = [...new Set((data || []).map(g => g.user_id))];
      const owners = ids.length ? await c.from('users').select('id,email').in('id', ids) : { data: [], error: null };
      checkDB(owners.error);
      return json((data || []).map(g => ({ ...g, email: owners.data?.find(u => u.id === g.user_id)?.email || null })));
    }
    if (method === 'POST' && path[1] === 'generations' && path[3] === 'resolve' && path.length === 4) {
      z.uuid().parse(path[2]);
      const input = z.object({ refund: z.boolean() }).parse(await jsonBody(req));
      const result = await db().rpc('resolve_generation', { p_id: path[2], p_refund: input.refund });
      checkDB(result.error);
      if (!result.data) throw new AppError('Rekod ini telah diselesaikan.', 409);
      return json({ resolved: true });
    }
    if (method === 'PATCH' && route === 'admin/settings') {
      const input = z
        .object({
          copy_model: z.string().regex(/^[a-zA-Z0-9._:/-]{3,120}$/),
          image_model: z.string().regex(/^[a-zA-Z0-9._:/-]{3,120}$/),
        })
        .parse(await jsonBody(req));
      const result = await db()
        .from('app_settings')
        .upsert({ id: true, ...input });
      checkDB(result.error);
      return json(input);
    }
    if (method === 'PATCH' && path[1] === 'plans' && path.length === 3) {
      const input = z
        .object({
          monthly_price: z.number().min(0).max(10000),
          monthly_post_limit: z.number().int().min(0).max(100000),
          monthly_image_limit: z.number().int().min(0).max(100000),
          active: z.boolean(),
        })
        .parse(await jsonBody(req));
      const result = await db().from('plans').update(input).eq('id', path[2]).select('*').single();
      checkDB(result.error);
      return json(result.data);
    }
  }
  return null;
}
