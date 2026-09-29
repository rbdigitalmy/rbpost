import test, { afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { encryptToken } from '../src/lib/crypto';
import { InstagramError, ThreadsError, errorSummary, reconnectPlatform } from '../src/lib/provider-errors';

// Server modules read configuration at call time; point them at fake hosts that the fetch mock below answers.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');

let refreshInstagramToken: typeof import('../src/lib/server/instagram').refreshInstagramToken;
let processInstagramPublish: typeof import('../src/lib/server/instagram').processInstagramPublish;
let instagramImageUrl: typeof import('../src/lib/server/images').instagramImageUrl;
let processPost: typeof import('../src/lib/server/threads').processPost;
let refreshTokens: typeof import('../src/lib/server/threads').refreshTokens;
before(async () => {
  ({ refreshInstagramToken, processInstagramPublish } = await import('../src/lib/server/instagram'));
  ({ instagramImageUrl } = await import('../src/lib/server/images'));
  ({ processPost, refreshTokens } = await import('../src/lib/server/threads'));
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

test('logged provider failures keep only a bounded summary, never the raw payload', () => {
  const payload = { error: { code: 100, type: 'OAuthException', message: 'x'.repeat(1000) }, client_secret: 'leak' };
  for (const e of [new ThreadsError(400, 100, payload), new InstagramError(400, 100, payload)]) {
    const summary = errorSummary(e);
    assert.equal(summary.type, 'provider');
    assert.equal((summary as { provider_type: string }).provider_type, 'OAuthException');
    assert.equal('provider_message' in summary, false, 'provider text can echo user content');
    assert.doesNotMatch(JSON.stringify(summary), /leak/);
    assert.doesNotMatch(e.message, /leak/);
  }
  assert.deepEqual(errorSummary(new TypeError('secret detail')), { type: 'internal', name: 'TypeError' });
});

/** Runs a Threads + Instagram post; Threads always succeeds, `instagram` answers the Instagram Graph calls. */
async function crossPost(instagram: (url: URL, init: RequestInit) => Response | undefined) {
  const patches: { table: string; body: Record<string, unknown> }[] = [];
  const rpcs: { name: string; body: Record<string, unknown> }[] = [];
  mockFetch(async (url, init) => {
    if (url.host === 'graph.threads.net') {
      if (url.pathname.endsWith('/threads')) return json({ id: 'th-container' });
      if (url.pathname.endsWith('/th-container')) return json({ status: 'FINISHED' });
      if (url.pathname.endsWith('/threads_publish')) return json({ id: 'th-post' });
      return undefined;
    }
    if (url.host === 'graph.instagram.com') return instagram(url, init);
    if (url.host !== 'supabase.test') return undefined;
    const single = String(new Headers(init.headers).get('accept')).includes('vnd.pgrst.object');
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {};
    if (url.pathname === '/rest/v1/subscriptions') {
      const row = { status: 'active', current_period_end: new Date(Date.now() + 86_400_000).toISOString() };
      return json(single ? row : [row]);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      rpcs.push({ name: url.pathname.split('/').pop()!, body });
      return new Response(null, { status: 204 });
    }
    if (init.method === 'PATCH') {
      patches.push({ table: url.pathname.split('/').pop()!, body });
      return single ? json({ id: 'row' }) : json([{ id: 'row' }]);
    }
    if (url.pathname === '/rest/v1/technical_errors') return new Response(null, { status: 201 });
    return supabase(url, init);
  });
  await processPost({
    ...post({ platform: 'both' }),
    social_account_id: null,
    container_id: null,
    attempts: 1,
    publish_attempted_at: null,
  } as Parameters<typeof processPost>[0]);
  const completed = rpcs.find(r => r.name === 'complete_publish');
  assert.equal(completed?.body.p_platform_id, 'th-post', 'Threads publish is recorded');
  const flagged = patches.find(p => p.table === 'posts' && p.body.error_code === 'instagram_failed');
  assert.ok(flagged, 'the Instagram failure is recorded on the published post');
  return { message: String(flagged.body.error_message), patches };
}

test('cross-posting reports Instagram as uncertain only after media_publish was actually called', async () => {
  const graph = (status: string, publish?: Response) => (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: 'container-1' });
    if (url.pathname.endsWith('/container-1')) return json({ status_code: status, error_message: 'Bad image' });
    if (url.pathname.endsWith('/media_publish')) return publish;
    return undefined;
  };

  // Processing error before publishing: definitely not on Instagram, and the real reason is shown.
  let { message } = await crossPost(graph('ERROR'));
  assert.match(message, /Instagram gagal: Bad image/);
  assert.doesNotMatch(message, /belum pasti/);

  // media_publish was called and failed: the outcome really is unknown.
  ({ message } = await crossPost(graph('FINISHED', json({ error: { code: 1, message: 'boom' } }, 500))));
  assert.match(message, /belum pasti/);

  // Rejected before publishing (no reconnect needed): not published, safe to retry.
  ({ message } = await crossPost(() => json({ error: { code: 100, message: 'Invalid parameter' } }, 400)));
  assert.match(message, /Instagram gagal diterbitkan; cuba terbitkan ke Instagram semula/);

  // Expired Instagram token: ask to reconnect Instagram only.
  let patches: { table: string; body: Record<string, unknown> }[];
  ({ message, patches } = await crossPost(() => json({ error: { code: 190, message: 'expired' } }, 400)));
  assert.match(message, /sambungkan semula akaun Instagram/);
  assert.ok(patches.some(p => p.table === 'social_accounts' && p.body.status === 'reconnect'));
});

test('cross-posting reports still-processing Instagram media as not published, not uncertain', async () => {
  const realSetTimeout = globalThis.setTimeout;
  // Skip the 15 × 2 s status polls.
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
  try {
    const { message } = await crossPost((url, init) => {
      if (url.pathname.endsWith('/media') && init.method === 'POST') return json({ id: 'container-1' });
      if (url.pathname.endsWith('/container-1')) return json({ status_code: 'IN_PROGRESS' });
      return undefined;
    });
    assert.match(message, /masih diproses/);
    assert.doesNotMatch(message, /belum pasti/);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/media_publish')).length, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('token refresh covers every expiring account, not just the first 50, and never loops on a stuck row', async () => {
  const key = process.env.TOKEN_ENCRYPTION_KEY!;
  const soon = Date.now() + 86_400_000;
  const accounts = Array.from({ length: 120 }, (_, i) => {
    const owner = randomUUID();
    return {
      id: randomUUID(),
      user_id: owner,
      platform: i % 2 ? 'instagram' : 'threads',
      access_token_encrypted: encryptToken(`token-${i}`, owner, key),
      expires_at: new Date(soon + i * 60_000).toISOString(),
      status: 'connected',
    };
  });
  // Every write to this account fails, so it stays "connected and expiring" for the whole run.
  const stuck = accounts[7].id;
  mockFetch(async (url, init) => {
    if (url.pathname.endsWith('refresh_access_token')) return json({ access_token: 'fresh', expires_in: 5_184_000 });
    if (url.host !== 'supabase.test') return undefined;
    if (url.pathname === '/rest/v1/social_accounts' && init.method === 'GET') {
      const before = Date.parse(url.searchParams.get('expires_at')!.replace(/^lt\./, ''));
      const rows = accounts
        .filter(a => a.status === 'connected' && Date.parse(a.expires_at) < before)
        .sort((a, b) => a.expires_at.localeCompare(b.expires_at))
        .slice(0, Number(url.searchParams.get('limit')));
      return json(rows);
    }
    if (url.pathname === '/rest/v1/social_accounts' && init.method === 'PATCH') {
      const id = url.searchParams.get('id')!.replace(/^eq\./, '');
      if (id === stuck) return json({ message: 'write failed', code: 'XX000' }, 500);
      Object.assign(
        accounts.find(a => a.id === id)!,
        JSON.parse(String(init.body)),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/rest/v1/rpc/orphan_images') return json([]);
    return new Response(null, { status: init.method === 'POST' ? 201 : 204 });
  });

  const result = await refreshTokens();
  assert.equal(result.refreshed, 119);
  const pending = accounts.filter(a => a.id !== stuck && Date.parse(a.expires_at) < soon + 86_400_000);
  assert.equal(pending.length, 0, 'every other account now expires in ~60 days');
  const tokenRequests = calls.filter(c => c.url.pathname.endsWith('refresh_access_token')).length;
  assert.equal(tokenRequests, 120, 'each account is refreshed exactly once, including the stuck one');
});
