import { Router } from "express";
import payloadReceived from "../../services/github-webhook.services";

const router = Router();

router.post("/github-webhook", payloadReceived);

export default router;
