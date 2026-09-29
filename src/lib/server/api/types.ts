import 'server-only';
import type { requireUser } from '../core';

/** One authenticated API call, already routed past public endpoints (health, webhooks, cron, OAuth callbacks, media). */
export interface ApiRequest {
  req: Request;
  method: string;
  path: string[];
  route: string;
  user: Awaited<ReturnType<typeof requireUser>>;
}

/** A route module returns a Response when it owns the endpoint, or null to let the next module try. */
export type RouteModule = (request: ApiRequest) => Promise<Response | null>;
