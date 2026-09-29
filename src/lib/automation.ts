import { z } from 'zod';

/** OAuth scopes requested at connection time. Accounts connected before these were added must reconnect. */
export const instagramScopes = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const;
export const threadsScopes = [
  'threads_basic',
  'threads_content_publish',
  'threads_read_replies',
  'threads_manage_replies',
] as const;

export type AutomationPlatform = 'threads' | 'instagram';
export type Capability = 'publish' | 'comments' | 'messages' | 'replies';
export const capabilityLabels: Record<Capability, string> = {
  publish: 'Publish posts',
  comments: 'Reply to comments',
  messages: 'Reply to messages',
  replies: 'Reply to Threads replies',
};

const capabilityScopes: Record<AutomationPlatform, Partial<Record<Capability, string[]>>> = {
  instagram: {
    publish: ['instagram_business_basic', 'instagram_business_content_publish'],
    comments: ['instagram_business_basic', 'instagram_business_manage_comments'],
    messages: ['instagram_business_basic', 'instagram_business_manage_messages'],
  },
  threads: {
    publish: ['threads_basic', 'threads_content_publish'],
    replies: ['threads_basic', 'threads_read_replies', 'threads_manage_replies'],
  },
};

/** Capabilities a stored scope list grants. `null` scopes means a legacy connection whose grants are unknown. */
export function grantedCapabilities(platform: AutomationPlatform, scopes: readonly string[] | null | undefined) {
  if (!scopes) return [] as Capability[];
  return (Object.entries(capabilityScopes[platform]) as [Capability, string[]][])
    .filter(([, needed]) => needed.every(s => scopes.includes(s)))
    .map(([capability]) => capability);
}

/** Automation needs every scope in the current request list; publishing keeps working without them. */
export function missingScopes(platform: AutomationPlatform, scopes: readonly string[] | null | undefined) {
  const wanted: readonly string[] = platform === 'instagram' ? instagramScopes : threadsScopes;
  return wanted.filter(s => !scopes?.includes(s));
}

export function reconnectRequired(account: { platform: AutomationPlatform; scopes?: string[] | null } | null) {
  return !!account && missingScopes(account.platform, account.scopes).length > 0;
}

/** Scopes from a token response (comma string or array), limited to the ones this app asked for. */
export function parseGrantedScopes(value: unknown, requested: readonly string[]) {
  const list = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [...requested];
  return requested.filter(s => list.map(v => v.trim()).includes(s));
}

export function normalizeText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/** Empty `keywords` matches everything; any exclusion keyword always wins. Matching is case-insensitive substring. */
export function keywordDecision(
  text: string,
  keywords: readonly string[],
  exclusions: readonly string[],
): 'match' | 'no_keyword' | 'excluded' {
  const body = normalizeText(text);
  if (exclusions.some(k => k.trim() && body.includes(normalizeText(k)))) return 'excluded';
  const active = keywords.filter(k => k.trim());
  if (active.length && !active.some(k => body.includes(normalizeText(k)))) return 'no_keyword';
  return 'match';
}

const keywordList = z
  .array(z.string().trim().min(1).max(50))
  .max(20)
  .transform(list => [...new Set(list)]);
const template = (max: number) => z.string().trim().max(max);
const utf8Bytes = (v: string) => new TextEncoder().encode(v).length;

export const threadsReplyMax = 500;
export const commentReplyMax = 1000;
/** Instagram messages are limited to 1000 UTF-8 bytes. */
export const messageBytesMax = 1000;

export const automationRuleSchema = z
  .object({
    enabled: z.boolean(),
    comment_reply_enabled: z.boolean().default(false),
    comment_reply_template: template(commentReplyMax).default(''),
    private_reply_enabled: z.boolean().default(false),
    private_reply_template: template(2000)
      .refine(v => utf8Bytes(v) <= messageBytesMax, 'Private reply cannot exceed 1000 bytes.')
      .default(''),
    dm_reply_enabled: z.boolean().default(false),
    dm_reply_template: template(2000)
      .refine(v => utf8Bytes(v) <= messageBytesMax, 'DM reply cannot exceed 1000 bytes.')
      .default(''),
    threads_reply_enabled: z.boolean().default(false),
    threads_reply_template: template(2000)
      .refine(v => Array.from(v).length <= threadsReplyMax, 'Threads reply cannot exceed 500 characters.')
      .default(''),
    keywords: keywordList.default([]),
    exclude_keywords: keywordList.default([]),
    cooldown_minutes: z.number().int().min(1).max(1440).default(60),
  })
  .superRefine((rule, ctx) => {
    const pairs: [keyof typeof rule, keyof typeof rule, string][] = [
      ['comment_reply_enabled', 'comment_reply_template', 'comment reply'],
      ['private_reply_enabled', 'private_reply_template', 'private reply'],
      ['dm_reply_enabled', 'dm_reply_template', 'DM reply'],
      ['threads_reply_enabled', 'threads_reply_template', 'Threads reply'],
    ];
    for (const [flag, text, label] of pairs)
      if (rule[flag] && !String(rule[text]).trim())
        ctx.addIssue({ code: 'custom', path: [text], message: `Write a ${label} message before turning it on.` });
  });
export type AutomationRuleInput = z.infer<typeof automationRuleSchema>;

/** Features a rule turns on for a platform, and the capability each one needs. */
export function ruleFeatures(platform: AutomationPlatform, rule: Partial<AutomationRuleInput>) {
  const features: { key: string; capability: Capability }[] = [];
  if (platform === 'instagram') {
    if (rule.comment_reply_enabled) features.push({ key: 'comment_reply', capability: 'comments' });
    if (rule.private_reply_enabled) features.push({ key: 'private_reply', capability: 'comments' });
    if (rule.dm_reply_enabled) features.push({ key: 'dm_reply', capability: 'messages' });
  } else if (rule.threads_reply_enabled) features.push({ key: 'threads_reply', capability: 'replies' });
  return features;
}

export interface AutomationRule extends AutomationRuleInput {
  id: string;
  social_account_id: string;
  platform: AutomationPlatform;
  updated_at: string;
}
export interface AutomationRun {
  id: string;
  action: 'comment_reply' | 'private_reply' | 'dm_reply' | 'threads_reply';
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'uncertain';
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
}
export interface AutomationAccount {
  id: string;
  platform: AutomationPlatform;
  username: string;
  status: string;
  expires_at: string | null;
  scopes: string[] | null;
  capabilities: Capability[];
  reconnect_required: boolean;
  rule: AutomationRule | null;
  last_success_at: string | null;
  recent_failures: AutomationRun[];
}
export const runActionLabels: Record<AutomationRun['action'], string> = {
  comment_reply: 'Comment reply',
  private_reply: 'Private reply',
  dm_reply: 'DM reply',
  threads_reply: 'Threads reply',
};
