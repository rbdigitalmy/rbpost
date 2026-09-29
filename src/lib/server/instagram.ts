import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { encryptToken, decryptToken } from '../crypto';
import { type Post } from '../domain';
import { AppError, appUrl, db, env, checkDB, requireSubscription, logTechnical } from './core';
import { instagramImageUrl } from './images';
import { InstagramError, errorSummary } from '../provider-errors';
import { instagramScopes, parseGrantedScopes } from '../automation';

export { InstagramError };

// Meta retires Graph API versions about two years after release; override without a deploy via INSTAGRAM_GRAPH_VERSION.
const GRAPH_VERSION = /^v\d+\.\d+$/.test(process.env.INSTAGRAM_GRAPH_VERSION || '')
  ? process.env.INSTAGRAM_GRAPH_VERSION
  : 'v25.0';
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_VERSION}`;

export async function instagramRequest<T>(
  path: string,
  token: string | undefined,
  params: Record<string, string> = {},
  method = 'GET',
): Promise<T> {
  const url = new URL(`${GRAPH_URL}/${path}`);
  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
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
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) {
    throw new InstagramError(response.status, value.error?.code || null, value);
  }
  return value as T;
}

/** JSON POST for endpoints with nested bodies (messages). */
export async function instagramPostJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
    cache: 'no-store',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) throw new InstagramError(response.status, value.error?.code || null, value);
  return value as T;
}

/** Subscribes the connected professional account to this app's comment and message webhooks. */
export async function subscribeInstagramWebhooks(token: string) {
  const result = await instagramRequest<{ success?: boolean }>(
    'me/subscribed_apps',
    token,
    { subscribed_fields: 'comments,messages' },
    'POST',
  );
  if (!result.success) throw new Error('Instagram webhook subscription was not confirmed');
}

export async function startInstagram(userId: string) {
  await requireSubscription(userId);
  const clientId = env('INSTAGRAM_APP_ID');
  env('TOKEN_ENCRYPTION_KEY');
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI || `${appUrl()}/api/auth/instagram/callback`;

  const state = randomBytes(32).toString('hex');
  const jar = await cookies();
  jar.set('instagram_oauth_state', `${userId}:${state}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({
    force_reauth: 'true',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: instagramScopes.join(','),
    response_type: 'code',
    state,
  }).toString();

  return { url: url.toString() };
}

export async function finishInstagram(req: Request, userId: string) {
  const jar = await cookies();
  const state = jar.get('instagram_oauth_state')?.value;
  jar.delete('instagram_oauth_state');
  const q = new URL(req.url).searchParams;
  const expected = `${userId}:${q.get('state') || ''}`;

  if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return NextResponse.redirect(`${appUrl()}/connections?error=state`);
  }
  if (q.has('error') || !q.get('code')) {
    const reason = q.get('error_reason') || q.get('error');
    const errorCode = reason === 'insufficient_developer_role' ? 'developer_role' : 'cancelled';
    return NextResponse.redirect(`${appUrl()}/connections?error=${errorCode}`);
  }

  try {
    await requireSubscription(userId);
    const clientId = env('INSTAGRAM_APP_ID');
    const clientSecret = env('INSTAGRAM_APP_SECRET');
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI || `${appUrl()}/api/auth/instagram/callback`;

    // Step 1: Exchange code for short-lived access token
    const short = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: q.get('code')!,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const shortBody = await short.json().catch(() => ({}));
    // Documented as {data:[{access_token,user_id,permissions}]}; the flat shape is also returned in practice.
    const shortData = Array.isArray(shortBody?.data) ? shortBody.data[0] || {} : shortBody;
    if (!short.ok || !shortData.access_token)
      throw new InstagramError(short.status, shortBody.error?.code ?? shortBody.code ?? null, shortBody);
    const scopes = parseGrantedScopes(shortData.permissions, instagramScopes);

    // Step 2: Exchange for long-lived access token
    const long = await instagramRequest<{ access_token: string; expires_in: number }>('access_token', undefined, {
      grant_type: 'ig_exchange_token',
      client_secret: clientSecret,
      access_token: shortData.access_token,
    });

    // Step 3: Fetch Instagram user profile
    // user_id is the professional account ID that webhooks send as entry.id; id is app-scoped.
    const profile = await instagramRequest<{ id: string; username: string; user_id?: string | number }>(
      'me',
      long.access_token,
      { fields: 'id,username,user_id' },
    );

    if (!profile.id || !profile.username || !long.access_token || !Number.isFinite(long.expires_in)) {
      throw new Error('Invalid Instagram OAuth profile response');
    }

    // Switching to a different Instagram account replaces the old connection; one Instagram account may belong to only one RB Post user.
    const { data: owner, error } = await db()
      .from('social_accounts')
      .select('id,status')
      .eq('platform', 'instagram')
      .eq('platform_user_id', profile.id)
      .neq('user_id', userId)
      .maybeSingle();
    checkDB(error);

    if (owner && owner.status !== 'disconnected') {
      return NextResponse.redirect(`${appUrl()}/connections?error=account_in_use`);
    }
    if (owner) {
      const released = await db().from('social_accounts').delete().eq('id', owner.id).eq('status', 'disconnected');
      checkDB(released.error);
    }

    const saved = await db()
      .from('social_accounts')
      .upsert(
        {
          user_id: userId,
          platform: 'instagram',
          platform_user_id: profile.id,
          provider_account_id: profile.user_id ? String(profile.user_id) : null,
          username: profile.username,
          access_token_encrypted: encryptToken(long.access_token, userId, env('TOKEN_ENCRYPTION_KEY')),
          expires_at: new Date(Date.now() + long.expires_in * 1000).toISOString(),
          status: 'connected',
          scopes,
          webhooks_subscribed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform' },
      );
    checkDB(saved.error);

    // Webhook delivery is best-effort at connect time; enabling an automation retries it.
    if (scopes.includes('instagram_business_manage_comments') || scopes.includes('instagram_business_manage_messages'))
      try {
        await subscribeInstagramWebhooks(long.access_token);
        const marked = await db()
          .from('social_accounts')
          .update({ webhooks_subscribed_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('platform', 'instagram');
        checkDB(marked.error);
      } catch (e) {
        await logTechnical(userId, null, 'instagram_webhook_subscribe_failed', errorSummary(e));
      }

    return NextResponse.redirect(`${appUrl()}/connections?connected=instagram`);
  } catch (e) {
    const summary = errorSummary(e);
    console.error(JSON.stringify({ event: 'oauth_failed', platform: 'instagram', ...summary }));
    await logTechnical(userId, null, 'instagram_oauth_failed', summary);
    return NextResponse.redirect(`${appUrl()}/connections?error=connection`);
  }
}

export async function refreshInstagramToken(token: string) {
  // Long-lived Instagram tokens are refreshed on the unversioned host with the token as a query parameter.
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000), cache: 'no-store' });
  const value = await response.json();
  if (!response.ok || value.error || !value.access_token || !Number.isFinite(value.expires_in)) {
    throw new InstagramError(response.status, value.error?.code || null, value);
  }
  return value as { access_token: string; expires_in: number };
}

