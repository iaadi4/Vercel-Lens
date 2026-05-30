import fs from "fs";
import path from "path";
import YAML from "yaml";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  redis: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().default(6379),
    password: z
      .string()
      .optional()
      .default(process.env.REDIS_PASSWORD || ""),
  }),
  queue: z.object({
    name: z.string().default("vercel-log-investigator"),
  }),
});

const loadConfig = () => {
  try {
    const configPath = path.resolve(process.cwd(), "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = YAML.parse(configContent);
    return configSchema.parse(config);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

export const queueConfig = loadConfig();
