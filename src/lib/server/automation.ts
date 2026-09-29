import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type AutomationPlatform,
  type AutomationRule,
  type AutomationRun,
  grantedCapabilities,
  keywordDecision,
  normalizeText,
  ruleFeatures,
} from '../automation';
import { decryptToken } from '../crypto';
import { classifyFailure, errorSummary, type FailureKind } from '../provider-errors';
import { AppError, checkDB, db, env, logTechnical, readRawBody, requireSubscription } from './core';
import { instagramPostJson, instagramRequest } from './instagram';
import { threadsRequest } from './threads';

// ---------------------------------------------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------------------------------------------

export type InboundKind = 'ig_comment' | 'ig_message' | 'threads_reply';
/** A provider event reduced to what the decision needs. `text` is used for filtering and never stored. */
export interface InboundEvent {
  platform: AutomationPlatform;
  kind: InboundKind;
  eventId: string;
  senderId: string | null;
  senderUsername: string | null;
  text: string;
  /** Media (comment/reply) the event belongs to. */
  parentId: string | null;
  createdAt: Date | null;
  /** A comment on a comment, or a reply below the top level: never answered, which also breaks reply chains. */
  nested: boolean;
  /** The provider marked it as sent by the connected account (echo / is_reply_owned_by_me). */
  own: boolean;
}
export interface AccountRow {
  id: string;
  user_id: string;
  platform: AutomationPlatform;
  platform_user_id: string;
  provider_account_id?: string | null;
  username: string;
  status: string;
  expires_at: string | null;
  access_token_encrypted?: string | null;
  scopes: string[] | null;
  webhooks_subscribed_at?: string | null;
}
type RuleRow = AutomationRule & { user_id: string; threads_since: string | null; threads_polled_at: string | null };

const ACCOUNT_FIELDS =
  'id,user_id,platform,platform_user_id,provider_account_id,username,status,expires_at,access_token_encrypted,scopes,webhooks_subscribed_at';

function isOwnSender(e: InboundEvent, account: AccountRow) {
  if (e.own) return true;
  const ids = [account.platform_user_id, account.provider_account_id].filter(Boolean);
  if (e.senderId && ids.includes(e.senderId)) return true;
  return !!e.senderUsername && e.senderUsername.toLowerCase() === account.username.toLowerCase();
}

/** Which replies an event gets, or why it gets none. Pure: every rule the product promises is decided here. */
export function decide(
  e: InboundEvent,
  account: AccountRow,
  rule: Pick<
    AutomationRule,
    | 'enabled'
    | 'comment_reply_enabled'
    | 'comment_reply_template'
    | 'private_reply_enabled'
    | 'private_reply_template'
    | 'dm_reply_enabled'
    | 'dm_reply_template'
    | 'threads_reply_enabled'
    | 'threads_reply_template'
    | 'keywords'
    | 'exclude_keywords'
  > | null,
): { actions: AutomationRun['action'][]; skip: string | null } {
  const none = (skip: string) => ({ actions: [] as AutomationRun['action'][], skip });
  if (!rule?.enabled) return none('disabled');
  if (isOwnSender(e, account)) return none('own');
  if (e.nested) return none('nested');
  if (!e.text.trim()) return none('unsupported');
  const keyword = keywordDecision(e.text, rule.keywords || [], rule.exclude_keywords || []);
  if (keyword !== 'match') return none(keyword);
  // Another automation echoing one of our own templates back would otherwise start a reply loop.
  const templates = [
    rule.comment_reply_template,
    rule.private_reply_template,
    rule.dm_reply_template,
    rule.threads_reply_template,
  ]
    .filter(Boolean)
    .map(normalizeText);
  if (templates.includes(normalizeText(e.text))) return none('loop_guard');
  const wanted = ruleFeatures(account.platform, rule).filter(f =>
    e.kind === 'ig_comment'
      ? f.key === 'comment_reply' || f.key === 'private_reply'
      : e.kind === 'ig_message'
        ? f.key === 'dm_reply'
        : f.key === 'threads_reply',
  );
  if (!wanted.length) return none('disabled');
  const granted = grantedCapabilities(account.platform, account.scopes);
  const actions = wanted.filter(f => granted.includes(f.capability)).map(f => f.key as AutomationRun['action']);
  return actions.length ? { actions, skip: null } : none('permission');
}

