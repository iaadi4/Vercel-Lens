import { Job, Worker } from "bullmq";
import { queueConfig } from "../configs/queue.configs";

interface DeploymentJobData {
  deploymentId: string;
  vercelPAT: string;
  projectId: string;
}

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

new Worker(
  queueConfig.queue.name,
  async (job: Job<DeploymentJobData>) => {
    const { deploymentId, vercelPAT } = job.data;

    console.log(job.data);

    const response = await fetch(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${vercelPAT}`,
          "Content-Type": "application/json",
        },
      },
    );

    const data = await response.json();
    const readableLogs = data
      .map((event: any) => event.text)
      .filter((text: any) => text !== undefined && text.trim() !== "")
      .join("\n");

    console.log(readableLogs);
  },
  { connection: redisConfig },
);
