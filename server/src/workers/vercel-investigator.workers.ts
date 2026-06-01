import { Job, Worker, UnrecoverableError } from "bullmq";
import { queueConfig } from "../configs/queue.configs";
import { runLLMDebugger } from "../services/llm-debugger.services";
import { logger } from "../utils/logger.utils";

interface DeploymentJobData {
  deploymentId: string;
  vercelPAT: string;
  projectId: string;
}

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

async function fetchDeploymentLogs(
  deploymentId: string,
  vercelPAT: string,
): Promise<string> {
  const res = await fetch(
    `https://api.vercel.com/v3/deployments/${deploymentId}/events`,
    {
      headers: { Authorization: `Bearer ${vercelPAT}` },
    },
  );

  if (res.status === 401 || res.status === 403) {
    throw new UnrecoverableError(
      `Vercel auth failed (${res.status}) — check your PAT`,
    );
  }
  if (!res.ok) {
    throw new Error(`Vercel API error: ${res.status}`);
  }

  const data = await res.json();
  return data
    .map((event: any) => event.text)
    .filter((text: any) => typeof text === "string" && text.trim() !== "")
    .join("\n");
}

const worker = new Worker(
  queueConfig.queue.name,
  async (job: Job<DeploymentJobData>) => {
    const { deploymentId, vercelPAT, projectId } = job.data;

    logger.info(
      { jobId: job.id, deploymentId, attempt: job.attemptsMade + 1 },
      "Job started",
    );

    const logs = await fetchDeploymentLogs(deploymentId, vercelPAT);
    if (!logs.trim()) {
      logger.warn({ jobId: job.id }, "No logs returned — skipping LLM");
      return;
    }

    const result = await runLLMDebugger(deploymentId, logs);
    logger.info({ jobId: job.id, result }, "Debug result ready");
  },
  {
    connection: redisConfig,
    lockDuration: 5 * 60 * 1000,
  },
);

worker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, deploymentId: job?.data?.deploymentId, err: err.message },
    "Job failed",
  );
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Job completed");
});
