import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { QueueStats } from '../types/job.types';

const cards = [
  { key: 'pending',    label: 'Pending',    color: 'border-yellow-500/40 text-yellow-400', dot: 'bg-yellow-400' },
  { key: 'processing', label: 'Processing', color: 'border-blue-500/40 text-blue-400',   dot: 'bg-blue-400'   },
  { key: 'completed',  label: 'Completed',  color: 'border-green-500/40 text-green-400', dot: 'bg-green-400'  },
  { key: 'dead',       label: 'Dead',       color: 'border-red-500/40 text-red-400',     dot: 'bg-red-400'    },
] as const;

export default function StatsBar() {
  const [stats, setStats] = useState<QueueStats | null>(null);

  const fetchStats = () => {
    api.getStats().then(setStats).catch(() => {});
  };

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="grid grid-cols-4 gap-3 mb-6">
      {cards.map(({ key, label, color, dot }) => (
        <div key={key} className={`bg-zinc-900 border rounded-lg px-4 py-4 ${color}`}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            <span className="text-xs font-mono uppercase tracking-widest text-zinc-400">{label}</span>
          </div>
          <div className="text-3xl font-mono font-bold">
            {stats ? stats[key] : <span className="text-zinc-600 text-xl">—</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
