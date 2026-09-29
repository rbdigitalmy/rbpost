import 'server-only';
import { z } from 'zod';
import {
  type AutomationAccount,
  type AutomationPlatform,
  type AutomationRun,
  automationRuleSchema,
  grantedCapabilities,
  reconnectRequired,
  ruleFeatures,
} from '../../automation';
import { decryptToken } from '../../crypto';
import { errorSummary } from '../../provider-errors';
import { AppError, checkDB, db, env, json, jsonBody, logTechnical, rate, requireSubscription } from '../core';
import { subscribeInstagramWebhooks } from '../instagram';
import type { ApiRequest } from './types';

// Only these columns ever leave the server: no tokens, polling state or tenant IDs.
const RULE_FIELDS =
  'id,social_account_id,platform,enabled,comment_reply_enabled,comment_reply_template,private_reply_enabled,private_reply_template,dm_reply_enabled,dm_reply_template,threads_reply_enabled,threads_reply_template,keywords,exclude_keywords,cooldown_minutes,updated_at';
const RUN_FIELDS = 'id,social_account_id,action,status,error_code,error_message,created_at,sent_at';

async function overview(userId: string): Promise<AutomationAccount[]> {
  const client = db();
  const [accounts, rules, sent, failures] = await Promise.all([
    client
      .from('social_accounts')
      .select('id,platform,username,status,expires_at,scopes')
      .eq('user_id', userId)
      .order('platform'),
    client.from('automation_rules').select(RULE_FIELDS).eq('user_id', userId),
    client
      .from('automation_runs')
      .select('social_account_id,sent_at')
      .eq('user_id', userId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(50),
    client
      .from('automation_runs')
      .select(RUN_FIELDS)
      .eq('user_id', userId)
      .in('status', ['failed', 'uncertain'])
      .order('created_at', { ascending: false })
      .limit(30),
  ]);
  [accounts, rules, sent, failures].forEach(r => checkDB(r.error));
  return (accounts.data || []).map(a => {
    const platform = a.platform as AutomationPlatform;
    const rule = (rules.data || []).find(r => r.social_account_id === a.id) || null;
    return {
      id: a.id,
      platform,
      username: a.username,
      status: a.status,
      expires_at: a.expires_at,
      scopes: a.scopes,
      capabilities: grantedCapabilities(platform, a.scopes),
      reconnect_required: reconnectRequired({ platform, scopes: a.scopes }),
      rule: rule as AutomationAccount['rule'],
      last_success_at: (sent.data || []).find(r => r.social_account_id === a.id)?.sent_at || null,
      recent_failures: ((failures.data || []) as (AutomationRun & { social_account_id: string })[])
        .filter(r => r.social_account_id === a.id)
        .slice(0, 5)
        .map(({ social_account_id: _account, ...run }) => run),
    };
  });
}

/** Automation settings per connected account, and the emergency pause. */
export async function automationRoutes({ req, method, path, route, user }: ApiRequest): Promise<Response | null> {
  if (method === 'GET' && route === 'automations') return json(await overview(user.id));

  if (method === 'POST' && route === 'automations/pause-all') {
    // Emergency stop: never gated on subscription or rate limits.
    const { data, error } = await db()
      .from('automation_rules')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('enabled', true)
      .select('id');
    checkDB(error);
    return json({ paused: data?.length || 0 });
  }

  if (method === 'PATCH' && path[0] === 'automations' && path.length === 2) {
    await rate(user.id, 'automation', 20);
    const accountId = z.uuid().parse(path[1]);
    const { data: account, error } = await db()
      .from('social_accounts')
      .select('id,user_id,platform,status,expires_at,scopes,access_token_encrypted,webhooks_subscribed_at')
      .eq('id', accountId)
      .eq('user_id', user.id)
      .maybeSingle();
    checkDB(error);
    if (!account) throw new AppError('Akaun tidak ditemui.', 404, 'not_found');
    const platform = account.platform as AutomationPlatform;
    const parsed = automationRuleSchema.parse(await jsonBody(req));
    // Features of the other platform can never be switched on for this account.
    const input =
      platform === 'instagram'
        ? { ...parsed, threads_reply_enabled: false }
        : { ...parsed, comment_reply_enabled: false, private_reply_enabled: false, dm_reply_enabled: false };
    const features = ruleFeatures(platform, input);
    const activating = input.enabled && features.length > 0;
    if (activating) {
      await requireSubscription(user.id);
      if (
        account.status !== 'connected' ||
        !account.expires_at ||
        Date.parse(account.expires_at) <= Date.now() ||
        !account.access_token_encrypted
      )
        throw new AppError('Sambung semula akaun sebelum menghidupkan automasi.', 409, 'reconnect');
      const granted = grantedCapabilities(platform, account.scopes);
      if (features.some(f => !granted.includes(f.capability)))
        throw new AppError(
          'Akaun ini perlu disambung semula untuk memberi kebenaran automasi baharu.',
          409,
          'reconnect_required',
        );
    }
    const existing = await db()
      .from('automation_rules')
      .select('enabled,threads_reply_enabled,threads_since')
      .eq('social_account_id', account.id)
      .maybeSingle();
    checkDB(existing.error);
    const threadsActive = input.enabled && input.threads_reply_enabled;
    const wasThreadsActive = !!existing.data?.enabled && !!existing.data?.threads_reply_enabled;
    const now = new Date().toISOString();
    const { data: saved, error: saveError } = await db()
      .from('automation_rules')
      .upsert(
        {
          user_id: user.id,
          social_account_id: account.id,
          platform,
          ...input,
          // Replies older than the moment Threads automation (re)starts are never answered.
          threads_since: threadsActive && !wasThreadsActive ? now : existing.data?.threads_since || null,
          updated_at: now,
        },
        { onConflict: 'social_account_id' },
      )
      .select(RULE_FIELDS)
      .single();
    checkDB(saveError);

    let webhooks: 'ready' | 'pending' | 'not_needed' = 'not_needed';
    if (platform === 'instagram' && activating) {
      webhooks = account.webhooks_subscribed_at ? 'ready' : 'pending';
      if (!account.webhooks_subscribed_at)
        try {
          await subscribeInstagramWebhooks(
            decryptToken(account.access_token_encrypted!, user.id, env('TOKEN_ENCRYPTION_KEY')),
          );
          const marked = await db()
            .from('social_accounts')
            .update({ webhooks_subscribed_at: now })
            .eq('id', account.id)
            .eq('user_id', user.id);
          checkDB(marked.error);
          webhooks = 'ready';
        } catch (e) {
          await logTechnical(user.id, null, 'instagram_webhook_subscribe_failed', errorSummary(e));
        }
    }
    return json({ rule: saved, webhooks });
  }
  return null;
}
