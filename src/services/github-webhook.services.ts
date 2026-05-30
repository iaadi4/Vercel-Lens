import { Request, Response } from "express";
import Send from "../utils/response.utils";
import { payload } from "../types/webhook-payload.types";
import { logger } from "../utils/logger.utils";
import { Queue } from "bullmq";
import { queueConfig } from "../configs/queue.configs";

const queue = new Queue(queueConfig.queue.name, {
  connection: {
    host: queueConfig.redis.host,
    port: queueConfig.redis.port,
  },
});

const payloadReceived = (req: Request, res: Response) => {
  const payloadData = payload.parse(req.body);
  Send.success(res, {});

  if (payloadData.type == "deployment.error") {
    const deploymentId = payloadData.payload.deployment.id;
    const projectId = payloadData.payload.projectId;

    logger.info({ deploymentId, projectId }, "Payload received!");

    queue.add("analyze-failure", {
      deploymentId,
      vercelPAT: "", // todo: fetch from db
    });
  } else {
    logger.info(`Ignored event type: ${payloadData.type}`);
  }
};

export default payloadReceived;