/** Records the event once and queues its replies. Returns the number of replies queued (0 for duplicates). */
export async function ingestEvent(e: InboundEvent, account: AccountRow, rule: RuleRow | null) {
  // Nothing is stored for accounts without an active rule: no automation, no data kept.
  if (!rule?.enabled) return 0;
  const { actions, skip } = decide(e, account, rule);
  const { data, error } = await db().rpc('ingest_automation_event', {
    p_user: account.user_id,
    p_account: account.id,
    p_platform: account.platform,
    p_kind: e.kind,
    p_event_id: e.eventId,
    p_sender: e.senderId || e.senderUsername || null,
    p_parent: e.parentId,
    p_created: e.createdAt?.toISOString() || null,
    p_actions: actions,
    p_skip: skip,
    p_cooldown_minutes: rule.cooldown_minutes,
  });
  checkDB(error);
  const row = (data as { queued: number }[] | null)?.[0];
  return row?.queued || 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------------------------

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GET verification handshake: echo hub.challenge only for the configured verify token. */
export function webhookChallenge(req: Request) {
  const q = new URL(req.url).searchParams;
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  const challenge = q.get('hub.challenge') || '';
  if (
    !expected ||
    q.get('hub.mode') !== 'subscribe' ||
    !safeEqual(q.get('hub.verify_token') || '', expected) ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(challenge)
  )
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  return new Response(challenge, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}

/**
 * Meta signs the raw body with HMAC-SHA256 in X-Hub-Signature-256 ("sha256=<hex>") using the app secret.
 * Instagram Login and Threads each have their own secret in the dashboard, so every configured candidate is tried.
 */
export function webhookSecrets(platform: AutomationPlatform) {
  const list = [
    process.env.META_WEBHOOK_APP_SECRET,
    platform === 'instagram' ? process.env.INSTAGRAM_APP_SECRET : undefined,
    process.env.META_APP_SECRET,
  ].filter((v): v is string => !!v);
  return [...new Set(list)];
}
export function validSignature(raw: Buffer, header: string | null, secrets: string[]) {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header || '');
  if (!match || !secrets.length) return false;
  const given = Buffer.from(match[1].toLowerCase(), 'hex');
  return secrets.map(secret => timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), given)).some(Boolean);
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
const idOf = (v: unknown) => {
  const s = str(v);
  return s && /^[A-Za-z0-9_:.-]{1,200}$/.test(s) ? s : null;
};
const time = (v: unknown) => {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v) {
    const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
};
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** Instagram comment and message notifications, keyed by the professional account ID (entry.id). */
export function parseInstagramWebhook(payload: unknown) {
  const out: { accountId: string; event: InboundEvent }[] = [];
  for (const body of Array.isArray(payload) ? payload : [payload]) {
    if (obj(body).object !== 'instagram') continue;
    for (const rawEntry of (obj(body).entry as unknown[]) || []) {
      const entry = obj(rawEntry);
      const accountId = idOf(entry.id);
      if (!accountId) continue;
      const changes = Array.isArray(entry.changes)
        ? (entry.changes as unknown[]).map(obj)
        : entry.field
          ? [{ field: entry.field, value: entry.value }]
          : [];
      for (const change of changes) {
        if (change.field !== 'comments') continue;
        const v = obj(change.value);
        const id = idOf(v.id);
        if (!id) continue;
        out.push({
          accountId,
          event: {
            platform: 'instagram',
            kind: 'ig_comment',
            eventId: id,
            senderId: idOf(obj(v.from).id),
            senderUsername: str(obj(v.from).username),
            text: str(v.text) || '',
            parentId: idOf(obj(v.media).id),
            createdAt: time(entry.time),
            nested: !!v.parent_id,
            own: false,
          },
        });
      }
      for (const rawMessage of Array.isArray(entry.messaging) ? (entry.messaging as unknown[]) : []) {
        const m = obj(rawMessage);
        const message = obj(m.message);
        const id = idOf(message.mid);
        if (!id || message.is_deleted) continue;
        const senderId = idOf(obj(m.sender).id);
        out.push({
          accountId,
          event: {
            platform: 'instagram',
            kind: 'ig_message',
            eventId: id,
            senderId,
            senderUsername: null,
            text: message.is_unsupported ? '' : str(message.text) || '',
            parentId: null,
            createdAt: time(m.timestamp),
            nested: false,
            own: message.is_echo === true || message.is_self === true || senderId === accountId,
          },
        });
      }
    }
  }
  return out;
}

