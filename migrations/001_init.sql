CREATE TYPE catqueue_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD', 'CYCLIC');

CREATE TABLE IF NOT EXISTS catqueue_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name        TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          catqueue_status DEFAULT 'PENDING',
  priority        INT DEFAULT 3,
  attempt_count   INT DEFAULT 0,
  max_attempts    INT DEFAULT 5,
  run_at          TIMESTAMPTZ DEFAULT NOW(),
  locked_until    TIMESTAMPTZ,
  worker_id       TEXT,
  idempotency_key TEXT UNIQUE,
  error_log       JSONB DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  dependencies    VARCHAR[] DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS job_dependencies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES catqueue_jobs(id) ON DELETE CASCADE,
  depends_on UUID NOT NULL REFERENCES catqueue_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catqueue_claim ON catqueue_jobs (run_at, priority ASC, created_at ASC) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_job_deps_job_id ON job_dependencies (job_id);
CREATE INDEX IF NOT EXISTS idx_job_deps_depends_on ON job_dependencies (depends_on);

CREATE OR REPLACE FUNCTION catqueue_resolve_dependencies()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_dependencies WHERE job_id = OLD.job_id) THEN
    UPDATE catqueue_jobs
    SET status = 'PENDING'
    WHERE id = OLD.job_id AND status = 'WAITING';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_resolve_dependencies
AFTER DELETE ON job_dependencies
FOR EACH ROW
EXECUTE FUNCTION catqueue_resolve_dependencies();