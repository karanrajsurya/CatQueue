import { Request, Response } from "express";
import { Prisma } from "../generated/prisma";
import prisma from "../lib/prisma";
import express from "express";

// all api endpoints
const app = express.Router();

app.get("/jobs", async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const jobs = await prisma.job.findMany({
      where: status ? { status: status as any } : {},
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    res.json(jobs);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/jobs", async (req: Request, res: Response) => {
  try {
    const reqData = req.body;
    if (!reqData.jobName || !reqData.payload) {
      res.status(400).json({ error: "jobName and payload are required" });
      return;
    }

    const job = await prisma.job.create({
      data: {
        jobName: reqData.jobName,
        payload: reqData.payload,
        priority: reqData.priority ?? 3,
        maxAttempts: reqData.maxAttempts ?? 6,
        runAt: reqData.runAt ? new Date(reqData.runAt) : new Date(),
        idempotencyKey: reqData.idempotencyKey ?? null,
      },
    });

    return res
      .status(201)
      .json({ success: true, jobId: job.id, runAt: job.runAt });
  } catch (error: any) {
    if (error.code === "P2002") {
      res
        .status(409)
        .json({ error: "Job with this idempotencyKey already exists" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/job/:id", async (req: Request, res: Response) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id as string },
    });
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  } catch {
    console.log(Error);
  }
});

app.get("/queue/stats", async (req: Request, res: Response) => {
  try {
    const [pending, processing, completed, dead] = await Promise.all([
      prisma.job.count({ where: { status: "PENDING" } }),
      prisma.job.count({ where: { status: "PROCESSING" } }),
      prisma.job.count({ where: { status: "COMPLETED" } }),
      prisma.job.count({ where: { status: "DEAD" } }),
    ]);
    res.json({ pending, processing, completed, dead });
  } catch {
    console.log(Error);
  }
});

app.post("/jobs/:id/replay", async (req: Request, res: Response) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id as string },
    });
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status !== "DEAD") {
      res.status(400).json({ error: "Only DEAD jobs can be replayed" });
      return;
    }
    const replayedJob = await prisma.job.update({
      where: { id: req.params.id as string },
      data: {
        status: "PENDING",
        attemptCount: 0,
        runAt: new Date(),
        lockedUntil: null,
        workerId: null,
        errorLog: Prisma.JsonNull,
      },
    });
    res.json({ success: true, jobId: replayedJob.id });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default app;
