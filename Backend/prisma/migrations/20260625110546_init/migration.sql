-- CreateEnum
CREATE TYPE "Status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "Status" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "workerId" TEXT,
    "idempotencyKey" TEXT,
    "errorLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
