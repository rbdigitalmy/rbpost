import test, { afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { encryptToken } from '../src/lib/crypto';
import { InstagramError, ThreadsError, reconnectPlatform } from '../src/lib/provider-errors';

// Server modules read configuration at call time; point them at fake hosts that the fetch mock below answers.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');

let refreshInstagramToken: typeof import('../src/lib/server/instagram').refreshInstagramToken;
let processInstagramPublish: typeof import('../src/lib/server/instagram').processInstagramPublish;
let instagramImageUrl: typeof import('../src/lib/server/images').instagramImageUrl;
before(async () => {
  ({ refreshInstagramToken, processInstagramPublish } = await import('../src/lib/server/instagram'));
  ({ instagramImageUrl } = await import('../src/lib/server/images'));
});

type Handler = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;
const realFetch = globalThis.fetch;
const calls: { method: string; url: URL; body?: unknown }[] = [];
function mockFetch(handler: Handler) {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    calls.push({ method, url, body: init.body });
    const response = await handler(url, { ...init, method });
    if (!response) throw new Error(`Unexpected request: ${method} ${url}`);
    return response;
  }) as typeof fetch;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

const user = randomUUID();
const imageUrl = (file: string) => `/api/media?path=${encodeURIComponent(`${user}/${file}`)}`;

/** Answers Supabase storage (sign/download/upload) and the social_accounts lookup. */
function supabase(url: URL, init: RequestInit, png?: Buffer): Response | undefined {
  if (url.host !== 'supabase.test') return undefined;
  if (url.pathname.startsWith('/storage/v1/object/sign/'))
    return json({ signedURL: `${url.pathname.replace('/storage/v1', '')}?token=signed` });
  if (url.pathname.includes('/storage/v1/object/') && init.method === 'GET' && png)
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  if (url.pathname.includes('/storage/v1/object/') && (init.method === 'POST' || init.method === 'PUT'))
    return json({ Id: '1', Key: url.pathname });
  if (url.pathname === '/rest/v1/social_accounts') {
    const row = {
      platform_user_id: 'ig-user',
      status: 'connected',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      access_token_encrypted: encryptToken('ig-token', user, process.env.TOKEN_ENCRYPTION_KEY!),
    };
    const single = String(new Headers(init.headers).get('accept')).includes('vnd.pgrst.object');
    return json(single ? row : [row]);
  }
  return undefined;
}

test('reconnect is flagged only for the platform whose token failed', () => {
  assert.equal(reconnectPlatform(new ThreadsError(400, 190)), 'threads');
  assert.equal(reconnectPlatform(new InstagramError(401, null)), 'instagram');
  assert.equal(reconnectPlatform(new InstagramError(400, 100)), null);
  assert.equal(reconnectPlatform({ code: 'reconnect_instagram' }), 'instagram');
  assert.equal(reconnectPlatform({ code: 'reconnect' }), 'threads');
  assert.equal(reconnectPlatform(new Error('network')), null);
});

test('Instagram tokens refresh through the Instagram endpoint, not Threads', async () => {
  mockFetch(url =>
    url.host === 'graph.instagram.com' ? json({ access_token: 'new-token', expires_in: 5_184_000 }) : undefined,
  );
  const next = await refreshInstagramToken('old-token');
  assert.deepEqual(next, { access_token: 'new-token', expires_in: 5_184_000 });
  assert.equal(calls[0].url.pathname, '/refresh_access_token');
  assert.equal(calls[0].url.searchParams.get('grant_type'), 'ig_refresh_token');
  assert.equal(calls[0].url.searchParams.get('access_token'), 'old-token');

  mockFetch(() => json({ error: { code: 190, message: 'expired' } }, 400));
  await assert.rejects(refreshInstagramToken('old-token'), (e: unknown) => reconnectPlatform(e) === 'instagram');
});

test('PNG images are converted to a JPEG sibling before Instagram sees them', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff000080' } })
    .png()
    .toBuffer();
  const file = randomUUID();
  let uploaded: { path: string; bytes: Buffer } | undefined;
  mockFetch(async (url, init) => {
    if (url.pathname.includes('/storage/v1/object/') && init.method !== 'GET' && !url.pathname.includes('/sign/'))
      uploaded = { path: url.pathname, bytes: Buffer.from(await new Response(init.body).arrayBuffer()) };
    return supabase(url, init, png);
  });
  const signed = await instagramImageUrl(imageUrl(`${file}.png`), user);
  assert.ok(uploaded, 'converted image was uploaded');
  assert.ok(uploaded.path.endsWith(`${user}/${file}.jpg`), uploaded.path);
  assert.equal((await sharp(uploaded.bytes).metadata()).format, 'jpeg');
  assert.match(signed, new RegExp(`${file}\\.jpg\\?token=signed$`));

  // Already JPEG: signed directly, nothing downloaded or re-uploaded.
  calls.length = 0;
  mockFetch((url, init) => supabase(url, init));
  await instagramImageUrl(imageUrl(`${file}.jpg`), user);
  assert.deepEqual(
    calls.map(c => c.url.pathname.split('/').slice(0, 5).join('/')),
    ['/storage/v1/object/sign'],
  );
});

function instagramGraph(status: string) {
  return (url: URL, init: RequestInit) => {
    if (url.host !== 'graph.instagram.com') return supabase(url, init);
    if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: 'container-1' });
    if (url.pathname.endsWith('/media_publish')) return json({ id: 'ig-post-1' });
    if (url.pathname.endsWith('/container-1')) return json({ status_code: status });
    return undefined;
  };
}
const post = (extra: object = {}) =>
  ({
    id: randomUUID(),
    user_id: user,
    title: 'Post',
    caption: 'Hello',
    image_url: imageUrl(`${randomUUID()}.jpg`),
    image_prompt: '',
    timezone: 'UTC',
    platform: 'instagram',
    status: 'publishing',
    scheduled_at: null,
    published_at: null,
    created_at: '',
    updated_at: '',
    ...extra,
  }) as Parameters<typeof import('../src/lib/server/instagram').processInstagramPublish>[0];

test('the publish-attempt marker is written before the irreversible Instagram publish call', async () => {
  mockFetch(instagramGraph('FINISHED'));
  const order: string[] = [];
  const saved: string[] = [];
  const id = await processInstagramPublish(post(), {
    onContainer: async c => void saved.push(c),
    beforePublish: async () => {
      order.push(`marker-before-${calls.filter(c => c.url.pathname.endsWith('/media_publish')).length}-publishes`);
    },
  });
  assert.equal(id, 'ig-post-1');
  assert.deepEqual(order, ['marker-before-0-publishes']);
  assert.deepEqual(saved, ['container-1']);

  // If the marker cannot be saved, Instagram must never be asked to publish.
  calls.length = 0;
  mockFetch(instagramGraph('FINISHED'));
  await assert.rejects(
    processInstagramPublish(post(), {
      beforePublish: async () => {
        throw new Error('db down');
      },
    }),
    /db down/,
  );
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/media_publish')).length, 0);
});

test('slow Instagram processing reuses the saved container and reports media_pending instead of failing', async () => {
  mockFetch(instagramGraph('IN_PROGRESS'));
  await assert.rejects(
    processInstagramPublish(post(), { containerId: 'container-1', polls: 1 }),
    (e: unknown) => (e as { code?: string }).code === 'media_pending',
  );
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/media') && c.method === 'POST').length, 0);
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/media_publish')).length, 0);
});
