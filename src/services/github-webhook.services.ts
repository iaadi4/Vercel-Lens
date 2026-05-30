import { Request, Response } from "express";
import Send from "../utils/response.utils";
import { payload } from "../types/webhook-payload.types";
import { logger } from "../utils/logger.utils";

const payloadReceived = (req: Request, res: Response) => {
    const payloadData = payload.parse(req.body);
    Send.success(res, {});

    if(payloadData.type == 'deployment.error') {
        const deployementId = payloadData.payload.deployment.id;
        const projectId = payloadData.payload.projectId;

        logger.info({ deployementId, projectId }, "Payload received!");

    } else {
        logger.info(`Ignored event type: ${payloadData.type}`)
    }
}

export default payloadReceived;