/** Threads "replies" notifications. The account is found from the root post the reply belongs to. */
export function parseThreadsWebhook(payload: unknown) {
  const out: { rootId: string; event: InboundEvent }[] = [];
  for (const body of Array.isArray(payload) ? payload : [payload]) {
    const values = obj(obj(body).values);
    for (const rawValue of Array.isArray(values.value) ? values.value : [values.value]) {
      const v = obj(rawValue);
      const id = idOf(v.id);
      const rootId = idOf(obj(v.root_post).id);
      const repliedTo = idOf(obj(v.replied_to).id);
      if (!id || !rootId) continue;
      out.push({
        rootId,
        event: {
          platform: 'threads',
          kind: 'threads_reply',
          eventId: id,
          senderId: null,
          senderUsername: str(v.username),
          text: str(v.text) || '',
          parentId: rootId,
          createdAt: time(v.timestamp),
          nested: !!repliedTo && repliedTo !== rootId,
          own: v.is_reply_owned_by_me === true,
        },
      });
    }
  }
  return out;
}

async function ruleFor(accountId: string) {
  const { data, error } = await db()
    .from('automation_rules')
    .select('*')
    .eq('social_account_id', accountId)
    .maybeSingle();
  checkDB(error);
  return data as RuleRow | null;
}

async function instagramAccountByWebhookId(id: string) {
  if (!/^\d{1,40}$/.test(id)) return null;
  const { data, error } = await db()
    .from('social_accounts')
    .select(ACCOUNT_FIELDS)
    .eq('platform', 'instagram')
    .or(`provider_account_id.eq.${id},platform_user_id.eq.${id}`)
    .limit(1);
  checkDB(error);
  return ((data || [])[0] as AccountRow | undefined) || null;
}

async function threadsAccountByRootPost(rootId: string) {
  if (!/^\d{1,40}$/.test(rootId)) return null;
  const known = await db().from('automation_checkpoints').select('social_account_id').eq('media_id', rootId).limit(1);
  checkDB(known.error);
  let accountId = known.data?.[0]?.social_account_id as string | undefined;
  if (!accountId) {
    // Posts published by RB Post store "<threads id>" or "<threads id>,<instagram id>".
    const posts = await db()
      .from('posts')
      .select('user_id')
      .eq('status', 'published')
      .or(`platform_post_id.eq.${rootId},platform_post_id.like."${rootId},*"`)
      .limit(1);
    checkDB(posts.error);
    const owner = posts.data?.[0]?.user_id;
    if (!owner) return null;
    const account = await db()
      .from('social_accounts')
      .select('id')
      .eq('user_id', owner)
      .eq('platform', 'threads')
      .maybeSingle();
    checkDB(account.error);
    accountId = account.data?.id;
  }
  if (!accountId) return null;
  const { data, error } = await db().from('social_accounts').select(ACCOUNT_FIELDS).eq('id', accountId).maybeSingle();
  checkDB(error);
  return data as AccountRow | null;
}

