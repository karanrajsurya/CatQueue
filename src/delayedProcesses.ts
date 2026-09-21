import { Pool } from "pg";
import { CronJob } from "cron";
import { cleanCompletedJobs, insertDependencyEdges } from "./inQueueProcesses.js";
import { PendingEntry } from "./types.js";

export async function flushCoalesced(
  pool: Pool,
  inFlightRequests: Map<string, PendingEntry>,
  pendingFlushes: Map<string, PendingEntry>,
): Promise<void> {
  const batch = Array.from(inFlightRequests.entries());
  if (batch.length === 0) return;

  for (const [key, entry] of batch) {
    pendingFlushes.set(key, entry);
  }
  inFlightRequests.clear();

  const resolveEntry = (key: string, entry: PendingEntry, id: string) => {
    entry.resolve(id);
    pendingFlushes.delete(key);
  };
  const rejectEntry = (key: string, entry: PendingEntry, err: unknown) => {
    entry.reject(err);
    pendingFlushes.delete(key);
  };

  const resolveAndInsertDependencyEdges = async (
    key: string,
    entry: PendingEntry,
    jobId: string,
  ): Promise<void> => {
    const dependencies = entry.options.dependencies ?? [];
    if (dependencies.length > 0) {
      await insertDependencyEdges(pool, [{ id: jobId, dependencies }]);
    }
    resolveEntry(key, entry, jobId);
  };

  if (batch.length === 1) {
    const [[key, entry]] = batch;
    try {
      const { rows } = await pool.query(
        `INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
         RETURNING id`,
        [
          entry.jobName,
          JSON.stringify(entry.payload),
          entry.options.priority ?? 3,
          entry.options.maxAttempts ?? 5,
          entry.options.runAt ?? new Date(),
          key,
          entry.options.dependencies ?? [],
        ],
      );
      await resolveAndInsertDependencyEdges(key, entry, rows[0].id);
    } catch (err) {
      rejectEntry(key, entry, err);
    }
    return;
  }

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
        SELECT job_name, payload, priority, max_attempts, run_at, idempotency_key,
                ARRAY(SELECT jsonb_array_elements_text(dependencies))
        FROM UNNEST(
          $1::text[], $2::jsonb[], $3::int[], $4::int[], $5::timestamptz[], $6::text[], $7::jsonb[]
        ) AS t(job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
        RETURNING id, idempotency_key, dependencies
        `,
      [
        batch.map(([, e]) => e.jobName),
        batch.map(([, e]) => JSON.stringify(e.payload)),
        batch.map(([, e]) => e.options.priority ?? 3),
        batch.map(([, e]) => e.options.maxAttempts ?? 5),
        batch.map(([, e]) => e.options.runAt ?? new Date()),
        batch.map(([key]) => key),
        batch.map(([, e]) => JSON.stringify(e.options.dependencies ?? [])),
      ],
    );

    const idByKey = new Map(
      rows.map((r: any) => [
        r.idempotency_key,
        {
          id: r.id,
          dependencies: Array.isArray(r.dependencies) ? r.dependencies : [],
        },
      ]),
    );

    for (const [key, entry] of batch) {
      const row = idByKey.get(key);
      if (!row) {
        rejectEntry(key, entry, new Error(`No id returned for key ${key}`));
        continue;
      }
      if (row.dependencies.length > 0) {
        await insertDependencyEdges(pool, [{ id: row.id, dependencies: row.dependencies }]);
      }
      resolveEntry(key, entry, row.id);
    }
  } catch (err) {
    for (const [key, entry] of batch) {
      try {
        const dependencies = entry.options.dependencies ?? [];
        const { rows } = await pool.query(
          `INSERT INTO catqueue_jobs (job_name, payload, priority, max_attempts, run_at, idempotency_key, dependencies)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[]) RETURNING id`,
          [
            entry.jobName,
            JSON.stringify(entry.payload),
            entry.options.priority ?? 3,
            entry.options.maxAttempts ?? 5,
            entry.options.runAt ?? new Date(),
            key,
            dependencies,
          ],
        );
        if (dependencies.length > 0) {
          await insertDependencyEdges(pool, [{ id: rows[0].id, dependencies }]);
        }
        resolveEntry(key, entry, rows[0].id);
      } catch (fallbackErr) {
        rejectEntry(key, entry, fallbackErr);
      }
    }
  }
}

export async function deleteStaleIdempotencyKeys(pool: Pool) {
  try {
    await pool.query(`
      UPDATE catqueue_jobs
      SET idempotency_key = NULL
      WHERE (status = 'DEAD' OR status = 'COMPLETED')
        AND (completed_at < NOW() - INTERVAL '1 minute' OR completed_at IS NULL)
    `);
  } catch (err) {
    console.log(`Error deleting stale idempotencyKeys: ${err}`);
  }
}

export const recoverStuckJobs = async (pool: Pool): Promise<void> => {
  try {
    await pool.query(`
      UPDATE catqueue_jobs
      SET status = 'PENDING', locked_until = NULL, worker_id = NULL
      WHERE status = 'PROCESSING' AND locked_until < NOW()
    `);
  } catch (err) {
    console.log(`Error recovering stuck jobs: ${err}`);
  }
};

export const cronJobHandler = (pool: Pool) =>
  new CronJob(
    "0 5 * * 1",
    async function () {
      try {
        const result = await cleanCompletedJobs(pool);
        console.log(
          `[catqueue] Cleanup: removed ${result.rowCount} completed jobs`,
        );
      } catch (err) {
        console.warn("[catqueue] Cleanup failed:", (err as Error).message);
      }
    },
    null, // on completed - set null
    true, // start automatically
    "Asia/Kolkata",
  );
