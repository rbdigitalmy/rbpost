export type SocialPlatform = 'threads' | 'instagram';

export class ThreadsError extends Error {
  constructor(
    public status: number,
    public providerCode: number | null,
    public details?: unknown,
  ) {
    super(`Threads request failed with status ${status}`);
  }
}

export class InstagramError extends Error {
  constructor(
    public status: number,
    public providerCode: number | null,
    public details?: unknown,
  ) {
    super(`Instagram request failed with status ${status}`);
  }
}

/**
 * Loggable fields of a failure: structured codes only. Never the raw payload or the provider's message text,
 * which can echo request parameters, message content or user names.
 */
export function errorSummary(e: unknown) {
  if (e instanceof ThreadsError || e instanceof InstagramError) {
    const error = (e.details as { error?: { type?: unknown; error_subcode?: unknown; is_transient?: unknown } } | null)
      ?.error;
    return {
      type: 'provider',
      status: e.status,
      provider_code: e.providerCode,
      provider_type: typeof error?.type === 'string' ? error.type.slice(0, 100) : null,
      provider_subcode: typeof error?.error_subcode === 'number' ? error.error_subcode : null,
      provider_transient: error?.is_transient === true,
    };
  }
  return { type: 'internal', name: e instanceof Error ? e.name : 'unknown' };
}

export type FailureKind =
  'rate_limited' | 'transient' | 'expired_token' | 'permission' | 'policy_window' | 'permanent' | 'uncertain';

// Graph API codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
const TRANSIENT_CODES = new Set([1, 2]);
// Messaging policy: outside the allowed window, recipient unavailable, or one private reply already sent.
const POLICY_SUBCODES = new Set([2018278, 2534022, 2018108, 2018109, 1545041, 2534014]);

/**
 * How an outgoing action failed. A provider error response means the action did not happen, so transient ones
 * may be retried. No response at all (timeout, network) after sending leaves the outcome unknown: 'uncertain'.
 */
export function classifyFailure(e: unknown): FailureKind {
  if (e instanceof ThreadsError || e instanceof InstagramError) {
    const error = (e.details as { error?: { is_transient?: unknown; error_subcode?: unknown } } | null)?.error;
    const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
    if (e.providerCode === 190 || e.status === 401) return 'expired_token';
    if (subcode !== null && POLICY_SUBCODES.has(subcode)) return 'policy_window';
    if (e.providerCode === 551) return 'policy_window';
    if (e.status === 429 || (e.providerCode !== null && RATE_LIMIT_CODES.has(e.providerCode))) return 'rate_limited';
    if (e.providerCode === 10 || (e.providerCode !== null && e.providerCode >= 200 && e.providerCode < 300))
      return 'permission';
    if (error?.is_transient === true || (e.providerCode !== null && TRANSIENT_CODES.has(e.providerCode)))
      return 'transient';
    if (e.status >= 500) return 'transient';
    return 'permanent';
  }
  return 'uncertain';
}

/** Code 190 / HTTP 401 mean the stored token is no longer valid. */
function invalidToken(e: ThreadsError | InstagramError) {
  return e.providerCode === 190 || e.status === 401;
}

/** Which connected account (if any) must be reconnected after this publishing error. */
export function reconnectPlatform(e: unknown): SocialPlatform | null {
  if (e instanceof ThreadsError) return invalidToken(e) ? 'threads' : null;
  if (e instanceof InstagramError) return invalidToken(e) ? 'instagram' : null;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'reconnect') return 'threads';
  if (code === 'reconnect_instagram') return 'instagram';
  return null;
}
