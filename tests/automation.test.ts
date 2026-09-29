import test, { afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encryptToken } from '../src/lib/crypto';
import {
  grantedCapabilities,
  instagramScopes,
  keywordDecision,
  missingScopes,
  parseGrantedScopes,
  reconnectRequired,
  threadsScopes,
} from '../src/lib/automation';
import { InstagramError, ThreadsError, classifyFailure } from '../src/lib/provider-errors';

// Server modules read configuration at call time; point them at fake hosts answered by the fetch mock below.
const INSTAGRAM_SECRET = 'ig-app-secret-' + randomBytes(8).toString('hex');
const THREADS_SECRET = 'threads-app-secret-' + randomBytes(8).toString('hex');
const SERVICE_KEY = 'service-role-' + randomBytes(8).toString('hex');
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.INSTAGRAM_APP_SECRET = INSTAGRAM_SECRET;
process.env.META_APP_SECRET = THREADS_SECRET;
process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';

type Automation = typeof import('../src/lib/server/automation');
let automation: Automation;
let automationRoutes: typeof import('../src/lib/server/api/automations').automationRoutes;
before(async () => {
  automation = await import('../src/lib/server/automation');
  ({ automationRoutes } = await import('../src/lib/server/api/automations'));
});

// ------------------------------------------------------------------------------------------------------------
// A small in-memory PostgREST: enough of supabase-js's wire format (filters, single/maybeSingle, count, upsert)
// for the automation code paths. Database semantics themselves are tested against Postgres in database.test.ts.
// ------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let rpcCalls: { name: string; args: Row }[];
let providerCalls: { method: string; url: URL; body: string }[];
let order: string[];
let rpcHandlers: Record<string, (args: Row) => unknown>;
let graph: (url: URL, method: string, body: string) => Response | undefined;

