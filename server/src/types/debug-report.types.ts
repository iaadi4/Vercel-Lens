import { z } from "zod";

export const ErrorFileSchema = z.object({
  filePath: z.string(),
  lineNumber: z.number().optional(),
  snippet: z.string().optional(),
});

export const FilteredLogSchema = z.object({
  errorType: z.string(),
  errorMessage: z.string(),
  relevantFiles: z.array(ErrorFileSchema),
  rawErrorLines: z.array(z.string()),
  phase: z.enum(["install", "build", "runtime", "unknown"]),
});

export const DeploymentDebugSchema = z.object({
  deploymentId: z.string(),
  summary: z.string(),
  rootCause: z.string(),
  suggestedFix: z.string(),
  affectedFiles: z.array(ErrorFileSchema),
  confidence: z.enum(["high", "medium", "low"]),
  references: z.array(z.string()).optional(),
});

export type FilteredLog = z.infer<typeof FilteredLogSchema>;
export type DeploymentDebug = z.infer<typeof DeploymentDebugSchema>;