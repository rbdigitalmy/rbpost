export type SocialPlatform = 'threads' | 'instagram';

export class ThreadsError extends Error {
  constructor(
    public status: number,
    public providerCode: number | null,
    public details?: unknown,
  ) {
    super(`Threads request failed with status ${status}: ${JSON.stringify(details)}`);
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