function matches(row: Row, key: string, raw: string): boolean {
  if (key === 'or') {
    return raw
      .slice(1, -1)
      .split(/,(?![^(]*\))/)
      .some(part => {
        const [col, ...rest] = part.split('.');
        return matches(row, col, rest.join('.'));
      });
  }
  const [op, ...rest] = raw.split('.');
  const value = rest.join('.');
  const cell = row[key];
  const text = cell === null || cell === undefined ? null : String(cell);
  switch (op) {
    case 'eq':
      return text === value;
    case 'neq':
      return text !== value;
    case 'is':
      return value === 'null' ? cell === null || cell === undefined : String(cell) === value;
    case 'in':
      return value
        .slice(1, -1)
        .split(',')
        .map(v => v.replace(/^"|"$/g, ''))
        .includes(text || '');
    case 'gte':
      return text !== null && Date.parse(text) >= Date.parse(value);
    case 'lt':
      return text !== null && Date.parse(text) < Date.parse(value);
    default:
      return true;
  }
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
function filtered(table: string, params: URLSearchParams) {
  let rows = tables[table] || (tables[table] = []);
  for (const [key, value] of params) if (!RESERVED.has(key)) rows = rows.filter(r => matches(r, key, value));
  const limit = Number(params.get('limit') || 0);
  return limit ? rows.slice(0, limit) : rows;
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

const realFetch = globalThis.fetch;
function install() {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
    if (url.host === 'supabase.test') {
      const headers = new Headers(init.headers);
      const single = String(headers.get('accept')).includes('vnd.pgrst.object');
      const table = url.pathname.replace('/rest/v1/', '');
      if (table.startsWith('rpc/')) {
        const name = table.slice(4);
        const args = body ? JSON.parse(body) : {};
        rpcCalls.push({ name, args });
        order.push(`rpc:${name}`);
        const handler = rpcHandlers[name];
        return handler ? json(handler(args)) : new Response(null, { status: 204 });
      }
      if (method === 'HEAD' || (method === 'GET' && String(headers.get('prefer')).includes('count=exact'))) {
        const n = filtered(table, url.searchParams).length;
        return new Response(null, { status: 200, headers: { 'content-range': `*/${n}` } });
      }
      if (method === 'GET') {
        const rows = filtered(table, url.searchParams);
        return single ? (rows[0] ? json(rows[0]) : json({ message: 'none' }, 406)) : json(rows);
      }
      if (method === 'PATCH') {
        const change = JSON.parse(body);
        const rows = filtered(table, url.searchParams);
        rows.forEach(r => Object.assign(r, change));
        order.push(`patch:${table}:${Object.keys(change).join(',')}`);
        return single ? json(rows[0] || null, rows[0] ? 200 : 406) : json(rows);
      }
      if (method === 'POST') {
        const incoming = [JSON.parse(body)].flat() as Row[];
        const conflict = url.searchParams.get('on_conflict')?.split(',');
        const ignore = String(headers.get('prefer')).includes('ignore-duplicates');
        const list = tables[table] || (tables[table] = []);
        const out: Row[] = [];
        for (const row of incoming) {
          const existing = conflict && list.find(r => conflict.every(c => String(r[c]) === String(row[c])));
          if (existing) {
            if (!ignore) Object.assign(existing, row);
            out.push(existing);
          } else {
            const saved = { id: randomUUID(), ...row };
            list.push(saved);
            out.push(saved);
          }
        }
        return single ? json(out[0]) : json(out, 201);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }
    providerCalls.push({ method, url, body });
    order.push(`provider:${method}:${url.pathname}`);
    const response = graph(url, method, body);
    if (!response) throw new Error(`Unexpected request: ${method} ${url}`);
    return response;
  }) as typeof fetch;
}

const alice = randomUUID(),
  bob = randomUUID();
const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
function account(user: string, platform: 'instagram' | 'threads', extra: Row = {}): Row {
  return {
    id: randomUUID(),
    user_id: user,
    platform,
    platform_user_id: platform === 'instagram' ? '9001' : '7001',
    provider_account_id: platform === 'instagram' ? '17841400000000001' : null,
    username: platform === 'instagram' ? 'alice.shop' : 'alice.threads',
    status: 'connected',
    expires_at: future(),
    access_token_encrypted: encryptToken(`${platform}-token-SECRET`, user, process.env.TOKEN_ENCRYPTION_KEY!),
    scopes: platform === 'instagram' ? [...instagramScopes] : [...threadsScopes],
    webhooks_subscribed_at: new Date().toISOString(),
    ...extra,
  };
}
function rule(acc: Row, extra: Row = {}): Row {
  return {
    id: randomUUID(),
    user_id: acc.user_id,
    social_account_id: acc.id,
    platform: acc.platform,
    enabled: true,
    comment_reply_enabled: acc.platform === 'instagram',
    comment_reply_template: 'Thanks for your comment!',
    private_reply_enabled: false,
    private_reply_template: 'Here is the link.',
    dm_reply_enabled: acc.platform === 'instagram',
    dm_reply_template: 'Thanks for your message!',
    threads_reply_enabled: acc.platform === 'threads',
    threads_reply_template: 'Thanks for replying!',
    keywords: [],
    exclude_keywords: [],
    cooldown_minutes: 60,
    threads_since: new Date(Date.now() - 86_400_000).toISOString(),
    threads_polled_at: null,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}
function run(acc: Row, event: Row, action: string, extra: Row = {}): Row {
  return {
    id: randomUUID(),
    user_id: acc.user_id,
    social_account_id: acc.id,
    event_id: event.id,
    action,
    recipient_id: event.sender_id,
    status: 'sending',
    attempts: 1,
    provider_container_id: null,
    send_attempted_at: null,
    ...extra,
  };
}
function inbound(acc: Row, kind: string, extra: Row = {}): Row {
  return {
    id: randomUUID(),
    user_id: acc.user_id,
    social_account_id: acc.id,
    kind,
    provider_event_id: kind === 'threads_reply' ? '555' : '18000000000000001',
    sender_id: '123456789',
    provider_created_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    ...extra,
  };
}

let logs: string[];
const realError = console.error,
  realLog = console.log;
beforeEach(() => {
  tables = {
    subscriptions: [
      { user_id: alice, status: 'active', current_period_end: future(), plan_id: 'starter' },
      { user_id: bob, status: 'active', current_period_end: future(), plan_id: 'starter' },
    ],
  };
  rpcCalls = [];
  providerCalls = [];
  order = [];
  logs = [];
  graph = () => undefined;
  rpcHandlers = {
    ingest_automation_event: () => [{ event_id: randomUUID(), inserted: true, event_status: 'queued', queued: 1 }],
    finish_automation_run: args => {
      const r = (tables.automation_runs || []).find(x => x.id === args.p_id);
      if (r) Object.assign(r, { status: args.p_status, error_code: args.p_error_code });
      return true;
    },
  };
  console.error = (...args: unknown[]) => void logs.push(args.map(a => JSON.stringify(a) ?? String(a)).join(' '));
  console.log = (...args: unknown[]) => void logs.push(args.map(a => JSON.stringify(a) ?? String(a)).join(' '));
  install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.log = realLog;
});
const finished = () => rpcCalls.filter(c => c.name === 'finish_automation_run').map(c => c.args);
const technical = () => JSON.stringify(tables.technical_errors || []);

// ------------------------------------------------------------------------------------------------------------
// OAuth scopes and reconnect state
// ------------------------------------------------------------------------------------------------------------

test('OAuth requests every required Instagram and Threads scope', () => {
  assert.deepEqual(
    [...instagramScopes],
    [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_messages',
    ],
  );
  assert.deepEqual(
    [...threadsScopes],
    ['threads_basic', 'threads_content_publish', 'threads_read_replies', 'threads_manage_replies'],
  );
  // The authorize URLs are built from these lists, not from a hard-coded older scope string.
  assert.match(readFileSync('src/lib/server/instagram.ts', 'utf8'), /scope: instagramScopes\.join\(','\)/);
  assert.match(readFileSync('src/lib/server/threads.ts', 'utf8'), /scope: threadsScopes\.join\(','\)/);
});

test('legacy connections show reconnect-required; granted scopes decide capabilities', () => {
  assert.equal(reconnectRequired({ platform: 'instagram', scopes: null }), true);
  assert.equal(
    reconnectRequired({
      platform: 'instagram',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    }),
    true,
  );
  assert.equal(reconnectRequired({ platform: 'instagram', scopes: [...instagramScopes] }), false);
  assert.equal(reconnectRequired({ platform: 'threads', scopes: ['threads_basic', 'threads_content_publish'] }), true);
  assert.deepEqual(missingScopes('threads', ['threads_basic', 'threads_content_publish']), [
    'threads_read_replies',
    'threads_manage_replies',
  ]);
  assert.deepEqual(grantedCapabilities('instagram', null), []);
  assert.deepEqual(
    grantedCapabilities('instagram', ['instagram_business_basic', 'instagram_business_manage_messages']),
    ['messages'],
  );
  // Instagram reports grants as a comma string (or array); unknown values are ignored.
  assert.deepEqual(
    parseGrantedScopes('instagram_business_basic,instagram_business_manage_comments,other', instagramScopes),
    ['instagram_business_basic', 'instagram_business_manage_comments'],
  );
  assert.deepEqual(parseGrantedScopes(['instagram_business_basic'], instagramScopes), ['instagram_business_basic']);
});

// ------------------------------------------------------------------------------------------------------------
// Webhook verification and parsing
// ------------------------------------------------------------------------------------------------------------

const sign = (body: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
function webhookRequest(platform: string, body: string, signature: string | null) {
  return new Request(`https://app.test/api/webhooks/${platform}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body,
  });
}

test('webhook verification echoes the challenge only for the configured token', async () => {
  const ok = automation.webhookChallenge(
    new Request(
      'https://app.test/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
    ),
  );
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  for (const query of [
    'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    'hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1',
    'hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=<script>',
  ])
    assert.equal(automation.webhookChallenge(new Request(`https://app.test/x?${query}`)).status, 403);
});

test('signatures are checked over the raw bytes with the app secret; anything else is rejected', async () => {
  const body = JSON.stringify({ object: 'instagram', entry: [] });
  const raw = Buffer.from(body);
  const secrets = automation.webhookSecrets('instagram');
  assert.equal(automation.validSignature(raw, sign(body, INSTAGRAM_SECRET), secrets), true);
  assert.equal(automation.validSignature(raw, sign(body, 'wrong-secret'), secrets), false);
  assert.equal(automation.validSignature(Buffer.from(body + ' '), sign(body, INSTAGRAM_SECRET), secrets), false);
  assert.equal(automation.validSignature(raw, null, secrets), false);
  assert.equal(automation.validSignature(raw, 'sha1=abc', secrets), false);
  // A byte-level change that survives JSON parsing (escaped vs raw unicode) still fails.
  const escaped = JSON.stringify({ text: 'é' }).replace('é', '\\u00e9');
  assert.equal(
    automation.validSignature(Buffer.from(escaped), sign(JSON.stringify({ text: 'é' }), INSTAGRAM_SECRET), secrets),
    false,
  );

  await assert.rejects(
    automation.receiveWebhook('instagram', webhookRequest('instagram', body, sign(body, 'attacker'))),
    (e: unknown) => (e as { status?: number }).status === 401,
  );
  await assert.rejects(
    automation.receiveWebhook('instagram', webhookRequest('instagram', body, null)),
    (e: unknown) => (e as { status?: number }).status === 401,
  );
  assert.equal(rpcCalls.length, 0, 'nothing is recorded for an unsigned delivery');
});

const commentPayload = (commentId: string, extra: Row = {}) => ({
  object: 'instagram',
  entry: [
    {
      id: '17841400000000001',
      time: Math.floor(Date.now() / 1000),
      changes: [
        {
          field: 'comments',
          value: {
            id: commentId,
            from: { id: '123456789', username: 'fan' },
            text: 'Love this! price?',
            media: { id: '1799', media_product_type: 'FEED' },
            ...extra,
          },
        },
      ],
    },
  ],
});

test('Instagram payloads: comments (both documented shapes), messages, echoes and nested comments', () => {
  const [comment] = automation.parseInstagramWebhook(commentPayload('c1'));
  assert.equal(comment.accountId, '17841400000000001');
  assert.equal(comment.event.kind, 'ig_comment');
  assert.equal(comment.event.senderId, '123456789');
  assert.equal(comment.event.nested, false);
  const flat = automation.parseInstagramWebhook([
    {
      object: 'instagram',
      entry: [
        { id: '1', time: 1, field: 'comments', value: { id: 'c2', from: { id: '2' }, text: 'hi', parent_id: 'c1' } },
      ],
    },
  ]);
  assert.equal(flat[0].event.nested, true);
  const messages = automation.parseInstagramWebhook({
    object: 'instagram',
    entry: [
      {
        id: '17841400000000001',
        messaging: [
          {
            sender: { id: '42' },
            recipient: { id: '17841400000000001' },
            timestamp: Date.now(),
            message: { mid: 'm1', text: 'hello' },
          },
          {
            sender: { id: '17841400000000001' },
            recipient: { id: '42' },
            timestamp: Date.now(),
            message: { mid: 'm2', text: 'hi', is_echo: true },
          },
          {
            sender: { id: '42' },
            recipient: { id: '1' },
            timestamp: Date.now(),
            reaction: { mid: 'm1', action: 'react' },
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    messages.map(m => [m.event.eventId, m.event.own]),
    [
      ['m1', false],
      ['m2', true],
    ],
  );
  const threads = automation.parseThreadsWebhook({
    values: { value: { id: 'r1', username: 'x', text: 'hi', replied_to: { id: 'r0' }, root_post: { id: 'p1' } } },
  });
  assert.equal(threads[0].rootId, 'p1');
  assert.equal(threads[0].event.nested, true, 'a reply to a reply is not top-level');
});

// ------------------------------------------------------------------------------------------------------------
// Decisions
// ------------------------------------------------------------------------------------------------------------

test('decisions: own content, disabled rules, nesting, keywords, exclusions, loop guard and permissions', () => {
  const acc = account(alice, 'instagram') as unknown as import('../src/lib/server/automation').AccountRow;
  const base = rule(acc as unknown as Row) as never;
  const event = (extra: Partial<import('../src/lib/server/automation').InboundEvent> = {}) => ({
    platform: 'instagram' as const,
    kind: 'ig_comment' as const,
    eventId: 'c1',
    senderId: '42',
    senderUsername: 'fan',
    text: 'What is the PRICE?',
    parentId: 'm1',
    createdAt: new Date(),
    nested: false,
    own: false,
    ...extra,
  });
  const d = (e = event(), r: Row = {}, a = acc) => automation.decide(e, a, { ...(base as Row), ...r } as never);
  assert.deepEqual(d(), { actions: ['comment_reply'], skip: null });
  assert.deepEqual(d(event(), { private_reply_enabled: true }).actions, ['comment_reply', 'private_reply']);
  assert.equal(d(event(), { enabled: false }).skip, 'disabled');
  assert.equal(d(event(), { comment_reply_enabled: false }).skip, 'disabled');
  assert.equal(d(event({ senderId: '9001' })).skip, 'own');
  assert.equal(d(event({ senderId: '17841400000000001' })).skip, 'own');
  assert.equal(d(event({ senderUsername: 'Alice.Shop' })).skip, 'own');
  assert.equal(d(event({ kind: 'ig_message', own: true })).skip, 'own');
  assert.equal(d(event({ nested: true })).skip, 'nested');
  assert.equal(d(event({ text: '   ' })).skip, 'unsupported');
  assert.deepEqual(d(event(), { keywords: ['price', 'cost'] }).actions, ['comment_reply']);
  assert.equal(d(event(), { keywords: ['discount'] }).skip, 'no_keyword');
  assert.equal(d(event(), { keywords: ['price'], exclude_keywords: ['what is'] }).skip, 'excluded');
  assert.equal(d(event({ text: 'Thanks for your  comment!' })).skip, 'loop_guard');
  assert.equal(
    d(event(), {}, { ...acc, scopes: ['instagram_business_basic', 'instagram_business_content_publish'] }).skip,
    'permission',
  );
  assert.deepEqual(d(event({ kind: 'ig_message' })).actions, ['dm_reply']);
  assert.equal(keywordDecision('Ｐｒｉｃｅ please', ['price'], []), 'match', 'full-width text is normalized');
});

test('provider failures are classified: transient, rate limit, permission, expired token, window, permanent', () => {
  const ig = (status: number, code: number | null, error: Row = {}) =>
    new InstagramError(status, code, { error: { code, ...error } });
  assert.equal(classifyFailure(ig(500, 2, { is_transient: true })), 'transient');
  assert.equal(classifyFailure(ig(400, 1)), 'transient');
  assert.equal(classifyFailure(ig(400, 4)), 'rate_limited');
  assert.equal(classifyFailure(ig(429, null)), 'rate_limited');
  assert.equal(classifyFailure(ig(400, 190)), 'expired_token');
  assert.equal(classifyFailure(ig(403, 10)), 'permission');
  assert.equal(classifyFailure(ig(400, 200)), 'permission');
  assert.equal(classifyFailure(ig(400, 10, { error_subcode: 2534022 })), 'policy_window');
  assert.equal(classifyFailure(ig(400, 10, { error_subcode: 2018278 })), 'policy_window');
  assert.equal(classifyFailure(ig(400, 100)), 'permanent');
  assert.equal(classifyFailure(new ThreadsError(400, 190)), 'expired_token');
  assert.equal(classifyFailure(new TypeError('fetch failed')), 'uncertain');
});

// ------------------------------------------------------------------------------------------------------------
// Webhook to queue
// ------------------------------------------------------------------------------------------------------------

test('a signed comment webhook queues replies without storing the comment text; disabled rules store nothing', async () => {
  const acc = account(alice, 'instagram');
  tables.social_accounts = [acc];
  tables.automation_rules = [rule(acc, { keywords: ['price'] })];
  const body = JSON.stringify(commentPayload('18000000000000001'));
  const result = await automation.receiveWebhook(
    'instagram',
    webhookRequest('instagram', body, sign(body, INSTAGRAM_SECRET)),
  );
  assert.deepEqual(result, { received: true, queued: 1 });
  const [call] = rpcCalls;
  assert.equal(call.name, 'ingest_automation_event');
  assert.deepEqual(call.args.p_actions, ['comment_reply']);
  assert.equal(call.args.p_user, alice);
  assert.equal(call.args.p_event_id, '18000000000000001');
  assert.doesNotMatch(JSON.stringify(call.args), /Love this/, 'message text is never sent to the database');

  // Duplicate delivery: the database reports it was already recorded, so nothing new is queued.
  rpcHandlers.ingest_automation_event = () => [{ event_id: 'e', inserted: false, event_status: 'queued', queued: 0 }];
  const again = await automation.receiveWebhook(
    'instagram',
    webhookRequest('instagram', body, sign(body, INSTAGRAM_SECRET)),
  );
  assert.equal(again.queued, 0);

  rpcCalls.length = 0;
  (tables.automation_rules[0] as Row).enabled = false;
  await automation.receiveWebhook('instagram', webhookRequest('instagram', body, sign(body, INSTAGRAM_SECRET)));
  assert.equal(rpcCalls.length, 0, 'disabled rule: no event row, no reply');

  rpcCalls.length = 0;
  const unknown = JSON.stringify({ ...commentPayload('c9'), entry: [{ ...commentPayload('c9').entry[0], id: '999' }] });
  await automation.receiveWebhook('instagram', webhookRequest('instagram', unknown, sign(unknown, INSTAGRAM_SECRET)));
  assert.equal(rpcCalls.length, 0, 'events for accounts that are not connected here are ignored');
});

// ------------------------------------------------------------------------------------------------------------
// Sending replies
// ------------------------------------------------------------------------------------------------------------

function setupRun(platform: 'instagram' | 'threads', action: string, eventExtra: Row = {}, ruleExtra: Row = {}) {
  const acc = account(alice, platform);
  const ev = inbound(
    acc,
    platform === 'threads' ? 'threads_reply' : action === 'dm_reply' ? 'ig_message' : 'ig_comment',
    eventExtra,
  );
  const r = run(acc, ev, action);
  tables.social_accounts = [acc];
  tables.automation_rules = [rule(acc, { private_reply_enabled: true, ...ruleExtra })];
  tables.inbound_social_events = [ev];
  tables.automation_runs = [r];
  return { acc, ev, r };
}

test('public comment reply is sent once, after the attempt marker is saved', async () => {
  const { r } = setupRun('instagram', 'comment_reply');
  graph = (url, method) =>
    method === 'POST' && url.pathname === '/v25.0/18000000000000001/replies' ? json({ id: 'reply-1' }) : undefined;
  await automation.processRun(r as never);
  assert.equal(providerCalls.length, 1);
  assert.equal(new URLSearchParams(providerCalls[0].body).get('message'), 'Thanks for your comment!');
  const marker = order.findIndex(o => o.startsWith('patch:automation_runs:send_attempted_at'));
  const send = order.findIndex(o => o.startsWith('provider:POST'));
  assert.ok(marker >= 0 && marker < send, 'attempt marker precedes the irreversible call');
  assert.deepEqual(
    finished().map(f => [f.p_status, f.p_result_id]),
    [['sent', 'reply-1']],
  );
});

test('permitted DM and private replies use the documented messages payloads', async () => {
  let { r } = setupRun('instagram', 'dm_reply');
  graph = (url, method) =>
    method === 'POST' && url.pathname === '/v25.0/me/messages' ? json({ message_id: 'mid.1' }) : undefined;
  await automation.processRun(r as never);
  assert.deepEqual(JSON.parse(providerCalls[0].body), {
    recipient: { id: '123456789' },
    message: { text: 'Thanks for your message!' },
  });
  assert.equal(finished()[0].p_status, 'sent');

  providerCalls.length = 0;
  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'private_reply'));
  await automation.processRun(r as never);
  assert.deepEqual(JSON.parse(providerCalls[0].body), {
    recipient: { comment_id: '18000000000000001' },
    message: { text: 'Here is the link.' },
  });
});

test('messages outside the allowed window are never sent or retried', async () => {
  // Expired before sending: 25 hours after the DM, 8 days after the comment.
  let { r } = setupRun('instagram', 'dm_reply', {
    provider_created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  });
  await automation.processRun(r as never);
  assert.equal(providerCalls.length, 0);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['failed', 'window_expired']);

  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'private_reply', {
    provider_created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
  }));
  await automation.processRun(r as never);
  assert.equal(providerCalls.length, 0);
  assert.equal(finished()[0].p_error_code, 'window_expired');

  // Meta says the window closed: permanent, no retry.
  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'dm_reply'));
  graph = () => json({ error: { code: 10, error_subcode: 2534022, message: 'outside window' } }, 400);
  await automation.processRun(r as never);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['failed', 'window_expired']);
});