/** Verifies and records a webhook delivery. Replies are sent afterwards by the queue, never inline. */
export async function receiveWebhook(platform: AutomationPlatform, req: Request) {
  const secrets = webhookSecrets(platform);
  if (!secrets.length) env('META_WEBHOOK_APP_SECRET');
  const raw = await readRawBody(req, 1_000_000);
  if (!validSignature(raw, req.headers.get('x-hub-signature-256'), secrets))
    throw new AppError('Invalid signature', 401, 'invalid_signature');
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('Invalid payload', 400);
  }
  let queued = 0;
  if (platform === 'instagram') {
    for (const { accountId, event } of parseInstagramWebhook(payload)) {
      const account = await instagramAccountByWebhookId(accountId);
      if (account) queued += await ingestEvent(event, account, await ruleFor(account.id));
    }
  } else {
    for (const { rootId, event } of parseThreadsWebhook(payload)) {
      const account = await threadsAccountByRootPost(rootId);
      if (account) queued += await ingestEvent(event, account, await ruleFor(account.id));
    }
  }
  return { received: true, queued };
}

// ---------------------------------------------------------------------------------------------------------------
// Outgoing replies
// ---------------------------------------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5;
/** Per connected account, across all automated replies. */
export const ACCOUNT_HOURLY_LIMIT = 60;
/** Per recipient per account, on top of the rule's cooldown. */
export const RECIPIENT_DAILY_LIMIT = 3;
const PRIVATE_REPLY_WINDOW_MS = 7 * 86_400_000;
const MESSAGE_WINDOW_MS = 24 * 3_600_000;

/** Sanitized, user-facing reasons. Provider text is never shown or stored. */
export const failureMessages: Record<string, string> = {
  disabled: 'Automasi dimatikan sebelum balasan dihantar.',
  subscription_required: 'Langganan aktif diperlukan untuk automasi.',
  reconnect: 'Sambung semula akaun untuk meneruskan automasi.',
  permission: 'Kebenaran automasi tiada. Sambung semula akaun dan benarkan semua kebenaran.',
  window_expired: 'Tempoh yang dibenarkan Meta untuk membalas telah tamat.',
  recipient_limit: 'Had balasan harian kepada pengguna ini telah dicapai.',
  retry_exhausted: 'Balasan gagal selepas beberapa cubaan.',
  retrying: 'Ralat sementara. Balasan akan dicuba semula.',
  provider_rejected: 'Meta menolak balasan ini.',
  outcome_unknown: 'Hasil balasan tidak dapat dipastikan. Semak akaun sebelum membalas semula.',
};

type RunRow = AutomationRun & {
  user_id: string;
  social_account_id: string;
  event_id: string;
  recipient_id: string | null;
  attempts: number;
  provider_container_id: string | null;
};
type EventRow = {
  provider_event_id: string;
  provider_created_at: string | null;
  received_at: string;
  kind: InboundKind;
};

async function finish(
  run: RunRow,
  status: 'sent' | 'failed' | 'skipped' | 'uncertain' | 'retry' | 'defer',
  code: string | null = null,
  options: { resultId?: string; retryAt?: Date } = {},
) {
  const { error } = await db().rpc('finish_automation_run', {
    p_id: run.id,
    p_status: status,
    p_error_code: code,
    p_error_message: code ? failureMessages[code] || failureMessages.provider_rejected : null,
    p_result_id: options.resultId || null,
    p_retry_at: options.retryAt?.toISOString() || null,
  });
  checkDB(error);
}

/** Exponential backoff: 1, 2, 4, 8 minutes; rate limits wait longer. */
export function retryDelay(attempt: number, kind: FailureKind) {
  const base = kind === 'rate_limited' ? 5 * 60_000 : 60_000;
  return Math.min(base * 2 ** Math.max(attempt - 1, 0), 60 * 60_000);
}

