import prisma from "../lib/prisma";

// worker.ts
type HandlerMap = Record<string, (payload: any) => Promise<void>>;

let registeredHandlers: HandlerMap = {};

export const registerHandler = (
  jobName: string,
  fn: (payload: any) => Promise<void>,
) => {
  registeredHandlers[jobName] = fn;
};

const processNextJob = async () => {
  // find + lock the job atomically
  const jobs = await prisma.$queryRaw<any[]>`
    UPDATE "Job"
    SET status = 'PROCESSING',
        "lockedUntil" = NOW() + INTERVAL '30 seconds',
        "workerId" = 'worker-1'
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'PENDING'
      AND "runAt" <= NOW()
      ORDER BY priority ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  const job = jobs[0];
  if (!job) return; // no pending jobs, do nothing

  console.log(`Picked up job: ${job.jobName} (${job.id})`);

  // step 2: find the right handler
  const handler = registeredHandlers[job.jobName];

  try {
    if (!handler) throw new Error(`No handler for job: ${job.jobName}`);

    await handler(job.payload);

    // step 3: success → mark completed
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "COMPLETED", lockedUntil: null, workerId: null },
    });

    console.log(`Job completed: ${job.id}`);
  } catch (error: any) {
    const nextAttempt = job.attemptCount + 1;
    const isDead = nextAttempt >= job.maxAttempts;

    // get existing errorLog array or start fresh
    const existingLog = Array.isArray(job.errorLog) ? job.errorLog : [];
    const newErrorLog = [
      ...existingLog,
      {
        attempt: nextAttempt,
        error: error.message,
        at: new Date().toISOString(),
      },
    ];

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: isDead ? "DEAD" : "PENDING",
        attemptCount: nextAttempt,
        runAt: isDead
          ? job.runAt
          : new Date(Date.now() + Math.pow(2, nextAttempt) * 1000),
        lockedUntil: null,
        workerId: null,
        errorLog: newErrorLog,
      },
    });

    console.log(
      isDead ? `Job dead: ${job.id}` : `Job retry ${nextAttempt}: ${job.id}`,
    );
  }
};

// recover crashed jobs
const recoverStuckJobs = async () => {
  const stuck = await prisma.job.updateMany({
    where: {
      status: "PROCESSING",
      lockedUntil: { lt: new Date() },
    },
    data: {
      status: "PENDING",
      lockedUntil: null,
      workerId: null,
    },
  });
  if (stuck.count > 0) console.log(`Recovered ${stuck.count} stuck jobs`);
};

export const startWorker = () => {
  console.log("Worker started, polling every 2s...");
  setInterval(async () => {
    await recoverStuckJobs();
    await processNextJob();
  }, 2000);
};
