import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { encryptToken, decryptToken } from '../crypto';
import { type Post } from '../domain';
import { AppError, appUrl, db, env, checkDB, requireSubscription, logTechnical } from './core';
import { publishImageUrl } from './images';

const GRAPH_URL = 'https://graph.instagram.com/v21.0';

export class InstagramError extends Error {
  constructor(public status: number, public providerCode: number | null) {
    super('Instagram request failed');
  }
}

export async function instagramRequest<T>(
  path: string,
  token: string | undefined,
  params: Record<string, string> = {},
  method = 'GET'
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
  const value = await response.json();
  if (!response.ok || value.error) {
    throw new InstagramError(response.status, value.error?.code || null);
  }
  return value as T;
}

export async function startInstagram(userId: string) {
  await requireSubscription(userId);
  const clientId = process.env.INSTAGRAM_APP_ID || env('META_APP_ID');
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

  const url = new URL('https://api.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_content_publish',
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
    return NextResponse.redirect(`${appUrl()}/connections?error=cancelled`);
  }

  try {
    await requireSubscription(userId);
    const clientId = process.env.INSTAGRAM_APP_ID || env('META_APP_ID');
    const clientSecret = process.env.INSTAGRAM_APP_SECRET || env('META_APP_SECRET');
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
    const shortData = await short.json();
    if (!short.ok || !shortData.access_token) {
      console.error('Instagram short token failed:', { status: short.status, body: shortData });
      throw new Error(`Short token failed: ${JSON.stringify(shortData)}`);
    }

    // Step 2: Exchange for long-lived access token
    const long = await instagramRequest<{ access_token: string; expires_in: number }>(
      'access_token',
      shortData.access_token,
      {
        grant_type: 'ig_exchange_token',
        client_secret: clientSecret,
      }
    );

    // Step 3: Fetch Instagram user profile
    const profile = await instagramRequest<{ id: string; username: string }>(
      'me',
      long.access_token,
      { fields: 'id,username' }
    );

    if (!profile.id || !profile.username || !long.access_token || !Number.isFinite(long.expires_in)) {
      throw new Error('Invalid Instagram OAuth profile response');
    }

    const { data: old, error } = await db()
      .from('social_accounts')
      .select('platform_user_id')
      .eq('user_id', userId)
      .eq('platform', 'instagram')
      .maybeSingle();
    checkDB(error);

    if (old && old.platform_user_id !== profile.id) {
      return NextResponse.redirect(`${appUrl()}/connections?error=different_account`);
    }

    const saved = await db().from('social_accounts').upsert(
      {
        user_id: userId,
        platform: 'instagram',
        platform_user_id: profile.id,
        username: profile.username,
        access_token_encrypted: encryptToken(long.access_token, userId, env('TOKEN_ENCRYPTION_KEY')),
        expires_at: new Date(Date.now() + long.expires_in * 1000).toISOString(),
        status: 'connected',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,platform' }
    );
    checkDB(saved.error);

    return NextResponse.redirect(`${appUrl()}/connections?connected=instagram`);
  } catch (e) {
    console.error('finishInstagram error:', e);
    await logTechnical(userId, null, 'instagram_oauth_failed', {
      type: e instanceof InstagramError ? 'provider' : 'internal',
      message: (e as Error).message,
      details: String(e)
    });
    return NextResponse.redirect(`${appUrl()}/connections?error=connection`);
  }
}

export async function processInstagramPublish(post: Post & { user_id: string }): Promise<string> {
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

  if (!account || account.status !== 'connected' || !account.access_token_encrypted || Date.parse(account.expires_at) <= Date.now()) {
    throw new AppError('Sila sambungkan semula akaun Instagram anda.', 409, 'reconnect_instagram');
  }

  const token = decryptToken(account.access_token_encrypted, post.user_id, env('TOKEN_ENCRYPTION_KEY'));
  const publicImg = await publishImageUrl(post.image_url, post.user_id);

  // Step 1: Create Instagram container
  const container = await instagramRequest<{ id: string }>(
    `${account.platform_user_id}/media`,
    token,
    {
      image_url: publicImg,
      caption: post.caption,
    },
    'POST'
  );

  if (!container.id) {
    throw new Error('Missing Instagram container ID');
  }

  // Step 2: Poll status
  let finished = false;
  for (let i = 0; i < 5; i++) {
    const status = await instagramRequest<{ status_code?: string; error_message?: string }>(
      container.id,
      token,
      { fields: 'status_code,error_message' }
    );
    if (status.status_code === 'FINISHED') {
      finished = true;
      break;
    }
    if (status.status_code === 'ERROR') {
      throw new AppError(status.error_message || 'Pemprosesan gambar Instagram gagal.', 502, 'media_failed');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!finished) {
    throw new AppError('Gambar Instagram mengambil masa terlalu lama untuk diproses. Sila cuba lagi sebentar.', 502, 'media_timeout');
  }

  // Step 3: Publish container
  const published = await instagramRequest<{ id: string }>(
    `${account.platform_user_id}/media_publish`,
    token,
    { creation_id: container.id },
    'POST'
  );

  if (!published.id) {
    throw new Error('Instagram publication failed');
  }

  return published.id;
}