function templateFor(rule: RuleRow, action: AutomationRun['action']) {
  return {
    comment_reply: rule.comment_reply_template,
    private_reply: rule.private_reply_template,
    dm_reply: rule.dm_reply_template,
    threads_reply: rule.threads_reply_template,
  }[action].trim();
}
function featureOn(rule: RuleRow, action: AutomationRun['action']) {
  return {
    comment_reply: rule.comment_reply_enabled,
    private_reply: rule.private_reply_enabled,
    dm_reply: rule.dm_reply_enabled,
    threads_reply: rule.threads_reply_enabled,
  }[action];
}
const capabilityFor = {
  comment_reply: 'comments',
  private_reply: 'comments',
  dm_reply: 'messages',
  threads_reply: 'replies',
} as const;

async function countSent(accountId: string, sinceMs: number, recipient?: string | null, excludeRun?: string) {
  let query = db()
    .from('automation_runs')
    .select('id', { count: 'exact', head: true })
    .eq('social_account_id', accountId)
    .in('status', ['sent', 'sending', 'uncertain'])
    .gte('created_at', new Date(Date.now() - sinceMs).toISOString());
  if (recipient) query = query.eq('recipient_id', recipient);
  if (excludeRun) query = query.neq('id', excludeRun);
  const { count, error } = await query;
  checkDB(error);
  return count || 0;
}

