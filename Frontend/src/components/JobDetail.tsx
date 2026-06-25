import type { Job } from '../types/job.types';

const STATUS_COLORS: Record<string, string> = {
  PENDING:    'text-yellow-400 bg-yellow-400/10 border-yellow-500/30',
  PROCESSING: 'text-blue-400 bg-blue-400/10 border-blue-500/30',
  COMPLETED:  'text-green-400 bg-green-400/10 border-green-500/30',
  DEAD:       'text-red-400 bg-red-400/10 border-red-500/30',
};

interface Props { job: Job; onClose: () => void; onReplay: (id: string) => void; }

export default function JobDetail({ job, onClose, onReplay }: Props) {
  const fmt = (d: string) => new Date(d).toLocaleString();

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-zinc-950 border border-zinc-800 rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div>
            <div className="font-mono font-medium text-zinc-100">{job.jobName}</div>
            <div className="text-xs text-zinc-500 font-mono mt-0.5">{job.id}</div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-xs font-mono px-2 py-1 rounded border ${STATUS_COLORS[job.status]}`}>{job.status}</span>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-xl leading-none">×</button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-3 gap-3">
            {[
              ['Priority', job.priority],
              ['Attempts', `${job.attemptCount} / ${job.maxAttempts}`],
              ['Created', fmt(job.createdAt)],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-zinc-900 rounded-lg p-3">
                <div className="text-xs text-zinc-500 font-mono mb-1">{k}</div>
                <div className="text-sm font-mono text-zinc-200">{String(v)}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="text-xs text-zinc-500 font-mono mb-2">payload</div>
            <pre className="bg-zinc-900 rounded-lg px-4 py-3 text-xs font-mono text-green-300 overflow-x-auto">
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>

          {job.errorLog && job.errorLog.length > 0 && (
            <div>
              <div className="text-xs text-zinc-500 font-mono mb-2">retry history</div>
              <div className="space-y-2">
                {job.errorLog.map((entry, i) => (
                  <div key={i} className="bg-red-950/40 border border-red-900/40 rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-red-400">attempt {entry.attempt}</span>
                      <span className="text-xs font-mono text-zinc-500">{fmt(entry.at)}</span>
                    </div>
                    <div className="text-xs font-mono text-red-300">{entry.error}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {job.status === 'DEAD' && (
            <button
              onClick={() => { onReplay(job.id); onClose(); }}
              className="w-full bg-red-900/50 hover:bg-red-900 border border-red-800 text-red-300 font-mono text-sm py-2 rounded-lg transition-colors"
            >
              Replay job →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
