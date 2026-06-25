import type { Job, QueueStats, EnqueuePayload } from "../types/job.types";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:3000";

export const api = {
  async getStats(): Promise<QueueStats> {
    const res = await fetch(`${BASE}/queue/stats`);
    if (!res.ok) throw new Error("Failed to fetch stats");
    return res.json();
  },

  async getJobs(status?: string): Promise<Job[]> {
    const url = status ? `${BASE}/jobs?status=${status}` : `${BASE}/jobs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch jobs");
    return res.json();
  },

  async getJob(id: string): Promise<Job> {
    const res = await fetch(`${BASE}/jobs/${id}`);
    if (!res.ok) throw new Error("Job not found");
    return res.json();
  },

  async enqueue(
    data: EnqueuePayload,
  ): Promise<{ success: boolean; jobId: string; runAt: string }> {
    const res = await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to enqueue job");
    return json;
  },

  async replay(id: string): Promise<{ success: boolean; jobId: string }> {
    const res = await fetch(`${BASE}/jobs/${id}/replay`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to replay job");
    return json;
  },
};
