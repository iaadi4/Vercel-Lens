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

type Chains = {
  filterChain: RunnableSequence;
  debugChain: RunnableSequence;
};

const filterPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a build log parser. Your only job is to extract error-related content from raw Vercel deployment logs.
Ignore all successful steps, progress bars, download lines, and unrelated output.
Return ONLY a raw JSON object — no markdown, no backticks, no explanation.

The JSON must match this exact shape:
{{
  "errorType": string,          
  "errorMessage": string,       
  "relevantFiles": [            
    {{
      "filePath": string,
      "lineNumber": number,     
      "snippet": string         
    }}
  ],
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
You will receive pre-filtered error data extracted from a failed deployment.
Diagnose the root cause precisely and provide a clear, actionable fix.
Return ONLY a raw JSON object — no markdown, no backticks, no explanation.

The JSON must match this exact shape:
{{
  "deploymentId": string,
  "summary": string,            
  "rootCause": string,          
  "suggestedFix": string,       
  "affectedFiles": [
    {{
      "filePath": string,
      "lineNumber": number,
      "snippet": string
    }}
  ],
  "confidence": "high" | "medium" | "low",
  "references": string[]        
}}`,
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
    process.env.GOOGLE_API_KEY = queueConfig.secrets.llmApiKey;
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

// Logs below this size go straight to the debug chain — no filter LLM needed.
const FILTER_THRESHOLD_LINES = queueConfig.summarize.filterThresholdLines;
const FILTER_THRESHOLD_CHARS = queueConfig.summarize.filterThresholdChars;

function needsFiltering(rawLogs: string): boolean {
  const lines = rawLogs.split("\n").length;
  return (
    lines > FILTER_THRESHOLD_LINES || rawLogs.length > FILTER_THRESHOLD_CHARS
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
      "Logs exceed threshold — running filter chain first",
    );
    const rawFiltered = await filterChain.invoke({ deploymentId, rawLogs });
    filtered = FilteredLogSchema.parse(rawFiltered);
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

  const rawDebug = await debugChain.invoke({
    deploymentId,
    phase: filtered.phase,
    errorType: filtered.errorType,
    errorMessage: filtered.errorMessage,
    relevantFiles: JSON.stringify(filtered.relevantFiles, null, 2),
    rawErrorLines: filtered.rawErrorLines.join("\n"),
  });

  return DeploymentDebugSchema.parse(rawDebug);
}