async function markAttempted(run: RunRow) {
  const { error } = await db()
    .from('automation_runs')
    .update({ send_attempted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', run.id)
    .eq('status', 'sending')
    .select('id')
    .single();
  checkDB(error);
}

async function flagAccount(accountId: string, change: Record<string, unknown>) {
  const { error } = await db().from('social_accounts').update(change).eq('id', accountId);
  if (error) await logTechnical(null, null, 'automation_account_flag_failed', { code: error.code || null });
}

async function sendThreadsReply(
  run: RunRow,
  account: AccountRow,
  token: string,
  event: EventRow,
  text: string,
  beforePublish: () => Promise<void>,
) {
  let container = run.provider_container_id;
  if (!container) {
    const created = await threadsRequest<{ id: string }>(
      `v1.0/${account.platform_user_id}/threads`,
      token,
      { media_type: 'TEXT', text, reply_to_id: event.provider_event_id },
      'POST',
    );
    if (!created.id) throw new AppError('Threads did not return a container', 502, 'provider_rejected');
    container = created.id;
    const saved = await db()
      .from('automation_runs')
      .update({ provider_container_id: container })
      .eq('id', run.id)
      .eq('status', 'sending');
    checkDB(saved.error);
  }
  for (let i = 0; ; i++) {
    const status = await threadsRequest<{ status?: string }>(`v1.0/${container}`, token, { fields: 'status' });
    if (status.status === 'FINISHED') break;
    if (status.status === 'PUBLISHED') throw new AppError('Already published', 409, 'outcome_unknown');
    if (status.status === 'ERROR' || status.status === 'EXPIRED')
      throw new AppError('Threads rejected the reply', 502, 'provider_rejected');
    if (i >= 2) throw new AppError('Reply container still processing', 503, 'container_pending');
    await new Promise(r => setTimeout(r, 1000));
  }
  await beforePublish();
  const published = await threadsRequest<{ id: string }>(
    `v1.0/${account.platform_user_id}/threads_publish`,
    token,
    { creation_id: container },
    'POST',
  );
  if (!published.id) throw new Error('Missing publish result');
  return published.id;
}

/** Sends one claimed reply. Every exit settles the run exactly once. */
export async function processRun(run: RunRow) {
  let attempted = false;
  const client = db();
  const [accountResult, ruleResult, eventResult] = await Promise.all([
    client.from('social_accounts').select(ACCOUNT_FIELDS).eq('id', run.social_account_id).maybeSingle(),
    client.from('automation_rules').select('*').eq('social_account_id', run.social_account_id).maybeSingle(),
    client
      .from('inbound_social_events')
      .select('provider_event_id,provider_created_at,received_at,kind')
      .eq('id', run.event_id)
      .maybeSingle(),
  ]);
  checkDB(accountResult.error);
  checkDB(ruleResult.error);
  checkDB(eventResult.error);
  const account = accountResult.data as AccountRow | null;
  const rule = ruleResult.data as RuleRow | null;
  const event = eventResult.data as EventRow | null;
  // A rule switched off after the event arrived stops the reply here.
  if (!account || !rule || !event || !rule.enabled || !featureOn(rule, run.action))
    return finish(run, 'skipped', 'disabled');
  try {
    await requireSubscription(run.user_id);
  } catch {
    return finish(run, 'skipped', 'subscription_required');
  }
  if (
    account.status !== 'connected' ||
    !account.access_token_encrypted ||
    !account.expires_at ||
    Date.parse(account.expires_at) <= Date.now()
  )
    return finish(run, 'failed', 'reconnect');
  if (!grantedCapabilities(account.platform, account.scopes).includes(capabilityFor[run.action]))
    return finish(run, 'failed', 'permission');
  const eventAge = Date.now() - Date.parse(event.provider_created_at || event.received_at);
  if (
    (run.action === 'private_reply' && eventAge > PRIVATE_REPLY_WINDOW_MS) ||
    (run.action === 'dm_reply' && eventAge > MESSAGE_WINDOW_MS)
  )
    return finish(run, 'failed', 'window_expired');
  if (run.recipient_id && (await countSent(account.id, 86_400_000, run.recipient_id, run.id)) >= RECIPIENT_DAILY_LIMIT)
    return finish(run, 'skipped', 'recipient_limit');
  if ((await countSent(account.id, 3_600_000, null, run.id)) >= ACCOUNT_HOURLY_LIMIT)
    return finish(run, 'defer', null, { retryAt: new Date(Date.now() + 10 * 60_000) });

  // Persist that the irreversible call is about to happen; any failure without a provider answer after this
  // point leaves the outcome unknown and is never retried.
  const beforeSend = async () => {
    await markAttempted(run);
    attempted = true;
  };
  try {
    const token = decryptToken(account.access_token_encrypted, account.user_id, env('TOKEN_ENCRYPTION_KEY'));
    const text = templateFor(rule, run.action);
    let resultId: string | undefined;
    if (run.action === 'threads_reply') {
      resultId = await sendThreadsReply(run, account, token, event, text, beforeSend);
    } else {
      await beforeSend();
      if (run.action === 'comment_reply') {
        const reply = await instagramRequest<{ id?: string }>(
          `${event.provider_event_id}/replies`,
          token,
          { message: text },
          'POST',
        );
        resultId = reply.id;
      } else {
        const recipient =
          run.action === 'private_reply' ? { comment_id: event.provider_event_id } : { id: run.recipient_id };
        const sent = await instagramPostJson<{ message_id?: string }>('me/messages', token, {
          recipient,
          message: { text },
        });
        resultId = sent.message_id;
      }
    }
    return finish(run, 'sent', null, { resultId });
  } catch (e) {
    return settleFailure(run, account, e, attempted);
  }
}

async function settleFailure(run: RunRow, account: AccountRow, e: unknown, attempted: boolean) {
  const code = e instanceof AppError ? e.code : null;
  let kind: FailureKind;
  if (code === 'container_pending') kind = 'transient';
  else if (code === 'provider_rejected') kind = 'permanent';
  else if (code === 'outcome_unknown') kind = 'uncertain';
  else {
    kind = classifyFailure(e);
    // No provider answer, but nothing irreversible was sent yet: safe to try again.
    if (kind === 'uncertain' && !attempted) kind = 'transient';
  }
  await logTechnical(run.user_id, null, 'automation_run_failed', {
    run_id: run.id,
    action: run.action,
    kind,
    attempted,
    ...errorSummary(e),
  });
  if (kind === 'uncertain') return finish(run, 'uncertain', 'outcome_unknown');
  if (kind === 'expired_token') {
    await flagAccount(account.id, { status: 'reconnect' });
    return finish(run, 'failed', 'reconnect');
  }
  if (kind === 'permission') {
    // Unknown grants from here on: the account must reconnect before automation runs again.
    await flagAccount(account.id, { scopes: null });
    return finish(run, 'failed', 'permission');
  }
  if (kind === 'policy_window') return finish(run, 'failed', 'window_expired');
  if (kind === 'transient' || kind === 'rate_limited') {
    if (run.attempts >= MAX_ATTEMPTS) return finish(run, 'failed', 'retry_exhausted');
    return finish(run, 'retry', 'retrying', { retryAt: new Date(Date.now() + retryDelay(run.attempts, kind)) });
  }
  return finish(run, 'failed', 'provider_rejected');
}

/** Claims and sends due replies in batches until the queue is empty or the time budget is spent. */
export async function processAutomationQueue(budgetMs = 60_000) {
  const started = Date.now();
  let processed = 0;
  while (Date.now() - started < budgetMs) {
    const { data, error } = await db().rpc('claim_automation_runs', { p_limit: 10 });
    checkDB(error);
    const batch = (data || []) as RunRow[];
    for (const run of batch) {
      try {
        await processRun(run);
      } catch (e) {
        // Database trouble while settling: the claim expires and the run is recovered by a later worker.
        await logTechnical(run.user_id, null, 'automation_worker_failed', { run_id: run.id, ...errorSummary(e) });
      }
    }
    processed += batch.length;
    if (batch.length < 10) break;
  }
  return { processed };
}

// ---------------------------------------------------------------------------------------------------------------
// Threads polling (fallback for webhooks, which need Advanced Access and may be missed)
// ---------------------------------------------------------------------------------------------------------------

/** Root posts older than this are not polled for new replies. */
export const THREADS_POLL_POST_DAYS = 7;
const THREADS_POLL_INTERVAL_MS = 4 * 60_000;
const REPLY_PAGES = 3;

interface ThreadsReply {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  is_reply_owned_by_me?: boolean;
}

async function pollAccount(rule: RuleRow, account: AccountRow) {
  const token = decryptToken(account.access_token_encrypted!, account.user_id, env('TOKEN_ENCRYPTION_KEY'));
  const since = Date.parse(rule.threads_since || rule.updated_at);
  const posts = await threadsRequest<{ data?: { id: string; timestamp?: string }[] }>(
    `v1.0/${account.platform_user_id}/threads`,
    token,
    { fields: 'id,timestamp', limit: '10' },
  );
  let queued = 0;
  for (const post of posts.data || []) {
    const postedAt = time(post.timestamp);
    if (!idOf(post.id) || !postedAt || Date.now() - postedAt.getTime() > THREADS_POLL_POST_DAYS * 86_400_000) continue;
    const created = await db()
      .from('automation_checkpoints')
      .upsert(
        {
          user_id: account.user_id,
          social_account_id: account.id,
          media_id: post.id,
          media_created_at: postedAt.toISOString(),
          last_reply_at: new Date(Math.max(since, postedAt.getTime())).toISOString(),
        },
        { onConflict: 'social_account_id,media_id', ignoreDuplicates: true },
      );
    checkDB(created.error);
    const checkpoint = await db()
      .from('automation_checkpoints')
      .select('id,last_reply_at')
      .eq('social_account_id', account.id)
      .eq('media_id', post.id)
      .single();
    checkDB(checkpoint.error);
    const cutoff = Date.parse(checkpoint.data!.last_reply_at);
    // Newest first; stop at the checkpoint so history is never rescanned. Equal timestamps are re-read and
    // deduplicated by the event's unique ID.
    const fresh: ThreadsReply[] = [];
    let after: string | undefined;
    pages: for (let page = 0; page < REPLY_PAGES; page++) {
      const result = await threadsRequest<{ data?: ThreadsReply[]; paging?: { cursors?: { after?: string } } }>(
        `v1.0/${post.id}/replies`,
        token,
        {
          fields: 'id,text,username,timestamp,is_reply_owned_by_me',
          reverse: 'true',
          limit: '25',
          ...(after ? { after } : {}),
        },
      );
      for (const reply of result.data || []) {
        const at = time(reply.timestamp);
        if (!at || at.getTime() < cutoff) break pages;
        if (!fresh.some(r => r.id === reply.id)) fresh.push(reply);
      }
      after = result.paging?.cursors?.after;
      if (!after || !(result.data || []).length) break;
    }
    let newest = cutoff;
    for (const reply of fresh.reverse()) {
      const at = time(reply.timestamp)!;
      if (!idOf(reply.id)) continue;
      queued += await ingestEvent(
        {
          platform: 'threads',
          kind: 'threads_reply',
          eventId: reply.id,
          senderId: null,
          senderUsername: reply.username || null,
          text: reply.text || '',
          parentId: post.id,
          createdAt: at,
          nested: false,
          own: reply.is_reply_owned_by_me === true,
        },
        account,
        rule,
      );
      newest = Math.max(newest, at.getTime());
    }
    const moved = await db()
      .from('automation_checkpoints')
      .update({ last_reply_at: new Date(newest).toISOString(), polled_at: new Date().toISOString() })
      .eq('id', checkpoint.data!.id);
    checkDB(moved.error);
  }
  return queued;
}

export async function pollThreadsReplies(budgetMs = 60_000) {
  const started = Date.now();
  const { data, error } = await db()
    .from('automation_rules')
    .select('*')
    .eq('platform', 'threads')
    .eq('enabled', true)
    .eq('threads_reply_enabled', true)
    .or(
      `threads_polled_at.is.null,threads_polled_at.lt.${new Date(Date.now() - THREADS_POLL_INTERVAL_MS).toISOString()}`,
    )
    .order('threads_polled_at', { ascending: true, nullsFirst: true })
    .limit(25);
  checkDB(error);
  let polled = 0,
    queued = 0;
  for (const rule of (data || []) as RuleRow[]) {
    if (Date.now() - started >= budgetMs) break;
    const marked = await db()
      .from('automation_rules')
      .update({ threads_polled_at: new Date().toISOString() })
      .eq('id', rule.id);
    checkDB(marked.error);
    const accountResult = await db()
      .from('social_accounts')
      .select(ACCOUNT_FIELDS)
      .eq('id', rule.social_account_id)
      .maybeSingle();
    checkDB(accountResult.error);
    const account = accountResult.data as AccountRow | null;
    if (
      !account ||
      account.status !== 'connected' ||
      !account.access_token_encrypted ||
      !account.expires_at ||
      Date.parse(account.expires_at) <= Date.now() ||
      !grantedCapabilities('threads', account.scopes).includes('replies')
    )
      continue;
    try {
      await requireSubscription(account.user_id);
      queued += await pollAccount(rule, account);
      polled++;
    } catch (e) {
      const kind = classifyFailure(e);
      if (kind === 'expired_token') await flagAccount(account.id, { status: 'reconnect' });
      if (kind === 'permission') await flagAccount(account.id, { scopes: null });
      await logTechnical(account.user_id, null, 'threads_poll_failed', { kind, ...errorSummary(e) });
    }
  }
  return { polled, queued };
}

/** Cron entry point: poll Threads, then send everything due. */
export async function runAutomation() {
  const poll = await pollThreadsReplies(60_000);
  const queue = await processAutomationQueue(90_000);
  return { ...poll, ...queue };
}