test('transient failures retry with backoff until the limit; permanent failures and unknown outcomes do not', async () => {
  let { r } = setupRun('instagram', 'comment_reply');
  graph = () => json({ error: { code: 2, is_transient: true, message: 'Service temporarily unavailable' } }, 503);
  await automation.processRun(r as never);
  let f = finished()[0];
  assert.equal(f.p_status, 'retry');
  const delay = Date.parse(String(f.p_retry_at)) - Date.now();
  assert.ok(delay > 30_000 && delay <= 61_000, `first retry after about a minute (${delay})`);
  assert.equal(automation.retryDelay(3, 'transient'), 4 * 60_000);
  assert.equal(automation.retryDelay(2, 'rate_limited'), 10 * 60_000);

  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'comment_reply'));
  (r as Row).attempts = automation.MAX_ATTEMPTS;
  await automation.processRun(r as never);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['failed', 'retry_exhausted']);

  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'comment_reply'));
  graph = () => json({ error: { code: 100, message: 'Invalid parameter' } }, 400);
  await automation.processRun(r as never);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['failed', 'provider_rejected']);

  // No answer after the reply was sent: it may have been posted, so it is never sent again.
  rpcCalls.length = 0;
  ({ r } = setupRun('instagram', 'comment_reply'));
  graph = () => {
    throw new TypeError('fetch failed');
  };
  await automation.processRun(r as never);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['uncertain', 'outcome_unknown']);

  // Expired token: the account is flagged for reconnection.
  rpcCalls.length = 0;
  const setup = setupRun('instagram', 'comment_reply');
  graph = () => json({ error: { code: 190, message: 'expired' } }, 400);
  await automation.processRun(setup.r as never);
  assert.equal(finished()[0].p_error_code, 'reconnect');
  assert.equal(setup.acc.status, 'reconnect');
});

