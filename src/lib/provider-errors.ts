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

/** Loggable fields of a failure: never the raw provider payload, which may echo request parameters. */
export function errorSummary(e: unknown) {
  if (e instanceof ThreadsError || e instanceof InstagramError) {
    const error = (e.details as { error?: { type?: unknown; message?: unknown } } | null)?.error;
    return {
      type: 'provider',
      status: e.status,
      provider_code: e.providerCode,
      provider_type: typeof error?.type === 'string' ? error.type.slice(0, 100) : null,
      provider_message: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
    };
  }
  return { type: 'internal', name: e instanceof Error ? e.name : 'unknown' };
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
