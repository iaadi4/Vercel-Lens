import { z } from "zod";

export const FilePatchSchema = z.object({
  filePath: z.string(),
  type: z.enum(["edit", "create", "delete"]),
  find: z.string().optional(),
  replace: z.string().optional(),
});

export type FilePatch = z.infer<typeof FilePatchSchema>;

export const FilteredLogSchema = z.object({
  errorType: z.string(),
  errorMessage: z.string(),
  relevantFiles: z.array(
    z.object({
      filePath: z.string(),
      lineNumber: z.number().optional(),
      snippet: z.string().optional(),
    }),
  ),
  rawErrorLines: z.array(z.string()),
  phase: z.enum(["install", "build", "runtime", "unknown"]),
});

export type FilteredLog = z.infer<typeof FilteredLogSchema>;

export const DeploymentDebugSchema = z.object({
  deploymentId: z.string(),
  summary: z.string(),
  rootCause: z.string(),
  suggestedFix: z.union([z.string(), z.array(z.string())]),
  affectedFiles: z.array(
    z.object({
      filePath: z.string(),
      lineNumber: z.number().optional(),
      snippet: z.string().optional(),
    }),
  ),
  confidence: z.enum(["high", "medium", "low"]),
  references: z.array(z.string()).optional(),
  patches: z.array(FilePatchSchema).default([]),
});

export type DeploymentDebug = z.infer<typeof DeploymentDebugSchema>;
