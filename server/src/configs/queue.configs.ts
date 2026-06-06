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
  queue1: z.object({
    name: z.string().default("vercel-log-investigator"),
  }),
  queue2: z.object({
    name: z.string().default("github-pr-bot"),
  }),
  queue3: z.object({
    name: z.string().default("docker-verifier"),
  }),
  ai: z.object({
    debugLLMModel: z.string().default("gemini-2.5-pro"),
    filterLLMModel: z.string().default("gemini-1.5-flash"),
    debugLLMProvider: z.string().default("google"),
    filterLLMProvider: z.string().default("google"),
  }),
  summarize: z.object({
    filterThresholdLines: z.number().default(150),
    filterThresholdChars: z.number().default(6000),
  }),
  secrets: z
    .object({
      llmApiKey: z
        .string()
        .optional()
        .transform(
          (val) =>
            val || process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "",
        ),
    })
    .refine((data) => data.llmApiKey.length > 0, {
      message: "LLM_API_KEY must be set in environment variables",
      path: ["llmApiKey"],
    }),
  githubApp: z.object({
    appId: z
      .string()
      .optional()
      .transform((val) => val || process.env.GITHUB_APP_ID || ""),
    privateKey: z
      .string()
      .optional()
      .transform((val) => val || process.env.GITHUB_APP_PRIVATE_KEY || ""),
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
