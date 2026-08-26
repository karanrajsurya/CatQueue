import { Pool } from "pg";
import { randomUUID } from "crypto";
import {
  cronJobHandler,
  deleteStaleIdempotencyKeys,
} from "./delayedProcesses.js";
import { processNextBatch } from "./process.js";
import { recoverStuckJobs } from "./delayedProcesses.js";
import {
  CatQueueConfig,
  Handler,
  JobOptions,
  Job,
  StatsOptions,
  StatsObject,
} from "./types.js";
import { insertDependencyEdges } from "./inQueueProcesses.js";
import { createHash } from "crypto";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  private maxAttempts: number;
  private cron?: ReturnType<typeof cronJobHandler>;
  private dependencies?: string[];
  private maxPoolSize?: number;

  constructor(config: CatQueueConfig) {
    this.maxPoolSize = config.maxPoolSize;
    if (config.pool) {
      this.pool = config.pool;
      this.isExternalPool = true;
    } else {
      this.pool = new Pool({
        connectionString: config.connectionString,
        max: this.maxPoolSize ?? 20,
      });
    }
    this.pollInterval = config.pollInterval ?? 1000;
    this.lockDuration = config.lockDuration ?? 30;
    const n = Number(config.batchSize ?? 50);
    this.batchSize = Number.isInteger(n) ? Math.max(1, n) : 50;
    this.maxAttempts = config.maxAttempts ?? 5;
    this.dependencies = config.dependencies ?? [];
    this.id = randomUUID();
    this.job_name = "";
  }

private defaultIdempotencyKey(jobName: string, payload: unknown): string {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16); // short enough to stay cheap to index/compare
  return `${jobName}:${payloadHash}`;
}

async enqueue<T = any>(jobName: string, payload: T, options: JobOptions = {}): Promise<string> {
  const idempotency_key = options.idempotencyKey ?? this.defaultIdempotencyKey(jobName, payload);
  const deps = this.dependencies;

  if (!deps?.length) {
    const { rows } = await this.pool.query(
      `INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        jobName,
        JSON.stringify(payload),
        options.priority ?? 3,
        options.maxAttempts ?? 5,
        options.runAt ?? new Date(),
        idempotency_key,
        deps,
      ],
    );
    return rows[0].id;
  }

  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [jobName, JSON.stringify(payload), options.priority ?? 3, options.maxAttempts ?? 5,
       options.runAt ?? new Date(), idempotency_key, this.dependencies],
    );
    const jobId = rows[0].id;
    if (this.dependencies?.length) {
      await insertDependencyEdges(client, [{ id: jobId, dependencies: this.dependencies }]);
    }
    await client.query("COMMIT");
    return jobId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async enqueueBatch<T = any>(
  jobs: { jobName: string; payload: T; options?: JobOptions }[],
  dependencies?: string[],
): Promise<string[]> {
  const jobNames = jobs.map((j) => j.jobName);
  const payloads = jobs.map((j) => JSON.stringify(j.payload));
  const priorities = jobs.map((j) => j.options?.priority ?? 3);
  const maxAttempts = jobs.map((j) => j.options?.maxAttempts ?? 5);
  const runAts = jobs.map((j) => j.options?.runAt ?? new Date());
  const idempotencyKeys = jobs.map((j) =>
    j.options?.idempotencyKey ?? this.defaultIdempotencyKey(j.jobName, j.payload),
  );

  const insertSql = `
    INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
    SELECT job_name, payload, priority, max_attempts, run_at, idempotency_key, $7::text[]
    FROM UNNEST($1::text[], $2::jsonb[], $3::int[], $4::int[], $5::timestamptz[], $6::text[])
      AS t(job_name, payload, priority, max_attempts, run_at, idempotency_key)
    RETURNING id
  `;
  const params = [jobNames, payloads, priorities, maxAttempts, runAts, idempotencyKeys, dependencies ?? null];

  if (!dependencies?.length) {
    const { rows } = await this.pool.query(insertSql, params);
    return rows.map((r: any) => r.id);
  }

  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(insertSql, params);
    await insertDependencyEdges(client, rows.map((r: any) => ({ id: r.id, dependencies })));
    await client.query("COMMIT");
    return rows.map((r: any) => r.id);
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

  start(): void {
    if (this.running) return;
    this.running = true;

    this.cron = cronJobHandler(this.pool);

    this.workerPromise = (async () => {
      const recoveryInterval = setInterval(() => {
        recoverStuckJobs(this.pool).catch(console.error);
      }, 20000);

      const staleIdempotencyKeys = setInterval(() => {
        deleteStaleIdempotencyKeys(this.pool).catch(console.error);
      }, 3000);

      try {
        while (this.running) {
          let didWork = false;

          while (
            await processNextBatch(
              this.pool,
              this.handlers,
              this.workerId,
              this.lockDuration,
              this.batchSize,
            )
          ) {
            didWork = true;
          }

          if (!didWork) {
            await sleep(this.pollInterval);
          }
        }
      } finally {
        clearInterval(recoveryInterval);
        clearInterval(staleIdempotencyKeys);
      }
    })();
  }

  stats(): StatsQuery {
    return new StatsQuery(this.pool);
  }

  async stop(): Promise<void> {
    this.running = false;

    this.cron?.stop();

    if (this.workerPromise) {
      await this.workerPromise;
    }

    if (!this.isExternalPool) {
      await this.pool.end();
    }
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
