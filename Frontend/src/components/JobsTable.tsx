import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Job, JobStatus } from '../types/job.types';
import JobDetail from './JobDetail';

const TABS = ['ALL', 'PENDING', 'PROCESSING', 'COMPLETED', 'DEAD'] as const;
type Tab = typeof TABS[number];

const STATUS_COLORS: Record<string, string> = {
  PENDING:    'text-yellow-400 bg-yellow-400/10 border-yellow-500/30',
  PROCESSING: 'text-blue-400 bg-blue-400/10 border-blue-500/30',
  COMPLETED:  'text-green-400 bg-green-400/10 border-green-500/30',
  DEAD:       'text-red-400 bg-red-400/10 border-red-500/30',
};

interface Props { refreshKey: number; }

export default function JobsTable({ refreshKey }: Props) {
  const [tab, setTab]           = useState<Tab>('ALL');
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState<Job | null>(null);

  const fetchJobs = () => {
    setLoading(true);
    api.getJobs(tab === 'ALL' ? undefined : tab)
      .then(setJobs)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchJobs(); }, [tab, refreshKey]);

  const handleReplay = async (id: string) => {
    try {
      await api.replay(id);
      fetchJobs();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const fmt = (d: string) => new Date(d).toLocaleString();

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Jobs</h2>
        <button onClick={fetchJobs} className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors">↻ refresh</button>
      </div>

      <div className="flex border-b border-zinc-800">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-mono transition-colors ${tab === t ? 'text-zinc-100 border-b-2 border-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 text-center text-xs font-mono text-zinc-600">loading...</div>
      ) : jobs.length === 0 ? (
        <div className="py-12 text-center text-xs font-mono text-zinc-600">no jobs found</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              {['Job name', 'Status', 'Priority', 'Attempts', 'Created', ''].map(h => (
                <th key={h} className="text-left px-4 py-2 text-xs font-mono text-zinc-500 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr
                key={job.id}
                onClick={() => setSelected(job)}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/40 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 font-mono text-zinc-200 text-xs">{job.jobName}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-mono px-2 py-0.5 rounded border ${STATUS_COLORS[job.status]}`}>
                    {job.status}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-zinc-400 text-xs">{job.priority}</td>
                <td className="px-4 py-3 font-mono text-zinc-400 text-xs">{job.attemptCount}/{job.maxAttempts}</td>
                <td className="px-4 py-3 font-mono text-zinc-500 text-xs">{fmt(job.createdAt)}</td>
                <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                  {job.status === 'DEAD' && (
                    <button
                      onClick={() => handleReplay(job.id)}
                      className="text-xs font-mono text-red-400 hover:text-red-300 border border-red-900/50 hover:border-red-700 px-2 py-1 rounded transition-colors"
                    >
                      replay
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <JobDetail
          job={selected}
          onClose={() => setSelected(null)}
          onReplay={(id) => { handleReplay(id); setSelected(null); }}
        />
      )}
    </div>
  );
}
