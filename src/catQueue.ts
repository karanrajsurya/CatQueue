import { Pool } from "pg";
import { createHash, randomUUID } from "crypto";
import {
  cronJobHandler,
  deleteStaleIdempotencyKeys,
  flushCoalesced,
  recoverStuckJobs,
} from "./delayedProcesses.js";
import { processNextBatch } from "./process.js";
import {
  CatQueueConfig,
  Handler,
  JobOptions,
  Job,
  StatsOptions,
  StatsObject,
  PendingEntry,
} from "./types.js";
import { insertDependencyEdges } from "./inQueueProcesses.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EnqueueHandle {
  idempotencyKey: string;
  id: Promise<string>; // resolves once the job is saved to Postgres
}

export class CatQueue {
  private pool: Pool;
  private isExternalPool: boolean = false;
  private id: string;
  private job_name: string;
  private handlers: Map<string, Handler> = new Map();
  private running = false;
  private workerPromise?: Promise<void>;
  private workerId: string = randomUUID();
  private pollInterval: number;
  private lockDuration: number;
  private batchSize: number;
  private concurrency: number;
  private maxAttempts: number;
  private cron?: ReturnType<typeof cronJobHandler>;
  private dependencies?: string[];
  private maxPoolSize?: number;
  private maxRequests: number;
  private inFlightRequests: Map<string, PendingEntry> = new Map();
  private activeFlushTimer: NodeJS.Timeout | null = null;
  private flushDelayMs: number;
  private pendingFlushes: Map<string, PendingEntry> = new Map();

  private flushSignal: { promise: Promise<void>; resolve: () => void } =
    this.createSignal();

  constructor(config: CatQueueConfig) {
    this.concurrency = config.concurrency ?? 30;
    this.maxPoolSize = config.maxPoolSize ?? (this.concurrency + 10);
    if (config.pool) {
      this.pool = config.pool;
      this.isExternalPool = true;
    } else {
      this.pool = new Pool({
        connectionString: config.connectionString,
        max: this.maxPoolSize,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 10000,
        keepAlive: true,
      });
    }
    this.pollInterval = config.pollInterval ?? 10;
    this.lockDuration = config.lockDuration ?? 30;
    const n = Number(config.batchSize ?? 500);
    this.batchSize = Number.isInteger(n) ? Math.max(1, n) : 500;
    this.maxAttempts = config.maxAttempts ?? 5;
    this.dependencies = config.dependencies ?? [];
    this.id = randomUUID();
    this.job_name = "";
    this.maxRequests = this.batchSize;
    this.flushDelayMs = 16;
  }

  private createSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  private notifyFlush(): void {
    const prev = this.flushSignal;
    this.flushSignal = this.createSignal();
    prev.resolve();
  }

