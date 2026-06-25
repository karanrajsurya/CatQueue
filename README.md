# catQueue 🐱

A **Postgres-native job queue system** built with Node.js, TypeScript, and PostgreSQL — no Redis required.

> Built as a portfolio project demonstrating distributed systems concepts: atomic job locking, exponential backoff, dead letter queues, crash recovery, and idempotency — all on top of plain PostgreSQL.

---

## Why catQueue?

Most job queues (BullMQ, Bee-Queue) depend on Redis as a broker. catQueue proves you don't need it.

| Feature | catQueue | BullMQ |
|---|---|---|
| Broker dependency | PostgreSQL only | Redis required |
| Idempotency keys | ✅ First-class | ❌ Not built-in |
| Structured error log per attempt | ✅ JSON array | ❌ |
| Dead letter queue + replay | ✅ | ✅ |
| Atomic job locking | `SELECT FOR UPDATE SKIP LOCKED` | Redis SETNX |
| Crash recovery | ✅ | ✅ |

---

## Features

- **Atomic job locking** via PostgreSQL `SELECT FOR UPDATE SKIP LOCKED` — safe for concurrent workers
- **Exponential backoff** — failed jobs retry at `2^attemptCount` seconds
- **Dead letter queue** — jobs exceeding `maxAttempts` move to `DEAD` status
- **One-click replay** — reset any `DEAD` job back to `PENDING` via API
- **Crash recovery** — stuck `PROCESSING` jobs with expired `lockedUntil` are automatically reset
- **Idempotency keys** — duplicate job submissions return `409` instead of creating duplicates
- **Structured error logs** — every failed attempt appends to a JSON array with timestamp + error message
- **Priority queue** — jobs ordered by `priority ASC, runAt ASC`
- **Extensible handlers** — register any job type via `registerHandler(jobName, fn)`
- **Live dashboard** — React frontend showing real-time stats, job list, and per-job error timeline

---

## Tech Stack

**Backend:** Node.js, TypeScript, Express, PostgreSQL, Prisma v6 (with `@prisma/adapter-pg`)

**Frontend:** React, Vite, Tailwind CSS

---

## Project Structure

```
CatQueue/
├── Backend/
│   ├── prisma/
│   │   └── schema.prisma
│   ├── prisma.config.ts
│   └── src/
│       ├── index.ts              ← Express server + handler registration + startWorker
│       ├── lib/prisma.ts         ← PrismaClient singleton with PrismaPg adapter
│       ├── routes/jobs.ts        ← All 5 REST endpoints
│       └── worker/worker.ts      ← Polling loop, locking, retry, crash recovery
└── Frontend/
    └── src/
        ├── App.tsx
        ├── api/client.ts
        ├── components/
        │   ├── StatsBar.tsx
        │   ├── JobForm.tsx
        │   ├── JobsTable.tsx
        │   └── JobDetail.tsx
        └── types/job.types.ts
```

---

## Database Schema

Single `Job` table — no extra broker tables needed.

```prisma
model Job {
  id             String    @id @default(uuid())
  jobName        String
  payload        Json
  status         Status    @default(PENDING)
  priority       Int       @default(3)
  attemptCount   Int       @default(0)
  maxAttempts    Int       @default(5)
  runAt          DateTime  @default(now())
  lockedUntil    DateTime?
  workerId       String?
  idempotencyKey String?   @unique
  errorLog       Json?
  createdAt      DateTime  @default(now())
}

enum Status { PENDING PROCESSING COMPLETED DEAD }
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/jobs` | Enqueue a job (supports idempotency key) |
| `GET` | `/jobs?status=PENDING\|PROCESSING\|COMPLETED\|DEAD` | List jobs with optional filter |
| `GET` | `/jobs/:id` | Get single job detail + error log |
| `POST` | `/jobs/:id/replay` | Reset a DEAD job to PENDING |
| `GET` | `/queue/stats` | Returns `{ pending, processing, completed, dead }` |

---

## How the Worker Works

```
Every 2 seconds:
  1. SELECT FOR UPDATE SKIP LOCKED → atomically claim next job by priority + runAt
  2. Set status = PROCESSING, lockedUntil = now + 30s, workerId = uuid
  3. Run registered handler for jobName
  4. On success → status = COMPLETED
  5. On failure → attemptCount++, append to errorLog
       if attemptCount >= maxAttempts → status = DEAD
       else → runAt = NOW() + 2^attemptCount seconds (exponential backoff)
  6. Crash recovery: any PROCESSING job with lockedUntil < now → reset to PENDING
```

---

## Registering Job Handlers

```typescript
import { registerHandler } from './worker/worker';

registerHandler('send-email', async (payload) => {
  await mailer.send({ to: payload.to, subject: payload.subject });
});

registerHandler('resize-image', async (payload) => {
  await sharp(payload.url).resize(800).toFile(payload.output);
});
```

No hardcoded job types in the worker — fully extensible.

---

## Running Locally

### Prerequisites
- Node.js 20+
- PostgreSQL running on your machine

### Backend

```bash
cd Backend
npm install
# Create .env with DATABASE_URL=postgresql://user:pass@localhost:5433/catQueueDB
npx prisma migrate dev
npm run dev
```

### Frontend

```bash
cd Frontend
npm install
# Create .env with VITE_API_URL=http://localhost:3000
npm run dev
```

---

## Environment Variables

**Backend `.env`:**
```
DATABASE_URL=postgresql://user:password@localhost:5433/catQueueDB
PORT=3000
ALLOWED_ORIGINS=http://localhost:5173
```

**Frontend `.env`:**
```
VITE_API_URL=http://localhost:3000
```

---

## Roadmap

- [ ] Worker concurrency (`startWorker({ concurrency: 5 })`)
- [ ] Cron / scheduled jobs
- [ ] Job DAG — job B runs only after job A succeeds
- [ ] SSE real-time dashboard
- [ ] Webhook callbacks on job completion
- [ ] Per-job-type rate limiting
- [ ] Docker + Railway/Render deployment
- [ ] Test suite (worker simulation, retry logic)

---

## Author

**Karan Raj Surya** — B.Tech ECE, IIIT Allahabad

[LinkedIn](https://linkedin.com) · [GitHub](https://github.com)
