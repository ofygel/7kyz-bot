# Bot runtime audit

The `npm run bot:audit` script performs a series of connectivity and configuration
checks that commonly cause the Telegram bot to stop responding. It is intended to
be run from the production shell (with the same environment variables used by the
service) and gives immediate feedback about missing dependencies or webhook
misconfiguration.

## Prerequisites

Before running the audit, export the environment variables that the bot normally
requires (see `src/config/env.ts` for the full list). At a minimum you will need:

- `BOT_TOKEN`
- `DATABASE_URL`
- `REDIS_URL`
- `WEBHOOK_DOMAIN`
- `WEBHOOK_SECRET`

The script talks directly to Telegram and the backing services, so make sure the
network from which you execute it can reach PostgreSQL, Redis and api.telegram.org.

## Usage

```bash
npm run bot:audit
```

The command prints an emoji-prefixed summary for each check. A green tick means
the check passed, a warning triangle highlights something that needs attention,
and a red cross indicates a blocking problem.

## Checks performed

- **Database connection** — Executes `SELECT now()` through the pool. Failure indicates the bot cannot reach PostgreSQL, which causes degraded behaviour and missed replies.
- **Redis connection** — Pings the configured Redis instance. Without Redis the session cache and queues stop progressing and conversations appear frozen.
- **Telegram bot token** — Calls `getMe` to ensure the token is valid. If the token was revoked or rotated without updating the environment, the bot goes silent immediately.
- **Telegram webhook** — Confirms that the webhook URL matches `WEBHOOK_DOMAIN/WEBHOOK_SECRET` and reports pending updates plus Telegram-side errors. A mismatch means Telegram is delivering updates to a different endpoint.
- **Telegram getUpdates backlog** — Attempts to poll updates. A `409 Conflict` means webhook mode is active (expected). Any other response is printed so you can see if updates are piling up because the webhook was disabled.

Warnings emitted by the webhook check include pending update counts and the last
error timestamps reported by Telegram. Use these hints to investigate whether the
bot endpoint is reachable from Telegram.

## Typical remediation steps

*Database or Redis errors* — verify credentials, firewall rules and SSL
requirements. The script reuses the same connection options as the bot, so the
output should guide you to the misconfigured service.

*Webhook mismatch* — reconfigure the load balancer or run the deployment pipeline
that exposes the correct domain. After fixing the routing, rerun the audit and
confirm that the webhook URL and pending update count return to normal.

*Pending Telegram updates* — if the webhook URL is correct but pending updates
keep growing, inspect the bot logs for HTTP 5xx responses. Clearing the queue with
`deleteWebhook({ drop_pending_updates: true })` may be necessary after the
underlying issue is fixed.

*Token check failures* — create a new bot token via BotFather and update the
environment variables, then run the audit again.