test('a rule switched off after an event arrived stops the queued reply', async () => {
  const { r } = setupRun('instagram', 'comment_reply', {}, { enabled: false });
  await automation.processRun(r as never);
  assert.equal(providerCalls.length, 0);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['skipped', 'disabled']);
});

test('per-recipient and per-account limits hold replies back', async () => {
  const { acc, r } = setupRun('instagram', 'comment_reply');
  const sent = (recipient: string) => ({
    id: randomUUID(),
    social_account_id: acc.id,
    recipient_id: recipient,
    status: 'sent',
    created_at: new Date().toISOString(),
  });
  tables.automation_runs.push(...Array.from({ length: automation.RECIPIENT_DAILY_LIMIT }, () => sent('123456789')));
  await automation.processRun(r as never);
  assert.deepEqual([finished()[0].p_status, finished()[0].p_error_code], ['skipped', 'recipient_limit']);

  rpcCalls.length = 0;
  tables.automation_runs = [
    r,
    ...Array.from({ length: automation.ACCOUNT_HOURLY_LIMIT }, (_, i) => sent(`other-${i}`)),
  ];
  await automation.processRun(r as never);
  assert.equal(finished()[0].p_status, 'defer', 'account limit postpones without spending an attempt');
  assert.equal(providerCalls.length, 0);
});