  defaultIdempotencyKey(jobName: string, payload: unknown) {
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 16);
    return `${jobName}:${payloadHash}`;
  }

  private triggerFlush(force = false): void {
  if (this.activeFlushTimer) {
    if (force) {
      clearTimeout(this.activeFlushTimer);
      this.activeFlushTimer = null;
    } else {
      return;
    }
  }

  const delay = force ? 0 : this.flushDelayMs;
  this.activeFlushTimer = setTimeout(() => {
    this.activeFlushTimer = null;
    void flushCoalesced(this.pool, this.inFlightRequests, this.pendingFlushes).finally(() => {
      this.notifyFlush();
    });
  }, delay);
}

  async enqueue<T = any>(
  jobName: string,
  payload: T,
  options: JobOptions = {},
): Promise<EnqueueHandle> {
  if (!this.running) {
    throw new Error("Cannot enqueue jobs when the queue is stopped.");
  }

  const dependencyList = options.dependencies ?? this.dependencies ?? [];
  const key =
    options.idempotencyKey ?? this.defaultIdempotencyKey(jobName, payload);

  // Coalesce against a key's full lifecycle: buffered OR actively
  // flushing. Checked before backpressure - a duplicate that's just
  // going to attach to an existing promise shouldn't have to wait on
  // buffer space it doesn't need.
  const existing = this.inFlightRequests.get(key) ?? this.pendingFlushes.get(key);
  if (existing) return { idempotencyKey: key, id: existing.promise };

  while (this.inFlightRequests.size >= this.maxRequests) {
    this.triggerFlush(true);
    await this.flushSignal.promise;

    // The key may have appeared in either map while this call was
    // parked on the signal - re-check before assuming it's still new.
    const afterWait = this.inFlightRequests.get(key) ?? this.pendingFlushes.get(key);
    if (afterWait) return { idempotencyKey: key, id: afterWait.promise };
  }

  let resolveFn!: (id: string) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  this.inFlightRequests.set(key, {
    jobName,
    payload,
    options: { ...options, dependencies: dependencyList },
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  });

  if (this.inFlightRequests.size >= this.maxRequests) {
    this.triggerFlush(true);
  } else if (!this.activeFlushTimer) {
    this.triggerFlush();
  }

  return { idempotencyKey: key, id: promise };
}

  async enqueueBatch<T = any>(
    jobs: {
      jobName: string;
      payload: T;
      options?: JobOptions;
      dependencies?: string[];
    }[],
    dependencies?: string[],
  ): Promise<(string | undefined)[]> {
    if (this.running === false) {
      throw new Error("Cannot enqueue jobs when the queue is stopped.");
    }

    const normalizedDependencies = jobs.map((job) =>
      JSON.stringify(
        job.options?.dependencies ??
          job.dependencies ??
          dependencies ??
          this.dependencies ??
          [],
      ),
    );
    const jobNames = jobs.map((j) => j.jobName);
    const payloads = jobs.map((j) => JSON.stringify(j.payload));
    const priorities = jobs.map((j) => j.options?.priority ?? 3);
    const maxAttempts = jobs.map((j) => j.options?.maxAttempts ?? 5);
    const runAts = jobs.map((j) => j.options?.runAt ?? new Date());
    const idempotencyKeys = jobs.map(
      (j) => j.options?.idempotencyKey ?? this.defaultIdempotencyKey(j.jobName, j.payload),
    );

    const insertJobs = `
      INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
      SELECT job_name, payload, priority, max_attempts, run_at, idempotency_key,
             ARRAY(SELECT jsonb_array_elements_text(dependencies))
      FROM UNNEST(
        $1::text[],
        $2::jsonb[],
        $3::int[],
        $4::int[],
        $5::timestamptz[],
        $6::text[],
        $7::jsonb[]
      ) AS t(job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id, idempotency_key, dependencies
    `;
    const params = [
      jobNames,
      payloads,
      priorities,
      maxAttempts,
      runAts,
      idempotencyKeys,
      normalizedDependencies,
    ];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(insertJobs, params);

      const idByKey = new Map<string, { id: string; dependencies: string[] }>(
        rows.map((r: any) => [
          r.idempotency_key,
          {
            id: r.id,
            dependencies: Array.isArray(r.dependencies) ? r.dependencies : [],
          },
        ]),
      );

      // Keys that hit ON CONFLICT DO NOTHING weren't returned above —
      // resolve them against existing rows instead of leaving them undefined.
      const missingKeys = idempotencyKeys.filter((k) => !idByKey.has(k));
      if (missingKeys.length > 0) {
        const { rows: existing } = await client.query(
          `SELECT id, idempotency_key FROM catqueue_jobs WHERE idempotency_key = ANY($1::text[])`,
          [missingKeys],
        );
        for (const r of existing) {
          idByKey.set(r.idempotency_key, { id: r.id, dependencies: [] });
        }
      }

      const insertedRows = rows
        .filter((r: any) => Array.isArray(r.dependencies) && r.dependencies.length > 0)
        .map((r: any) => ({ id: r.id, dependencies: r.dependencies }));
      if (insertedRows.length > 0) {
        await insertDependencyEdges(client, insertedRows);
      }

      await client.query("COMMIT");

      // Return ids in the SAME order as the input `jobs` array —
      // do not rely on undefined row-ordering from INSERT ... SELECT ... UNNEST.
      return idempotencyKeys.map((key) => idByKey.get(key)?.id);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  register<T = any>(jobName: string, handler: Handler<T>): void {
    this.handlers.set(jobName, handler);
  }

  private runWorkerLoop(): Promise<void> {
    this.cron = cronJobHandler(this.pool);

    return (async () => {
      const recoveryInterval = setInterval(() => {
        recoverStuckJobs(this.pool).catch(() => {});
      }, 20000);

      const staleIdempotencyKeys = setInterval(() => {
        deleteStaleIdempotencyKeys(this.pool).catch(() => {});
      }, 3000);

      try {
        while (this.running) {
          try {
            let didWork = false;

            while (
              await processNextBatch(
                this.pool,
                this.handlers,
                this.workerId,
                this.lockDuration,
                this.concurrency,
              )
            ) {
              didWork = true;
            }

            if (!didWork) {
              await sleep(this.pollInterval);
            }
          } catch (err) {
            await sleep(200);
          }
        }
      } finally {
        clearInterval(recoveryInterval);
        clearInterval(staleIdempotencyKeys);
      }
    })();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.workerPromise = this.runWorkerLoop();
  }

  async drain(): Promise<void> {
  while (
    this.inFlightRequests.size > 0 ||
    this.pendingFlushes.size > 0 ||
    this.activeFlushTimer
  ) {
    this.triggerFlush(true);
    const pending = [
      ...Array.from(this.inFlightRequests.values()),
      ...Array.from(this.pendingFlushes.values()),
    ].map((e) => e.promise);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    } else {
      await sleep(1);
    }
  }
}

  async stop(): Promise<void> {
    this.running = false;
    this.cron?.stop();

    await this.drain();

    if (this.workerPromise) {
      await this.workerPromise;
    }

    if (!this.isExternalPool) {
      await this.pool.end();
    }
  }

  stats(): StatsQuery {
    return new StatsQuery(this.pool);
  }

  pause(): void {
    this.running = false;
    this.cron?.stop();
  }

  resume(): void {
    if (this.running) return;
    this.running = true;
    this.workerPromise = this.runWorkerLoop();
  }
}

class StatsQuery {
  constructor(private pool: Pool) {}

  async overview(): Promise<StatsOptions> {
    const result = await this.pool.query<StatsObject>(`
      SELECT status, COUNT(*)::int FROM catqueue_jobs GROUP BY status`);

    return { stats: result.rows };
  }

  async failureRate(
    timeStamp: `${number} ${"min" | "hour" | "day"}`,
  ): Promise<number> {
    const result = await this.pool.query<{ rate: number }>(
      `
      SELECT COUNT(*) FILTER(WHERE status = 'DEAD')::float
        / NULLIF(COUNT(*), 0) AS rate
      FROM catqueue_jobs
      WHERE created_at > Now() - $1::interval
    `,
      [timeStamp],
    );

    return result.rows[0]?.rate ?? -1;
  }

  async retryCount(jobId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT attempt_count FROM catqueue_jobs WHERE id = $1
    `,
      [jobId],
    );
    return result.rows[0]?.attempt_count ?? -1;
  }

  async deadJobs(): Promise<Job[]> {
    const result = await this.pool.query<Job>(
      `
      SELECT * FROM catqueue_jobs
      WHERE status = 'DEAD'  
    `,
    );
    return result.rows;
  }
}