/**
 * `beforePublish` runs immediately before the irreversible media_publish call so the caller can
 * persist a publish-attempt marker; a failure after that point must never be retried automatically.
 */
export interface InstagramPublishOptions {
  beforePublish?: () => Promise<void>;
  /** Reuse a container created by an earlier attempt instead of uploading the image again. */
  containerId?: string | null;
  onContainer?: (id: string) => Promise<void>;
  /** Status checks, 2 s apart, before giving up with `media_pending`. */
  polls?: number;
}

export async function processInstagramPublish(
  post: Post & { user_id: string },
  { beforePublish, containerId, onContainer, polls = 5 }: InstagramPublishOptions = {},
): Promise<string> {
  if (!post.image_url) {
    throw new AppError('Instagram memerlukan gambar untuk setiap penerbitan post.', 400, 'image_required');
  }

  const { data: account, error } = await db()
    .from('social_accounts')
    .select('*')
    .eq('user_id', post.user_id)
    .eq('platform', 'instagram')
    .maybeSingle();
  checkDB(error);

  if (
    !account ||
    account.status !== 'connected' ||
    !account.access_token_encrypted ||
    Date.parse(account.expires_at) <= Date.now()
  ) {
    throw new AppError('Sila sambungkan semula akaun Instagram anda.', 409, 'reconnect_instagram');
  }

  const token = decryptToken(account.access_token_encrypted, post.user_id, env('TOKEN_ENCRYPTION_KEY'));

  // Step 1: Create Instagram container (or reuse the one from a previous attempt)
  let container = containerId ? { id: containerId } : null;
  if (!container) {
    const publicImg = await instagramImageUrl(post.image_url, post.user_id);
    container = await instagramRequest<{ id: string }>(
      `${account.platform_user_id}/media`,
      token,
      {
        image_url: publicImg,
        caption: post.caption,
      },
      'POST',
    );
    if (!container.id) {
      throw new Error('Missing Instagram container ID');
    }
    await onContainer?.(container.id);
  }

  // Step 2: Poll status
  let finished = false;
  for (let i = 0; i < polls; i++) {
    const status = await instagramRequest<{ status_code?: string; error_message?: string }>(container.id, token, {
      fields: 'status_code,error_message',
    });
    if (status.status_code === 'FINISHED') {
      finished = true;
      break;
    }
    if (status.status_code === 'ERROR') {
      throw new AppError(status.error_message || 'Pemprosesan gambar Instagram gagal.', 502, 'media_failed');
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!finished) {
    // Still processing: the caller decides whether to retry later or give up.
    throw new AppError('Gambar Instagram masih diproses.', 502, 'media_pending');
  }

  // Step 3: Publish container
  await beforePublish?.();
  const published = await instagramRequest<{ id: string }>(
    `${account.platform_user_id}/media_publish`,
    token,
    { creation_id: container.id },
    'POST',
  );

  if (!published.id) {
    throw new Error('Instagram publication failed');
  }

  return published.id;
}