test('Threads replies use reply_to_id, then publish the container', async () => {
  const { r } = setupRun('threads', 'threads_reply');
  graph = (url, method, body) => {
    if (method === 'POST' && url.pathname === '/v1.0/7001/threads') {
      const params = new URLSearchParams(body);
      assert.equal(params.get('reply_to_id'), '555');
      assert.equal(params.get('media_type'), 'TEXT');
      assert.equal(params.get('text'), 'Thanks for replying!');
      return json({ id: 'container-9' });
    }
    if (url.pathname === '/v1.0/container-9') return json({ status: 'FINISHED' });
    if (method === 'POST' && url.pathname === '/v1.0/7001/threads_publish') {
      assert.equal(new URLSearchParams(body).get('creation_id'), 'container-9');
      return json({ id: 'reply-post-1' });
    }
    return undefined;
  };
  await automation.processRun(r as never);
  assert.deepEqual(
    finished().map(f => [f.p_status, f.p_result_id]),
    [['sent', 'reply-post-1']],
  );
  assert.equal((tables.automation_runs[0] as Row).provider_container_id, 'container-9');
});

test('Threads polling reads only replies newer than the checkpoint, skips own replies and advances it', async () => {
  const acc = account(alice, 'threads');
  const since = Date.now() - 3_600_000;
  tables.social_accounts = [acc];
  tables.automation_rules = [rule(acc, { threads_since: new Date(since).toISOString() })];
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, '+0000');
  let replies = [
    { id: 'r3', text: 'Great post', username: 'fan2', timestamp: iso(60_000), is_reply_owned_by_me: false },
    {
      id: 'r2',
      text: 'Thanks for replying!',
      username: 'alice.threads',
      timestamp: iso(120_000),
      is_reply_owned_by_me: true,
    },
    { id: 'r1', text: 'Before automation', username: 'fan1', timestamp: iso(7_200_000), is_reply_owned_by_me: false },
  ];
  graph = url => {
    if (url.pathname === '/v1.0/7001/threads')
      return json({ data: [{ id: 'post-1', timestamp: iso(86_400_000 / 2) }] });
    if (url.pathname === '/v1.0/post-1/replies') {
      assert.equal(url.searchParams.get('reverse'), 'true');
      // First page carries a cursor; the next page holds nothing newer.
      return url.searchParams.get('after')
        ? json({ data: [] })
        : json({ data: replies, paging: { cursors: { after: 'next' } } });
    }
    return undefined;
  };
  const first = await automation.pollThreadsReplies();
  assert.equal(first.polled, 1);
  const ingested = rpcCalls.filter(c => c.name === 'ingest_automation_event').map(c => c.args);
  assert.deepEqual(
    ingested.map(a => [a.p_event_id, a.p_skip]),
    [
      ['r2', 'own'],
      ['r3', null],
    ],
    'oldest first, the pre-automation reply is never read',
  );
  assert.equal(ingested[1].p_sender, 'fan2');
  const replyReads = providerCalls.filter(c => c.url.pathname.endsWith('/replies')).length;
  assert.equal(replyReads, 1, 'paging stops at the checkpoint');
  const checkpoint = tables.automation_checkpoints[0];
  assert.equal(Date.parse(String(checkpoint.last_reply_at)), Date.parse(replies[0].timestamp.replace('+0000', 'Z')));

  // Next poll with nothing new re-reads only the reply at the checkpoint; the database deduplicates it.
  rpcCalls.length = 0;
  (tables.automation_rules[0] as Row).threads_polled_at = null;
  replies = replies.slice(0, 1);
  await automation.pollThreadsReplies();
  assert.deepEqual(
    rpcCalls.filter(c => c.name === 'ingest_automation_event').map(c => c.args.p_event_id),
    ['r3'],
  );
});

