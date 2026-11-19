# Mentorship backend availability

This scheduled Cloudflare Worker checks
`https://minerva-be-mentorship.onrender.com/api/health`. It does not host the
Minerva API or database. The API runs on Render and connects to MongoDB.

## Schedule and health checks

Deploy this instance with `wrangler deploy --env mentorship` from this directory.
Always specify the environment: the default configuration targets the original
Minerva API, not the mentorship copy.

The mentorship schedule runs every five minutes from 06:00 through 22:59 WIB,
plus 01:00 through 01:59 WIB to cover the backend's 19:00 UTC reminder job.
Cloudflare Cron expressions use UTC. Changes can take up to 15 minutes to
propagate.

The checker bypasses caches, waits for the application's JSON health response,
and requires both `status: ok` and `database.status: connected`. Each request has
a 40-second deadline. A failed check retries twice, after 5 and 10 seconds. A
persistently failing check rejects the scheduled invocation and logs an error.
HTTP 200 loading pages and degraded database responses are failures.

Workers Logs are enabled for the mentorship environment. Each attempt records
the target origin, HTTP status, attempt number, and outcome. Successful checks
also record total duration. No response bodies or credentials are logged.

## Investigating an outage

1. Check `/api/health` and a public data endpoint such as
   `/api/scholarships?pageSize=1`.
2. Inspect the `minerva-mentorship-keep-warm` Worker logs around the failure in
   UTC (subtract seven hours from WIB). Cron invocation success alone was not
   reliable before this change: the old checker swallowed non-2xx responses.
3. In Render, inspect the mentorship service's Events and runtime logs for
   spin-downs, restarts, deployment failures, memory exhaustion, database
   connection errors, and quota suspension. Confirm its branch and commit.
4. If the backend is healthy, inspect the frontend's `API_ORIGIN` and reproduce
   the same request through the frontend proxy.

## Limits of the free deployment

Render's free instances sleep after 15 minutes without incoming traffic and
can restart at any time. A scheduler reduces ordinary idle cold starts but does
not provide always-on hosting or an availability guarantee. The 750 free
instance-hours allowance is shared across the entire Render workspace, not
allocated separately to this service. Increasing ping frequency does not remove
that shared limit.

For an always-on deployment, switch the affected Render service to a paid
instance after the account owner approves the recurring charge. Do not describe
a keep-awake worker as a permanent replacement for that hosting guarantee.

References:
- https://render.com/docs/free
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
