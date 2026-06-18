import { initChatModel } from "langchain";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import {
  DeploymentDebug,
  DeploymentDebugSchema,
  FilteredLog,
  FilteredLogSchema,
} from "../types/debug-report.types";
import { queueConfig } from "../configs/queue.configs";
import { logger } from "../utils/logger.utils";

type Chains = { filterChain: RunnableSequence; debugChain: RunnableSequence };

const filterPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a build log parser. Extract only error-related content from raw Vercel deployment logs.
Ignore successful steps, progress bars, download lines, and unrelated output.
Return ONLY a raw JSON object — no markdown, no backticks, no explanation.

{{
  "errorType": string,
  "errorMessage": string,
  "relevantFiles": [{{ "filePath": string, "lineNumber": number, "snippet": string }}],
  "rawErrorLines": string[],
  "phase": "install" | "build" | "runtime" | "unknown"
}}`,
  ],
  ["human", "Deployment ID: {deploymentId}\n\nRaw logs:\n{rawLogs}"],
]);

const debugPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an expert Vercel and Next.js deployment debugger.
Diagnose the root cause and provide precise, machine-applicable file patches.
Return ONLY a raw JSON object — no markdown, no backticks, no explanation.

{{
  "deploymentId": string,
  "summary": string,
  "rootCause": string,
  "suggestedFix": string,
  "affectedFiles": [{{ "filePath": string, "lineNumber": number, "snippet": string }}],
  "confidence": "high" | "medium" | "low",
  "references": string[],
  "patches": [
    {{
      "filePath": string,
      "type": "edit" | "create" | "delete",
      "find": string,    
      "replace": string  
    }}
  ]
}}

Rules for patches:
- "edit": "find" must be an exact verbatim substring from the file (copy it precisely, preserve whitespace and quotes). "replace" is what it becomes.
- "create": omit "find", set "replace" to the full file content.
- "delete": omit both "find" and "replace".
- filePath is always relative to the project root (e.g. "package.json", "src/vite.config.ts").
- For package.json dependency additions, find the opening of the relevant dependencies block and replace it with the new entry inserted.
- Prefer minimal targeted edits over rewriting entire files.
- If you cannot produce a confident patch, return an empty patches array rather than guessing.`,
  ],
  [
    "human",
    `Deployment ID: {deploymentId}
Build phase: {phase}
Error type: {errorType}
Error message: {errorMessage}

Relevant files:
{relevantFiles}

Raw error lines:
{rawErrorLines}`,
  ],
]);

let chains: Chains | null = null;

async function getChains(): Promise<Chains> {
  if (chains) return chains;

  if (queueConfig.secrets.llmApiKey) {
    process.env.GROQ_API_KEY = queueConfig.secrets.llmApiKey;
  }

  const filterModel = await initChatModel(queueConfig.ai.filterLLMModel, {
    modelProvider: queueConfig.ai.filterLLMProvider,
    temperature: 0,
  });

  const debugModel = await initChatModel(queueConfig.ai.debugLLMModel, {
    modelProvider: queueConfig.ai.debugLLMProvider,
    temperature: 0.2,
  });

  chains = {
    filterChain: RunnableSequence.from([
      filterPrompt,
      filterModel,
      new JsonOutputParser<FilteredLog>(),
    ]),
    debugChain: RunnableSequence.from([
      debugPrompt,
      debugModel,
      new JsonOutputParser<DeploymentDebug>(),
    ]),
  };

  return chains;
}

const FILTER_THRESHOLD_LINES = queueConfig.summarize.filterThresholdLines;
const FILTER_THRESHOLD_CHARS = queueConfig.summarize.filterThresholdChars;

function needsFiltering(rawLogs: string): boolean {
  return (
    rawLogs.split("\n").length > FILTER_THRESHOLD_LINES ||
    rawLogs.length > FILTER_THRESHOLD_CHARS
  );
}

export async function runLLMDebugger(
  deploymentId: string,
  rawLogs: string,
): Promise<DeploymentDebug> {
  const { filterChain, debugChain } = await getChains();

  let filtered: FilteredLog;

  if (needsFiltering(rawLogs)) {
    logger.info(
      {
        deploymentId,
        lines: rawLogs.split("\n").length,
        chars: rawLogs.length,
      },
      "Logs exceed threshold — running filter chain",
    );
    filtered = FilteredLogSchema.parse(
      await filterChain.invoke({ deploymentId, rawLogs }),
    );
  } else {
    logger.info(
      {
        deploymentId,
        lines: rawLogs.split("\n").length,
        chars: rawLogs.length,
      },
      "Logs within threshold — skipping filter chain",
    );
    filtered = {
      errorType: "unknown",
      errorMessage: rawLogs,
      relevantFiles: [],
      rawErrorLines: rawLogs.split("\n").filter((l) => l.trim()),
      phase: "unknown",
    };
  }

  return DeploymentDebugSchema.parse(
    await debugChain.invoke({
      deploymentId,
      phase: filtered.phase,
      errorType: filtered.errorType,
      errorMessage: filtered.errorMessage,
      relevantFiles: JSON.stringify(filtered.relevantFiles, null, 2),
      rawErrorLines: filtered.rawErrorLines.join("\n"),
    }),
  );
}