// ------------------------------------------------------------------------------------------------------------
// API: tenant isolation and secrecy
// ------------------------------------------------------------------------------------------------------------

const apiUser = (id: string) => ({ id }) as never;
function apiRequest(method: string, path: string[], body?: unknown) {
  return {
    req: new Request('https://app.test/api/' + path.join('/'), {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
    method,
    path,
    route: path.join('/'),
    user: apiUser(alice),
  };
}

test('settings API never returns tokens or secrets, and cannot touch another tenant’s account', async () => {
  const mine = account(alice, 'instagram');
  const theirs = account(bob, 'instagram', { platform_user_id: '9002' });
  tables.social_accounts = [mine, theirs];
  tables.automation_rules = [rule(mine), rule(theirs)];
  tables.automation_runs = [];
  rpcHandlers.take_rate = () => true;
  const overview = await automationRoutes(apiRequest('GET', ['automations']));
  const text = await overview!.text();
  const list = JSON.parse(text);
  assert.equal(list.length, 1, 'only my accounts');
  assert.equal(list[0].reconnect_required, false);
  for (const secret of ['SECRET', 'access_token', SERVICE_KEY, INSTAGRAM_SECRET, THREADS_SECRET, bob])
    assert.doesNotMatch(text, new RegExp(secret));

  const input = { ...(rule(mine) as Row), enabled: true };
  await assert.rejects(
    automationRoutes(apiRequest('PATCH', ['automations', String(theirs.id)], input)),
    (e: unknown) => (e as { status?: number }).status === 404,
  );
  assert.equal((tables.automation_rules[1] as Row).enabled, true, 'other tenant untouched');

  // Legacy connection: enabling is refused until the account reconnects.
  (mine as Row).scopes = null;
  await assert.rejects(
    automationRoutes(apiRequest('PATCH', ['automations', String(mine.id)], input)),
    (e: unknown) => (e as { code?: string }).code === 'reconnect_required',
  );

  // Emergency pause affects only my rules.
  const paused = await automationRoutes(apiRequest('POST', ['automations', 'pause-all']));
  assert.deepEqual(await paused!.json(), { paused: 1 });
  assert.equal((tables.automation_rules[0] as Row).enabled, false);
  assert.equal((tables.automation_rules[1] as Row).enabled, true);
});

test('failure logs and records never contain tokens, secrets, message text or provider payloads', async () => {
  const { r } = setupRun('instagram', 'dm_reply');
  graph = () =>
    json(
      {
        error: { code: 100, message: 'Bad request for token instagram-token-SECRET', fbtrace_id: 'x' },
        echo: 'Thanks for your message!',
      },
      400,
    );
  await automation.processRun(r as never);
  const everything = logs.join('\n') + technical() + JSON.stringify(finished());
  for (const secret of ['instagram-token-SECRET', SERVICE_KEY, INSTAGRAM_SECRET, 'fbtrace'])
    assert.doesNotMatch(everything, new RegExp(secret), secret);
  assert.equal(finished()[0].p_error_message, automation.failureMessages.provider_rejected);
  assert.ok(!providerCalls.some(c => c.url.search.includes('token')), 'tokens travel in headers, not URLs');
});
