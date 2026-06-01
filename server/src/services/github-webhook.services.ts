import { Request, Response } from "express";
import { Queue } from "bullmq";
import { payload } from "../types/webhook-payload.types";
import { queueConfig } from "../configs/queue.configs";
import { logger } from "../utils/logger.utils";
import Send from "../utils/response.utils";

const queue = new Queue(queueConfig.queue.name, {
  connection: {
    host: queueConfig.redis.host,
    port: queueConfig.redis.port,
  },
});

const jobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 }, // 5s 10s 20s 40s 80s
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

const payloadReceived = async (req: Request, res: Response) => {
  const payloadData = payload.parse(req.body);
  Send.success(res, {});

  if (payloadData.type !== "deployment.error") {
    logger.info(`Ignored event type: ${payloadData.type}`);
    return;
  }

  const vercelPAT = process.env.VERCEL_PAT;
  if (!vercelPAT) {
    logger.error("VERCEL_PAT is not set — cannot queue job");
    return;
  }

  const { id: deploymentId } = payloadData.payload.deployment;
  const { projectId } = payloadData.payload;

  queue.add("analyze-failure", { deploymentId, projectId, vercelPAT }, jobOptions);
  logger.info({ deploymentId, projectId }, "Queued deployment analysis");
};

export default payloadReceived;