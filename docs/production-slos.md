# Production SLO And Error-Budget Policy

Date: 2026-04-16

This policy codifies the P2 production-control targets used by release gating and operational review.

## SLOs

1. Stripe webhook success
- SLI: `card_ops_webhook_total` success rate where `processed + duplicate` are treated as successful handling and `failed` is treated as error.
- Objective: `>= 99.5%`
- Error budget: `0.5%`

2. Scheduler timeliness
- SLI: `calendar_scheduler_lag_ms`
- Objective: `<= 300000ms`
- Error budget: scheduler lag may not exceed 5 minutes.

3. Reconciliation freshness
- SLI: age of `/api/ops/reconcile/latest` report.
- Objective: `<= 1440 minutes`
- Error budget: latest reconciliation report may not be older than 24 hours.

4. Agent Bus MCP authentication
- SLI: rejected authenticated MCP calls grouped by the bounded `reason` label,
  plus the count of live sessions missing credentials in the readiness report.
- Objective during `issue_only`: all newly launched attempts receive a
  credential and the legacy-untrusted count trends to zero before enforcement.
- Objective during `enforce`: no unauthenticated calls are accepted and
  readiness remains `readyForEnforce=true`.
- Error budget: any accepted revoked/stale-generation/wrong-audience token,
  agent permission self-approval, out-of-root child creation, ordinary-agent
  creation of a privileged coordinator schedule, or caller-authored trusted
  coordinator metadata is a release-blocking security incident. Track
  registration outcomes with
  `loop_registration_total` and the `loop_registration` audit event.

## Release Gate

Run `npm run slo:check -- --base-url https://host:port` against a candidate environment, or pass captured JSON using `--metrics-file` and `--reconciliation-file`.

For the standard rollout path, use `scripts/install-fleet-service.sh` once to install the user service, then `scripts/server.sh update` for rollouts. The update path syncs the live worktree to `origin/main` before restarting.

The gate fails when any indicator exceeds the configured burn threshold:

- Default burn threshold: `2x`
- Env override: `SLO_RELEASE_BURN_RATE_THRESHOLD`
- Reconciliation freshness override: `SLO_RECONCILIATION_FRESHNESS_MAX_MINUTES`

Interpretation:

- `pass`: all indicators are within burn limits.
- `fail`: at least one indicator exceeded burn limits and the release should stop until the cause is understood or explicitly waived.

## Operational Notes

- Missing samples do not fail the gate by default; they are reported as `n/a` and should be treated as instrumentation debt.
- Duplicate Stripe webhook deliveries count as success because the handler is expected to absorb retries idempotently.
- Scheduler dispatch kill switches can intentionally increase scheduler lag; if a kill switch is active during a maintenance window, treat the gate result as advisory and record the waiver.
- When `SLO_BASE_URL` is unset, the CLI derives the probe target from `TLS_ENABLED`, `HOST`, and `PORT` in the active `.env`.
