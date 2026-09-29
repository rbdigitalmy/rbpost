import 'server-only';
import { z } from 'zod';
import { type Post, postSchema, scheduledUTC, timezoneSchema, editable } from '../../domain';
import { mediaPath } from '../../media';
import { AppError, adminAllowed, checkDB, db, json, jsonBody, rate, requireSubscription } from '../core';
import { publishNow } from '../threads';
import type { ApiRequest } from './types';

const fields =
  'id,title,caption,image_url,image_prompt,timezone,platform,status,scheduled_at,published_at,created_at,updated_at,platform_post_id,error_message,error_code';
type Context = { params: Promise<{ path: string[] }> };
async function ownPost(id: string, user: string) {
  z.uuid().parse(id);
  const { data, error } = await db().from('posts').select(fields).eq('id', id).eq('user_id', user).maybeSingle();
  checkDB(error);
  if (!data) throw new AppError('Post tidak ditemui.', 404);
  return data as Post;
}
async function ownAccount(user: string, platform: 'threads' | 'instagram' = 'threads') {
  const { data, error } = await db()
    .from('social_accounts')
    .select('id,username,status,expires_at')
    .eq('user_id', user)
    .eq('platform', platform)
    .maybeSingle();
  checkDB(error);
  if (!data || data.status !== 'connected' || !data.expires_at || Date.parse(data.expires_at) <= Date.now())
    throw new AppError(`Sambungkan akaun ${platform === 'threads' ? 'Threads' : 'Instagram'} dahulu.`, 409);
  return data;
}
function mutable(post: Post) {
  if (!editable(post))
    throw new AppError('Post sedang atau telah diterbitkan, atau memerlukan semakan pentadbir.', 409);
}
// Drafts, scheduled and failed posts are always loaded in full (the calendar and actions need them).
// Published history grows without bound, so it is paged newest-first with a (published_at, id) cursor.
const PUBLISHED_PAGE = 100;
async function activePosts(user: string) {
  const rows: Post[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db()
      .from('posts')
      .select(fields)
      .eq('user_id', user)
      .neq('status', 'published')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + 999);
    checkDB(error);
    rows.push(...((data || []) as Post[]));
    if (!data || data.length < 1000) break;
    offset += 1000;
  }
  return rows;
}
async function publishedPage(user: string, cursor?: { before: string; beforeId: string }) {
  let query = db()
    .from('posts')
    .select(fields)
    .eq('user_id', user)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PUBLISHED_PAGE + 1);
  if (cursor)
    query = query.or(
      `published_at.lt."${cursor.before}",and(published_at.eq."${cursor.before}",id.lt.${cursor.beforeId})`,
    );
  const { data, error } = await query;
  checkDB(error);
  const rows = (data || []) as Post[];
  return { posts: rows.slice(0, PUBLISHED_PAGE), hasMore: rows.length > PUBLISHED_PAGE };
}
async function workspacePosts(user: string) {
  const [active, published, total] = await Promise.all([
    activePosts(user),
    publishedPage(user),
    db().from('posts').select('id', { count: 'exact', head: true }).eq('user_id', user).eq('status', 'published'),
  ]);
  checkDB(total.error);
  return {
    posts: [...active, ...published.posts],
    hasMorePublished: published.hasMore,
    publishedTotal: total.count || 0,
  };
}
const cursorSchema = z.object({
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)$/),
  before_id: z.uuid(),
});

