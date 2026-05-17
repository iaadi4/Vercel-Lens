import fs from "fs";
import path from "path";
import YAML from "yaml";
import { z } from "zod";

const configSchema = z.object({
    server: z.object({
        port: z.number().default(3000),
        env: z.enum(['development', 'production', 'test']).default('development'),
    }),
    ai: z.object({
        model: z.string().default("gemini-2.5-pro"),
        temperature: z.number().default(0.7),
        maxRetries: z.number().default(3)
    }),
    secrets: z.object({
        geminiApiKey: z.string().default(process.env.GEMINI_API_KEY || "")
    }).refine((data) => data.geminiApiKey.length > 0, {
        message: "GEMINI_API_KEY must be set in environment variables",
        path: ["secrets", "geminiApiKey"]
    }),
    metricsEnabled: z.boolean().default(true)
})

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
}

export const config = loadConfig();