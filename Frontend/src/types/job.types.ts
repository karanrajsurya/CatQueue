export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'DEAD';

export interface ErrorLogEntry {
  attempt: number;
  error: string;
  at: string;
}

export interface Job {
  id: string;
  jobName: string;
  payload: Record<string, any>;
  status: JobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  lockedUntil: string | null;
  workerId: string | null;
  idempotencyKey: string | null;
  errorLog: ErrorLogEntry[] | null;
  createdAt: string;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  dead: number;
}

export interface EnqueuePayload {
  jobName: string;
  payload: Record<string, any>;
  priority: number;
  maxAttempts: number;
  runAt?: string;
  idempotencyKey?: string;
}
