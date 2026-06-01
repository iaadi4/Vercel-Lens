import { Router } from "express";
import webhookRouter from "./v1/webhook.routes";

const router = Router();

router.use('/v1', webhookRouter);

export default router;