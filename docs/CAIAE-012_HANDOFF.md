# CAIAE-012 performance and release assurance

The mapped draft PR adds bounded synthetic operation sampling and loopback HTTP sampling. The API test now starts the real Fastify service on an ephemeral loopback port, sends 20 HTTP GET requests to `/ready`, and records p50/p95/p99 latency, success and failure counts. Under CI, `/ready` checks a real isolated PostgreSQL database and migration state. The first readiness response must identify the expected test release. The public lookup exercises an additional database-backed read path with a bounded concurrency of four. A failed response or unavailable database fails the test. Redirects and caller cancellation never count as successful samples.

The diagnostic is a small, single-process test-environment sample: readiness is sequential, while the public read uses four concurrent requests. It is useful for detecting a broken API/database path and for obtaining a reproducible measurement method. It is not production throughput, a concurrency limit, a latency SLO, a representative workload, or evidence of disaster recovery. CI timing is variable and no latency threshold is asserted.

Release acceptance still requires measurements from an authorized representative deployment with its actual database and traffic profile, documented target thresholds and repeatable results, an isolated restore rehearsal, and the production smoke/monitoring gates. On November 16, 2026 the owner directed that the software slice be merged with the local measurements below, honestly labelled; that representative-deployment evidence stays open follow-up work and is not claimed here. No live account, credential, service or production data is used by this test.

Run the read-only probe against an authorized local isolated API with `node scripts/benchmark-loopback.mjs http://127.0.0.1:3000/ready 20 4`. The URL must be credential-free loopback HTTP; the caller supplies the target and concurrency is capped at eight. CI runs both standalone benchmark suites through the root `npm test` script.

For a low-volume deployment sample, an operator may set `CAIAE_BENCH_API_URL` to the authorized HTTPS API origin and `CAIAE_BENCH_EXPECTED_RELEASE` to the full 40-character deployed commit, then run `node scripts/benchmark-release.mjs`. Optional `CAIAE_BENCH_ITERATIONS` is capped at 20; requests are sequential, credential-free GETs to `/ready`, with no redirects or cookies, five-second deadlines and 16-KiB response limits. The sampler fails its CLI exit status if any request or release identity check fails. A successful sample is still not a production SLO or release approval; review traffic, load, recovery and monitoring evidence separately.

Set `CAIAE_BENCH_WORKLOAD=public-db` for the optional public certificate lookup sample. It checks the full release identity before and after up to 20 sequential reads, requires a nonexistent certificate to remain invalid, and fails if the deployed release changes across the sample. This does not prove traffic mix, sustained load, or release acceptance.

## November 1 regression repair

Corrected overescaped schema/content-length regexes that rejected real readiness
responses. Both sample paths now keep a live deadline through headers and body,
abort on completion, and cancel rejected streams without waiting on uncooperative
cleanup. Body readers are cancelled on validation failures as well as timeouts.

The isolated release sampler suite passes 14 tests, including actual loopback
HTTP readiness/public reads with Content-Length and rejected-response cleanup.
The stalled-body fixture now supplies JSON media type so it reaches body reads.
No production SLO, live deployment, real database load or restore is established
by these local tests. Full exact-head CI remains separately required.

## Recorded local measurements (November 16, 2026)

**Local and synthetic only. Not production SLO, capacity or release-acceptance evidence.**

Environment: one 4-vCPU development VM (Intel Xeon 2.10 GHz), Node 24.22.1,
PostgreSQL 16.15 on the same host over loopback, empty freshly migrated
database (no tenants or certificates). The API and sweep worker ran together
through `scripts/start-free-plan.mjs` with `NODE_ENV=production`, sweeps every
30 seconds. Each row is one run of `scripts/benchmark-loopback.mjs` (bounded at
100 requests, two-second per-request deadline) or `scripts/benchmark-local.mjs`.
Runs were sequential and not repeated, so variance is unknown.

| Workload | Requests | OK / failed | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- |
| Synthetic JSON round trip (no API or database), 500 samples | 500 | n/a | 0.001 | 0.003 | 0.004 |
| `/ready` (API + PostgreSQL), concurrency 1 | 100 | 100 / 0 | 1.5 | 3.0 | 4.5 |
| `/ready`, concurrency 4 | 100 | 100 / 0 | 2.9 | 6.6 | 22.7 |
| `/ready`, concurrency 8 | 100 | 100 / 0 | 7.2 | 25.7 | 34.0 |
| `/ready?includeWorker=true` (worker health query), concurrency 4 | 100 | 100 / 0 | 3.0 | 7.3 | 22.4 |
| Public certificate lookup (database read, nonexistent code), concurrency 1 | 100 | 100 / 0 | 1.7 | 2.7 | 4.5 |
| Public certificate lookup, concurrency 4 | 100 | 100 / 0 | 4.3 | 11.7 | 23.7 |
| Public certificate lookup, concurrency 8 | 100 | 100 / 0 | 3.4 | 31.2 | 31.6 |

What this shows: every sampled request through the real Fastify API and
PostgreSQL succeeded. On an idle local host, at concurrency 1 the
database-backed paths had p95 under 3 ms; medians stayed under 8 ms up to
concurrency 8, while p95/p99 tails reached roughly 20-35 ms. What it does not show: behaviour
over a network, on Render's free instance (which sleeps and has a cold start),
against Neon, with real data volumes, or under sustained load. No latency
threshold is asserted. The hosted `caiae-api` demonstration could not be
sampled from the measurement environment, so `scripts/benchmark-release.mjs`
has not been run against a deployed release.
