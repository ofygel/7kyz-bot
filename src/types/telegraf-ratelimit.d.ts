declare module 'telegraf-ratelimit' {
  import type { MiddlewareFn } from 'telegraf';

  interface RateLimitOptions {
    window?: number;
    limit?: number;
    keyGenerator?: (ctx: any) => string | undefined;
    onLimitExceeded?: (ctx: any) => unknown;
    skip?: (ctx: any) => boolean;
  }

  function rateLimit(options?: RateLimitOptions): MiddlewareFn<any>;

  export = rateLimit;
}
