import { Job, Worker } from "bullmq";
import { queueConfig } from "../configs/queue.configs";

interface DeploymentJobData {
  deploymentId: string;
  vercelPAT: string;
}

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

const worker = new Worker(
  queueConfig.queue.name,
  async (job: Job<DeploymentJobData>) => {
    const { deploymentId, vercelPAT } = job.data;

    console.log(job.data);

    const response = await fetch(
      `https://api.vercel.com/v13/deployments/${deploymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${vercelPAT}`,
          "Content-Type": "application/json",
        },
      },
    );

    const data = await response.json();
    console.log(data);
  },
  { connection: redisConfig },
);