export async function postRoutes({ req, method, path, route, user }: ApiRequest): Promise<Response | null> {
  if (method === 'GET' && (route === 'workspace' || route === 'usage')) {
    const client = db();
    const month = new Date().toISOString().slice(0, 7) + '-01';
    const [profile, threadsAcc, igAcc, subscription, usage, plans] = await Promise.all([
      client.from('users').select('name,email,timezone,language').eq('id', user.id).single(),
      client
        .from('social_accounts')
        .select('id,username,status,expires_at,platform')
        .eq('user_id', user.id)
        .eq('platform', 'threads')
        .maybeSingle(),
      client
        .from('social_accounts')
        .select('id,username,status,expires_at,platform')
        .eq('user_id', user.id)
        .eq('platform', 'instagram')
        .maybeSingle(),
      client
        .from('subscriptions')
        .select('plan_id,status,current_period_end,cancel_at_period_end')
        .eq('user_id', user.id)
        .maybeSingle(),
      client
        .from('usage')
        .select('copy_generations,image_generations,posts_published,estimated_cost')
        .eq('user_id', user.id)
        .eq('month', month)
        .maybeSingle(),
      client.from('plans').select('*').order('monthly_price'),
    ]);
    [profile, threadsAcc, igAcc, subscription, usage, plans].forEach(result => checkDB(result.error));
    const usageData = usage.data || {
      copy_generations: 0,
      image_generations: 0,
      posts_published: 0,
      estimated_cost: 0,
    };
    if (route === 'usage') return json(usageData);
    return json({
      profile: profile.data,
      account: threadsAcc.data,
      instagramAccount: igAcc.data,
      accounts: { threads: threadsAcc.data, instagram: igAcc.data },
      subscription: subscription.data,
      usage: usageData,
      plans: plans.data,
      ...(await workspacePosts(user.id)),
      isAdmin: adminAllowed(user.id),
    });
  }
  if (method === 'GET' && route === 'posts') {
    const params = new URL(req.url).searchParams;
    if (params.get('status') !== 'published') return json(await activePosts(user.id));
    const cursor = params.has('before')
      ? cursorSchema.parse({ before: params.get('before'), before_id: params.get('before_id') })
      : undefined;
    return json(await publishedPage(user.id, cursor && { before: cursor.before, beforeId: cursor.before_id }));
  }
  if (method === 'GET' && path[0] === 'posts' && path.length === 2) return json(await ownPost(path[1], user.id));
  if (method === 'POST' && route === 'posts') {
    await rate(user.id, 'posts', 30);
    const input = postSchema.parse(await jsonBody(req));
    if (input.image_url) mediaPath(input.image_url, user.id);
    const { data, error } = await db()
      .from('posts')
      .insert({ ...input, user_id: user.id })
      .select(fields)
      .single();
    checkDB(error);
    return json(data, 201);
  }
  if (path[0] === 'posts' && path[1] && path.length <= 3) {
    const post = await ownPost(path[1], user.id);
    mutable(post);
    await rate(user.id, 'posts', 30);
    if (method === 'PATCH' && path.length === 2) {
      const input = postSchema.parse(await jsonBody(req));
      if (input.image_url) mediaPath(input.image_url, user.id);
      if (post.status === 'scheduled' && !input.caption.trim())
        throw new AppError('Post berjadual memerlukan caption.');
      const { data, error } = await db()
        .from('posts')
        .update({
          ...input,
          container_id: null,
          publish_attempted_at: null,
          error_message: null,
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', post.id)
        .eq('user_id', user.id)
        .eq('updated_at', post.updated_at)
        .in('status', ['draft', 'scheduled', 'failed'])
        .select(fields)
        .maybeSingle();
      checkDB(error);
      if (!data) throw new AppError('Post telah berubah. Muat semula sebelum menyunting.', 409);
      return json(data);
    }
    if (method === 'DELETE' && path.length === 2) {
      const { data, error } = await db()
        .from('posts')
        .delete()
        .eq('id', post.id)
        .eq('user_id', user.id)
        .eq('updated_at', post.updated_at)
        .in('status', ['draft', 'scheduled', 'failed'])
        .select('id');
      checkDB(error);
      if (!data?.length) throw new AppError('Post telah berubah. Muat semula.', 409);
      return json({ deleted: true });
    }
    if (method === 'POST' && path[2] === 'schedule') {
      await requireSubscription(user.id);
      const targetPlatform = post.platform || 'threads';
      if (targetPlatform === 'threads' || targetPlatform === 'both') await ownAccount(user.id, 'threads');
      if (targetPlatform === 'instagram' || targetPlatform === 'both') {
        await ownAccount(user.id, 'instagram');
        if (!post.image_url) throw new AppError('Post ke Instagram memerlukan gambar.');
      }
      const input = z.object({ local: z.string(), timezone: timezoneSchema }).parse(await jsonBody(req));
      if (!post.caption.trim()) throw new AppError('Caption diperlukan sebelum menjadualkan.');
      let date: string;
      try {
        date = scheduledUTC(input.local, input.timezone);
      } catch (e) {
        throw new AppError((e as Error).message);
      }
      const { data, error } = await db()
        .from('posts')
        .update({
          status: 'scheduled',
          scheduled_at: date,
          timezone: input.timezone,
          container_id: null,
          publish_attempted_at: null,
          next_attempt_at: null,
          attempts: 0,
          error_message: null,
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', post.id)
        .eq('user_id', user.id)
        .eq('updated_at', post.updated_at)
        .in('status', ['draft', 'scheduled', 'failed'])
        .select(fields)
        .maybeSingle();
      checkDB(error);
      if (!data) throw new AppError('Post telah berubah. Muat semula.', 409);
      return json(data);
    }
    if (method === 'POST' && path[2] === 'publish') {
      await rate(user.id, 'publish', 6);
      await requireSubscription(user.id);
      const targetPlatform = post.platform || 'threads';
      if (targetPlatform === 'threads' || targetPlatform === 'both') await ownAccount(user.id, 'threads');
      if (targetPlatform === 'instagram' || targetPlatform === 'both') {
        await ownAccount(user.id, 'instagram');
        if (!post.image_url) throw new AppError('Post ke Instagram memerlukan gambar.');
      }
      if (!post.caption.trim()) throw new AppError('Caption diperlukan sebelum penerbitan.');
      const saved = await db()
        .from('posts')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', post.id)
        .eq('user_id', user.id)
        .eq('updated_at', post.updated_at)
        .in('status', ['draft', 'scheduled', 'failed'])
        .select('id')
        .maybeSingle();
      checkDB(saved.error);
      if (!saved.data) throw new AppError('Post telah berubah. Muat semula.', 409);
      await publishNow(user.id, post.id);
      return json(await ownPost(post.id, user.id));
    }
  }
  return null;
}
