import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { config } from "./configs/index";
import rateLimit from "express-rate-limit";
import { logger } from "./utils/logger.util";
import {
  prometheusMiddleware,
  prometheusRegister
} from "./middlewares/prometheus.middleware";
import { errorMiddleware } from "./middlewares/error.middleware";

const app = express();

app.use(helmet());
app.disable("x-powered-by");
app.use(express.json());

app.use(
  pinoHttp({
    logger,
    genReqId: () => crypto.randomUUID()
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(prometheusMiddleware);

if (config.metricsEnabled) {
  app.get("/metrics", async (_, res) => {
    res.set("Content-Type", prometheusRegister.contentType);
    res.end(await prometheusRegister.metrics());
  });
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.use(errorMiddleware);

app.listen(config.server.port, () => {
  console.log(`Server is running on port ${config.server.port}`);
});