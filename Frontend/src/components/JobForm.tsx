import { useState } from 'react';
import { api } from '../api/client';

interface Props { onEnqueued: () => void; }

export default function JobForm({ onEnqueued }: Props) {
  const [jobName, setJobName]       = useState('');
  const [payload, setPayload]       = useState('{\n  \n}');
  const [priority, setPriority]     = useState(3);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [status, setStatus]         = useState<{ ok: boolean; msg: string } | null>(null);
  const [loading, setLoading]       = useState(false);

  const submit = async () => {
    setStatus(null);
    if (!jobName.trim()) { setStatus({ ok: false, msg: 'jobName is required' }); return; }
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(payload); }
    catch { setStatus({ ok: false, msg: 'Payload must be valid JSON' }); return; }

    setLoading(true);
    try {
      const res = await api.enqueue({
        jobName: jobName.trim(),
        payload: parsed,
        priority,
        maxAttempts,
        ...(idempotencyKey.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
      });
      setStatus({ ok: true, msg: `Enqueued — job ID: ${res.jobId}` });
      setJobName(''); setPayload('{\n  \n}'); setIdempotencyKey('');
      onEnqueued();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 mb-6">
      <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-4">Enqueue job</h2>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1 font-mono">jobName</label>
          <input
            value={jobName} onChange={e => setJobName(e.target.value)}
            placeholder="send-email"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1 font-mono">idempotencyKey <span className="text-zinc-600">(optional)</span></label>
          <input
            value={idempotencyKey} onChange={e => setIdempotencyKey(e.target.value)}
            placeholder="unique-key-001"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1 font-mono">payload <span className="text-zinc-600">(JSON)</span></label>
        <textarea
          value={payload} onChange={e => setPayload(e.target.value)} rows={4}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500 resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1 font-mono">priority <span className="text-zinc-600">(1=urgent, 5=low)</span></label>
          <input
            type="number" min={1} max={5} value={priority} onChange={e => setPriority(Number(e.target.value))}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1 font-mono">maxAttempts</label>
          <input
            type="number" min={1} max={20} value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
      </div>

      {status && (
        <div className={`text-xs font-mono px-3 py-2 rounded mb-3 ${status.ok ? 'bg-green-950 text-green-400 border border-green-800' : 'bg-red-950 text-red-400 border border-red-800'}`}>
          {status.msg}
        </div>
      )}

      <button
        onClick={submit} disabled={loading}
        className="w-full bg-zinc-100 text-zinc-900 font-mono text-sm font-medium py-2 rounded hover:bg-white transition-colors disabled:opacity-40"
      >
        {loading ? 'Enqueueing...' : 'Enqueue job →'}
      </button>
    </div>
  );
}
