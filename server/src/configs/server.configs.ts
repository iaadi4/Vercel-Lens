import fs from "fs";
import path from "path";
import YAML from "yaml";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  server: z.object({
    port: z.number().default(3000),
    env: z.enum(["development", "production", "test"]).default("development"),
  }),
  metricsEnabled: z.boolean().default(true),
});

export type AppConfig = z.infer<typeof configSchema>;

const loadConfig = () => {
  try {
    const configPath = path.resolve(process.cwd(), "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = YAML.parse(configContent);
    return configSchema.parse(config);
  } catch (err) {
    console.error("Error loading config:", err);
    process.exit(1);
  }
};

export const serverConfig = loadConfig();
