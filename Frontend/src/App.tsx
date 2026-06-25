import { useState } from 'react';
import StatsBar from './components/StatsBar';
import JobForm from './components/JobForm';
import JobsTable from './components/JobsTable';

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex items-baseline gap-3 mb-1">
            <h1 className="text-xl font-mono font-medium text-zinc-100">catQueue</h1>
            <span className="text-xs font-mono text-zinc-600">postgres-native job queue</span>
          </div>
          <div className="h-px bg-zinc-800 mt-3" />
        </div>

        <StatsBar />
        <JobForm onEnqueued={refresh} />
        <JobsTable refreshKey={refreshKey} />
      </div>
    </div>
  );
}
