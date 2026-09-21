# catqueue

> A Redis-free, PostgreSQL-native job queue for Node.js.

If you already run PostgreSQL, you don't need Redis for job queuing — one table, one migration, no broker.

- [Why catqueue?](#why-catqueue)
- [Benchmark](#benchmark)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Automatic Cleanup](<#automatic-cleanup-(built-in-cron)>)
- [Job Dependencies (DAG)](<#job-dependencies-(dag-execution)-work-in-progress>)
- [Job Lifecycle](#job-lifecycle)
- [Retry Schedule](#retry-schedule)
- [When to use catqueue vs BullMQ](#when-to-use-catqueue-vs-bullmq)
- [Known Issues](#known-issues)
- [Requirements](#requirements)

```bash
npm install catqueue
```

---

## Why catqueue?

| Feature               | catqueue                                | BullMQ                     |
| ---------------------- | ---------------------------------------- | --------------------------- |
| Broker required       | PostgreSQL only                         | Redis required              |
| Idempotency keys      | ✅ Built-in                              | ❌ Manual                   |
| Per-attempt error log | ✅ JSON array in Postgres                | ❌                          |
| Dead-letter + replay  | ✅                                        | ✅                          |
| Atomic job locking    | `SELECT FOR UPDATE SKIP LOCKED`         | Redis SETNX                 |
| Crash recovery        | ✅ Visibility timeout                    | ✅                          |
| Worker scheduling     | Chunked prefetch, concurrency-windowed  | One job at a time per worker|
| TypeScript support    | ✅ Full generics                         | ✅                          |
| Queryable job history | ✅ Plain SQL                             | ❌ Redis expiry             |

---

## Benchmark

Single run, latest code:

| Scenario                              | catqueue | BullMQ | pg-boss |
| -------------------------------------- | -------- | ------ | ------- |
| Sequential Stress — 60k jobs (ops/sec)*| 29,341   | —      | —       |
| Sequential Add — 10k jobs              | 22,056   | 22,643 | 1,712   |
| Parallel Add — 50k jobs, batch=20k     | 45,348   | 65,230 | 10,750  |
| Bulk Add — 50k jobs, chunk=6k          | 66,138   | 48,155 | 106,799 |
| Processing — 50k jobs, concurrency=30  | 10,538   | 10,383 | —       |

- catqueue roughly matches BullMQ on Sequential Add and wins Processing; pg-boss wins Bulk Add outright.
- BullMQ wins Parallel Add consistently — Redis beats a Postgres round trip under high concurrent-producer load.
- Numbers are a single run, not an average — Processing throughput has shown up to ~5.6x run-to-run variance previously. Re-run before quoting these anywhere that matters.
- *Sequential Stress (catqueue-only, no baseline) hasn't been re-verified with a data-integrity check since the last fix to its benchmark harness (a `queue.stop()` that wasn't awaited). Re-run and confirm a clean row count before citing this number.

```bash
git clone https://github.com/karanrajsurya/CatQueue_npm_package
cd CatQueue_npm_package
npm install
# set DATABASE_URL, REDIS_URL in .env
node benchmark.js
```

---

## Quick Start

### 1. Run the migration

```bash
psql YOUR_CONNECTION_STRING -f node_modules/catqueue/migrations/001_init.sql
```

### 2. Use it

```typescript
import { CatQueue } from "catqueue";

const queue = new CatQueue({ connectionString: process.env.DATABASE_URL! });

queue.register("send-email", async (payload) => {
  await mailer.send({ to: payload.to, subject: payload.subject });
});

queue.start();

const { id } = await queue.enqueue("send-email", {
  to: "user@example.com",
  subject: "Welcome!",
});
const jobId = await id; // resolves once actually persisted
```

> `enqueue()` returns `{ idempotencyKey, id }`, not a bare job ID — `id` is a `Promise<string>` that resolves once the buffered job is actually flushed to Postgres. Breaking change from versions where `enqueue()` returned `Promise<string>` directly.

---

## API Reference

### `new CatQueue(config)`

```typescript
const queue = new CatQueue({
  connectionString: string,  // required
  pollInterval?: number,     // ms to sleep when idle, default: 10
  lockDuration?: number,     // seconds a job stays locked, default: 30
  batchSize?: number,        // buffer/fetch size per round trip, default: 500
  maxAttempts?: number,      // default: 5
  maxPoolSize?: number,      // pg Pool max connections, default: concurrency + 10
  concurrency?: number,      // default: 30
});
```

### `queue.enqueue(jobName, payload, options?)`

Buffers a job and returns immediately; durability comes from awaiting `.id`.

```typescript
const { id } = await queue.enqueue(
  "send-email",
  { to: "user@example.com" },
  {
    priority: 1,       // 1 = urgent, 5 = low. default: 3
    maxAttempts: 3,
    runAt: new Date(Date.now() + 60_000),
    idempotencyKey: "welcome-email-user-123",
  },
);
const jobId = await id;
```

A duplicate `idempotencyKey` rejects with a unique-constraint error rather than inserting twice. Stale keys are cleared automatically after ~1 minute.

### `queue.enqueueBatch(jobs)`

Inserts many jobs in one round trip via `UNNEST`. Returns job IDs in input order.

```typescript
const jobIds = await queue.enqueueBatch([
  { jobName: "send-email", payload: { to: "a@example.com" } },
  { jobName: "send-email", payload: { to: "b@example.com" }, options: { priority: 1 } },
]);
```

Prefer this over looping `enqueue()` for bulk-shaped work — it's a single `UNNEST` insert instead of per-job buffering overhead.

### `queue.register(jobName, handler)`

Must be called before `queue.start()`.

```typescript
queue.register<{ to: string; subject: string }>("send-email", async (payload) => {
  await mailer.send({ to: payload.to, subject: payload.subject });
});
```

### `queue.start()`

Starts the worker loop, plus background timers for stuck-job recovery (every 20s), stale idempotency-key cleanup (every 3s), and the weekly cleanup cron.

Each pass: claims a chunk via `SELECT ... FOR UPDATE SKIP LOCKED` (sized `max(concurrency × 10, 500)`), streams claims into a concurrency-bounded pool, prefetches the next chunk in the background, and batches successful completions into one `UPDATE` per 100 jobs. Failures are updated individually (see [Retry Schedule](#retry-schedule)). A job with no registered handler is reset to `PENDING`, not failed.

### `queue.stop()`

```typescript
process.on("SIGINT", async () => {
  await queue.stop();
  process.exit(0);
});
```

**Always await it** — it drains buffered jobs before closing the pool. Unawaited, trailing buffered jobs can be lost.

### `queue.pause()` / `queue.resume()`

```typescript
queue.pause();  // stop claiming work, keep the pool open
queue.resume(); // relaunch the worker loop
```

### `queue.stats()`

```typescript
await queue.stats().overview();          // counts by status
await queue.stats().failureRate("6 min"); // DEAD / total
await queue.stats().retryCount(jobId);
await queue.stats().deadJobs();
```

---

## Automatic Cleanup (Built-in Cron)

Every Monday at 5:00 AM IST, catqueue deletes `COMPLETED` jobs older than 7 days:

```sql
DELETE FROM catqueue_jobs
WHERE status = 'COMPLETED' AND completed_at < NOW() - INTERVAL '7 days'
```

Runs while `start()`ed; stops on `stop()`/`pause()`. Query completed jobs before they age out if you need to keep them longer.

---

## Job Dependencies (DAG) — Work in Progress

**Not safe to use yet.** Current state:

- `claimRunnableJobs` skips a job if it has an edge in `job_dependencies` pointing at a non-`COMPLETED` job — but edges are written *after* the job row is already visible to the poller, so a job's first claim attempt can race past its own not-yet-written dependencies.
- `dependencies` is set per **queue instance**, not per job, for `enqueue()` (every job on that instance shares the list). `enqueueBatch()` does support per-job `dependencies`.
- `GraphProcess.ts` (topological sort + cycle detection) had a wrong column name (`id` vs `job_id`) — fixed — but it's still not called from `processNextBatch`. Dead code.
- `CYCLIC` exists as a status but nothing sets it; a cyclic job just stays `PENDING` forever instead of being flagged.
- A schema trigger (`trigger_resolve_dependencies`) references a `'WAITING'` status that doesn't exist in the enum. It would error if it ever fired, but nothing currently deletes `job_dependencies` rows, so it never has.

---

## Job Lifecycle

```
PENDING → PROCESSING → COMPLETED
               ↓ (on failure)
        attempt_count++, error_log appended, run_at = now + 2^attempt seconds
               ↓
          back to PENDING → (after max_attempts) → DEAD
```

`DEAD` jobs are queryable/replayable for 7 days, then cleaned up by cron.

---

## Retry Schedule

| Attempt | Retry after |
| ------- | ----------- |
| 1       | 2s          |
| 2       | 4s          |
| 3       | 8s          |
| 4       | 16s         |
| 5       | → DEAD      |

---

## When to use catqueue vs BullMQ

**catqueue:** already on Postgres, want durable/queryable job history, insert-heavy workload, want zero extra infra.

**BullMQ:** need max Parallel Add throughput under many concurrent producers, already on Redis, need sub-10ms pickup latency, need rate limiting / job flows / repeatable jobs.

**vs pg-boss:** catqueue leads on Sequential Add, Parallel Add, and Processing; pg-boss wins Bulk Add outright. pg-boss is more established and has working DAG support today, which catqueue doesn't yet.

---

## Known Issues

- Dependency edges can be written after a job is already claimable — race window on first claim. See [Job Dependencies](<#job-dependencies-(dag-execution)-work-in-progress>).
- `GraphProcess.ts` is correct but unused — not called from `processNextBatch`.
- Schema trigger references a nonexistent `'WAITING'` status (dormant, never fires).
- Processing throughput has shown up to ~5.6x run-to-run variance. Not yet root-caused.
- Sequential Stress benchmark number is unverified since the last harness fix — re-run before citing it.

---

## Requirements

- Node.js 18+
- PostgreSQL 13+ (`gen_random_uuid()`, `SKIP LOCKED`)

---

## License

MIT © [Karan Raj Surya](https://github.com/karanrajsurya)
