import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { encryptToken, decryptToken } from '../crypto';
import { type Post } from '../domain';
import { AppError, appUrl, db, env, checkDB, requireSubscription, logTechnical } from './core';
import { publishImageUrl } from './images';
import { InstagramError, ThreadsError, errorSummary, reconnectPlatform, type SocialPlatform } from '../provider-errors';
export { ThreadsError };
const API = 'https://graph.threads.net';
export async function threadsRequest<T>(
  path: string,
  token: string | undefined,
  params: Record<string, string> = {},
  method = 'GET',
): Promise<T> {
  const url = new URL(`${API}/${path}`);
  if (method === 'GET') Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(25_000),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new ThreadsError(response.status, value.error?.code || null, value);
  return value as T;
}
export async function startThreads(userId: string) {
  await requireSubscription(userId);
  const client = env('META_APP_ID');
  env('META_APP_SECRET');
  env('TOKEN_ENCRYPTION_KEY');
  const state = randomBytes(32).toString('hex');
  const jar = await cookies();
  jar.set('threads_oauth_state', `${userId}:${state}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  const url = new URL('https://threads.net/oauth/authorize');
  url.search = new URLSearchParams({
    force_reauth: 'true',
    client_id: client,
    redirect_uri: env('THREADS_REDIRECT_URI'),
    scope: 'threads_basic,threads_content_publish',
    response_type: 'code',
    state,
  }).toString();
  return { url: url.toString() };
}
export async function finishThreads(req: Request, userId: string) {
  const jar = await cookies();
  const state = jar.get('threads_oauth_state')?.value;
  jar.delete('threads_oauth_state');
  const q = new URL(req.url).searchParams;
  const expected = `${userId}:${q.get('state') || ''}`;
  if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected)))
    return NextResponse.redirect(`${appUrl()}/connections?error=state`);
  if (q.has('error') || !q.get('code')) return NextResponse.redirect(`${appUrl()}/connections?error=cancelled`);
  try {
    await requireSubscription(userId);
    const short = await threadsRequest<{ access_token: string; user_id: string }>(
      'oauth/access_token',
      undefined,
      {
        client_id: env('META_APP_ID'),
        client_secret: env('META_APP_SECRET'),
        code: q.get('code')!,
        grant_type: 'authorization_code',
        redirect_uri: env('THREADS_REDIRECT_URI'),
      },
      'POST',
    );
    const long = await threadsRequest<{ access_token: string; expires_in: number }>('access_token', undefined, {
      grant_type: 'th_exchange_token',
      client_secret: env('META_APP_SECRET'),
      access_token: short.access_token,
    });
    const profile = await threadsRequest<{ id: string; username: string }>('v1.0/me', long.access_token, {
      fields: 'id,username',
    });
    if (!profile.id || !profile.username || !long.access_token || !Number.isFinite(long.expires_in))
      throw new Error('Invalid OAuth response');
    // Switching to a different Threads account replaces the old connection; one Threads account may belong to only one RB Post user.
    const { data: owner, error } = await db()
      .from('social_accounts')
      .select('id,status')
      .eq('platform', 'threads')
      .eq('platform_user_id', profile.id)
      .neq('user_id', userId)
      .maybeSingle();
    checkDB(error);
    if (owner && owner.status !== 'disconnected')
      return NextResponse.redirect(`${appUrl()}/connections?error=account_in_use`);
    if (owner) {
      const released = await db().from('social_accounts').delete().eq('id', owner.id).eq('status', 'disconnected');
      checkDB(released.error);
    }
    const saved = await db()
      .from('social_accounts')
      .upsert(
        {
          user_id: userId,
          platform: 'threads',
          platform_user_id: profile.id,
          username: profile.username,
          access_token_encrypted: encryptToken(long.access_token, userId, env('TOKEN_ENCRYPTION_KEY')),
          expires_at: new Date(Date.now() + long.expires_in * 1000).toISOString(),
          status: 'connected',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform' },
      );
    checkDB(saved.error);
    return NextResponse.redirect(`${appUrl()}/connections?connected=1`);
  } catch (e) {
    const summary = errorSummary(e);
    console.error(JSON.stringify({ event: 'oauth_failed', platform: 'threads', ...summary }));
    await logTechnical(userId, null, 'oauth_failed', summary);
    return NextResponse.redirect(`${appUrl()}/connections?error=connection`);
  }
}
import { processInstagramPublish, refreshInstagramToken } from './instagram';

interface PublishPost extends Post {
  user_id: string;
  social_account_id: string | null;
  container_id: string | null;
  attempts: number;
  publish_attempted_at: string | null;
}
const MAX_ATTEMPTS = 8;
const platformName = (p: SocialPlatform) => (p === 'threads' ? 'Threads' : 'Instagram');

/** Media is still processing: hand the post back to the scheduler to check again in a minute. */
async function retryLater(post: PublishPost) {
  const save = await db()
    .from('posts')
    .update({
      status: 'scheduled',
      scheduled_at: post.scheduled_at || new Date().toISOString(),
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      claimed_at: null,
    })
    .eq('id', post.id)
    .eq('status', 'publishing');
  checkDB(save.error);
}

/** Persist that the irreversible publish call is about to happen; any later failure is an unknown outcome. */
async function markAttempted(post: PublishPost) {
  const marker = await db()
    .from('posts')
    .update({ publish_attempted_at: new Date().toISOString() })
    .eq('id', post.id)
    .eq('status', 'publishing')
    .select('id')
    .single();
  checkDB(marker.error);
}

async function flagReconnect(userId: string, platform: SocialPlatform) {
  await db().from('social_accounts').update({ status: 'reconnect' }).eq('user_id', userId).eq('platform', platform);
}

export async function processPost(post: PublishPost) {
  let attempted = !!post.publish_attempted_at;
  let publishedId: string | undefined;
  try {
    await requireSubscription(post.user_id);
    const targetPlatform = post.platform || 'threads';

    if (targetPlatform === 'instagram') {
      if (attempted) throw new AppError('Hasil penerbitan belum dapat dipastikan.', 409, 'outcome_unknown');
      try {
        publishedId = await processInstagramPublish(post, {
          containerId: post.container_id,
          onContainer: async id => {
            const save = await db()
              .from('posts')
              .update({ container_id: id })
              .eq('id', post.id)
              .eq('status', 'publishing');
            checkDB(save.error);
          },
          beforePublish: async () => {
            await markAttempted(post);
            attempted = true;
          },
        });
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'media_pending')) throw e;
        if (post.attempts >= MAX_ATTEMPTS)
          throw new AppError(
            'Gambar Instagram mengambil masa terlalu lama untuk diproses. Sila cuba semula.',
            502,
            'media_timeout',
          );
        await retryLater(post);
        return;
      }
      const saved = await db().rpc('complete_publish', { p_id: post.id, p_platform_id: publishedId });
      checkDB(saved.error);
      return;
    }

    const { data: account, error } = await db()
      .from('social_accounts')
      .select('*')
      .eq('user_id', post.user_id)
      .eq('platform', 'threads')
      .maybeSingle();
    checkDB(error);
    if (
      !account ||
      account.status !== 'connected' ||
      !account.access_token_encrypted ||
      Date.parse(account.expires_at) <= Date.now()
    )
      throw new AppError('Sila sambungkan semula akaun Threads anda.', 409, 'reconnect');
    const token = decryptToken(account.access_token_encrypted, post.user_id, env('TOKEN_ENCRYPTION_KEY'));
    if (attempted) throw new AppError('Hasil penerbitan belum dapat dipastikan.', 409, 'outcome_unknown');
    let container = post.container_id;
    if (!container) {
      const params: Record<string, string> = { media_type: post.image_url ? 'IMAGE' : 'TEXT', text: post.caption };
      if (post.image_url) params.image_url = await publishImageUrl(post.image_url, post.user_id);
      const created = await threadsRequest<{ id: string }>(
        `v1.0/${account.platform_user_id}/threads`,
        token,
        params,
        'POST',
      );
      if (!created.id) throw new Error('Missing container');
      container = created.id;
      const save = await db()
        .from('posts')
        .update({ container_id: container })
        .eq('id', post.id)
        .eq('status', 'publishing');
      checkDB(save.error);
    }
    let finished = false;
    for (let i = 0; i < 5; i++) {
      const status = await threadsRequest<{ status: string; error_message?: string }>(`v1.0/${container}`, token, {
        fields: 'status,error_message',
      });
      if (status.status === 'FINISHED') {
        finished = true;
        break;
      }
      if (status.status === 'PUBLISHED')
        throw new AppError('Semak post ini di Threads sebelum mencuba lagi.', 409, 'outcome_unknown');
      if (status.status === 'ERROR')
        throw new AppError(
          status.error_message || 'Visual belum boleh diterbitkan. Cuba jana atau muat naik semula.',
          502,
          'media_failed',
        );
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!finished) {
      if (post.attempts >= MAX_ATTEMPTS)
        throw new AppError(
          'Gambar mengambil masa terlalu lama untuk diproses. Sila cuba semula.',
          502,
          'media_timeout',
        );
      await retryLater(post);
      return;
    }
    await markAttempted(post);
    attempted = true;
    const published = await threadsRequest<{ id: string }>(
      `v1.0/${account.platform_user_id}/threads_publish`,
      token,
      { creation_id: container },
      'POST',
    );
    if (!published.id) throw new Error('Missing publish result');
    publishedId = published.id;

    // Threads is already live, so an Instagram failure cannot fail the whole post. It is recorded on the
    // published post so the user sees it instead of it disappearing into the technical log.
    let instagramFailure: string | null = null;
    if (targetPlatform === 'both') {
      // Only a failure after media_publish was called leaves the Instagram outcome unknown.
      let igAttempted = false;
      try {
        const igId = await processInstagramPublish(post, {
          polls: 15,
          beforePublish: async () => {
            igAttempted = true;
          },
        });
        publishedId = `${published.id},${igId}`;
      } catch (igErr) {
        const reconnect = reconnectPlatform(igErr);
        if (reconnect) await flagReconnect(post.user_id, reconnect);
        instagramFailure = igAttempted
          ? 'Diterbitkan di Threads sahaja. Hasil Instagram belum pasti; semak akaun Instagram anda sebelum menerbitkan semula.'
          : reconnect
            ? 'Diterbitkan di Threads sahaja. Instagram gagal: sila sambungkan semula akaun Instagram anda.'
            : igErr instanceof AppError && igErr.code === 'media_pending'
              ? 'Diterbitkan di Threads sahaja. Instagram belum diterbitkan kerana gambar masih diproses; cuba terbitkan ke Instagram semula.'
              : igErr instanceof AppError
                ? `Diterbitkan di Threads sahaja. Instagram gagal: ${igErr.message}`
                : 'Diterbitkan di Threads sahaja. Instagram gagal diterbitkan; cuba terbitkan ke Instagram semula.';
        await logTechnical(post.user_id, post.id, 'instagram_cross_publish_failed', {
          threads_id: published.id,
          attempted: igAttempted,
          ...errorSummary(igErr),
        });
      }
    }

    const saved = await db().rpc('complete_publish', { p_id: post.id, p_platform_id: publishedId });
    checkDB(saved.error);
    if (instagramFailure) {
      const flagged = await db()
        .from('posts')
        .update({ error_code: 'instagram_failed', error_message: instagramFailure })
        .eq('id', post.id)
        .eq('status', 'published');
      checkDB(flagged.error);
    }
  } catch (e) {
    const unknown = attempted || (e instanceof AppError && e.code === 'outcome_unknown');
    const reconnect = reconnectPlatform(e);
    if (reconnect) await flagReconnect(post.user_id, reconnect);
    const message = unknown
      ? 'Hasil penerbitan belum pasti. Semak akaun sosial dan hubungi pentadbir sebelum mencuba lagi.'
      : reconnect
        ? `Post gagal diterbitkan. Sila sambungkan semula akaun ${platformName(reconnect)} anda.`
        : e instanceof AppError
          ? e.message
          : 'Post gagal diterbitkan. Sila cuba lagi sebentar.';
    await db()
      .from('posts')
      .update({
        status: 'failed',
        error_message: message,
        error_code: unknown
          ? 'outcome_unknown'
          : reconnect
            ? 'reconnect'
            : e instanceof AppError
              ? e.code
              : 'publish_failed',
        ...(unknown ? {} : { container_id: null, publish_attempted_at: null }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id)
      .eq('status', 'publishing');
    await logTechnical(post.user_id, post.id, 'publish_failed', {
      unknown,
      platform_post_id: publishedId || null,
      provider_code: e instanceof ThreadsError || e instanceof InstagramError ? e.providerCode : null,
    });
  }
}
// The cron fires every minute. Keep claiming batches (10 in parallel, the DB maximum) while there is due work,
// but stop starting new batches after ~30 s so runs rarely overlap; overlapping runs are still safe (SKIP LOCKED).
const BATCH_SIZE = 10,
  BATCH_WINDOW_MS = 30_000;
export async function runDuePosts() {
  const started = Date.now();
  let processed = 0;
  while (Date.now() - started < BATCH_WINDOW_MS) {
    const { data, error } = await db().rpc('claim_due_posts', { p_limit: BATCH_SIZE });
    checkDB(error);
    const batch = (data || []) as PublishPost[];
    await Promise.all(batch.map(p => processPost(p)));
    processed += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }
  return { processed };
}
export async function publishNow(userId: string, postId: string) {
  await requireSubscription(userId);
  const { data, error } = await db().rpc('claim_post', { p_id: postId, p_user: userId });
  checkDB(error);
  if (!data?.[0]) throw new AppError('Post sedang diterbitkan atau tidak boleh diterbitkan semula.', 409);
  await processPost(data[0]);
}
interface ExpiringAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token_encrypted: string;
  expires_at: string;
}
/** Returns whether the token was refreshed; on failure the account is flagged for reconnection. */
async function refreshAccount(a: ExpiringAccount) {
  const client = db();
  try {
    if (Date.parse(a.expires_at) <= Date.now()) throw new Error('Expired');
    const token = decryptToken(a.access_token_encrypted, a.user_id, env('TOKEN_ENCRYPTION_KEY'));
    const next =
      a.platform === 'instagram'
        ? await refreshInstagramToken(token)
        : await threadsRequest<{ access_token: string; expires_in: number }>('refresh_access_token', token, {
            grant_type: 'th_refresh_token',
          });
    if (!next.access_token || !Number.isFinite(next.expires_in)) throw new Error('Invalid refresh');
    const saved = await client
      .from('social_accounts')
      .update({
        access_token_encrypted: encryptToken(next.access_token, a.user_id, env('TOKEN_ENCRYPTION_KEY')),
        expires_at: new Date(Date.now() + next.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', a.id);
    checkDB(saved.error);
    return true;
  } catch {
    await client.from('social_accounts').update({ status: 'reconnect' }).eq('id', a.id);
    await logTechnical(a.user_id, null, 'token_refresh_failed');
    return false;
  }
}
// A refreshed or flagged account drops out of the query (later expiry / 'reconnect' status), so keep taking the
// soonest-expiring page until none are left or the budget (well inside the route's maxDuration) runs out.
// `seen` skips a row whose status update itself failed, so it cannot be retried forever.
const REFRESH_PAGE = 50,
  REFRESH_BUDGET_MS = 150_000;
export async function refreshTokens() {
  const client = db();
  const started = Date.now();
  const seen = new Set<string>();
  let refreshed = 0;
  while (Date.now() - started < REFRESH_BUDGET_MS) {
    const { data, error } = await client
      .from('social_accounts')
      .select('id,user_id,platform,access_token_encrypted,expires_at')
      .eq('status', 'connected')
      .lt('expires_at', new Date(Date.now() + 7 * 86400_000).toISOString())
      .order('expires_at')
      .limit(REFRESH_PAGE + seen.size);
    checkDB(error);
    const batch = ((data || []) as ExpiringAccount[]).filter(a => !seen.has(a.id)).slice(0, REFRESH_PAGE);
    if (!batch.length) break;
    for (const a of batch) {
      if (Date.now() - started >= REFRESH_BUDGET_MS) break;
      seen.add(a.id);
      if (await refreshAccount(a)) refreshed++;
    }
  }
  await client
    .from('rate_limits')
    .delete()
    .lt('window_start', new Date(Date.now() - 86400_000).toISOString());
  // Interrupted generation requests retain their reservation pending cost reconciliation.
  await client
    .from('generations')
    .update({ status: 'uncertain' })
    .eq('status', 'reserved')
    .lt('created_at', new Date(Date.now() - 15 * 60_000).toISOString());
  // Delete stored images no post has referenced for a week (unsaved AI images, deleted posts).
  let imagesRemoved = 0;
  const orphans = await client.rpc('orphan_images', { p_limit: 500 });
  if (orphans.error) await logTechnical(null, null, 'orphan_scan_failed', { code: orphans.error.code || null });
  else {
    const names = ((orphans.data || []) as unknown[])
      .map(v => (typeof v === 'string' ? v : (v as { orphan_images?: string }).orphan_images))
      .filter((v): v is string => !!v);
    if (names.length) {
      const removed = await client.storage.from('post-images').remove(names);
      if (removed.error) await logTechnical(null, null, 'orphan_cleanup_failed');
      else imagesRemoved = names.length;
    }
  }
  return { refreshed, imagesRemoved };
}
