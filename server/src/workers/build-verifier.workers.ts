import { Job, Worker, Queue } from "bullmq";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { queueConfig } from "../configs/queue.configs";
import { runLLMDebugger } from "../services/llm-debugger.services";
import { FilePatch } from "../types/debug-report.types";
import { logger } from "../utils/logger.utils";

const MAX_FIX_ATTEMPTS = 3;
const BUILD_TIMEOUT_SECONDS = 5 * 60;

interface BuildJobData {
  owner: string;
  repo: string;
  commitSha: string;
  rootDirectory: string | null;
  patches: FilePatch[];
  body: string;
  attempt: number;
}

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

const buildQueue = new Queue(queueConfig.queue2.name, {
  connection: redisConfig,
});
const prQueue = new Queue(queueConfig.queue3.name, { connection: redisConfig });

const daytona = new Daytona();

const WORKSPACE_DIR = "/home/daytona/project";

export async function prepareWorkspace(
  sandbox: Sandbox,
  repoUrl: string,
  commitSha: string,
): Promise<string> {
  await sandbox.git.clone(
    repoUrl,
    WORKSPACE_DIR,
    undefined,   // branch — not needed
    commitSha,   // checkout this specific commit
  );

  return WORKSPACE_DIR;
}

export async function resolveProjectRoot(
  sandbox: Sandbox,
  repoRoot: string,
  rootDirectory: string | null,
): Promise<string> {
  if (rootDirectory) {
    const fromVercel = `${repoRoot}/${rootDirectory}`;
    try {
      const info = await sandbox.fs.getFileDetails(fromVercel);
      if (info) {
        logger.info({ fromVercel }, "Using rootDirectory from Vercel API");
        return fromVercel;
      }
    } catch {
      logger.warn(
        { rootDirectory, fromVercel },
        "Vercel rootDirectory not found — falling back to scan",
      );
    }
  }

  // BFS scan for package.json with a `build` script.
  // Uses a shell find + node one-liner to keep it in one round-trip.
  const scanResult = await sandbox.process.executeCommand(
    `find "${repoRoot}" \\( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name .vercel \\) -prune -o -name package.json -print 2>/dev/null | head -50 | while IFS= read -r pkg; do
      dir=$(dirname "$pkg")
      if node -e "const p=JSON.parse(require('fs').readFileSync('$pkg','utf8')); process.exit(p.scripts && p.scripts.build ? 0 : 1)" 2>/dev/null; then
        echo "BUILD:$dir"
      else
        echo "PKG:$dir"
      fi
    done`,
  );

  const lines = scanResult.result.trim().split("\n").filter(Boolean);

  let firstPkgDir: string | null = null;
  let firstBuildPkgDir: string | null = null;

  for (const line of lines) {
    if (line.startsWith("BUILD:") && !firstBuildPkgDir) {
      firstBuildPkgDir = line.slice(6);
      break;
    }
    if (line.startsWith("PKG:") && !firstPkgDir) {
      firstPkgDir = line.slice(4);
    }
  }

  const resolved = firstBuildPkgDir ?? firstPkgDir ?? repoRoot;
  logger.info({ resolved }, "Resolved project root via BFS scan");
  return resolved;
}

export async function analyzeWorkspace(
  sandbox: Sandbox,
  projectRoot: string,
  repoRoot: string,
) {
  // Detect package manager from lockfiles
  const lockCheck = await sandbox.process.executeCommand(
    `for dir in "${projectRoot}" "${repoRoot}"; do
      [ -f "$dir/pnpm-lock.yaml" ] && echo "pnpm" && exit 0
      [ -f "$dir/yarn.lock" ]      && echo "yarn" && exit 0
      [ -f "$dir/bun.lockb" ]      && echo "bun"  && exit 0
    done
    echo "npm"`,
  );

  const detected = lockCheck.result.trim();
  let packageManager = "npm";
  let installCmd = "npm install";

  if (detected === "pnpm") {
    packageManager = "pnpm";
    installCmd = "pnpm install --no-frozen-lockfile";
  } else if (detected === "yarn") {
    packageManager = "yarn";
    installCmd = "yarn install";
  } else if (detected === "bun") {
    packageManager = "bun";
    installCmd = "bun install";
  }

  // Read package.json to determine build command
  let pkgContent: Buffer;
  try {
    pkgContent = await sandbox.fs.downloadFile(`${projectRoot}/package.json`);
  } catch {
    throw new Error(
      `No package.json found in resolved project root: ${projectRoot}`,
    );
  }

  const pkg = JSON.parse(pkgContent.toString("utf-8"));
  const buildCmd = pkg.scripts?.build ? `${packageManager} run build` : null;

  return { installCmd, buildCmd, packageManager };
}

async function applyPatches(
  sandbox: Sandbox,
  projectRoot: string,
  patches: FilePatch[],
): Promise<string[]> {
  const failed: string[] = [];

  for (const patch of patches) {
    const absPath = `${projectRoot}/${patch.filePath}`;
    try {
      if (patch.type === "delete") {
        await sandbox.fs.deleteFile(absPath);
        continue;
      }
      if (patch.type === "create") {
        // Ensure parent directory exists
        const parentDir = absPath.substring(0, absPath.lastIndexOf("/"));
        await sandbox.process.executeCommand(`mkdir -p "${parentDir}"`);
        await sandbox.fs.uploadFile(
          Buffer.from(patch.replace ?? "", "utf-8"),
          absPath,
        );
        continue;
      }

      // edit — find-and-replace
      if (!patch.find) {
        failed.push(patch.filePath);
        continue;
      }

      // Download the file, apply the patch locally, re-upload
      let original: string;
      try {
        const buf = await sandbox.fs.downloadFile(absPath);
        original = buf.toString("utf-8");
      } catch {
        failed.push(patch.filePath);
        continue;
      }

      if (!original.includes(patch.find)) {
        failed.push(patch.filePath);
        continue;
      }

      const newContent = original.replace(patch.find, patch.replace ?? "");
      await sandbox.fs.uploadFile(Buffer.from(newContent, "utf-8"), absPath);
    } catch (err: any) {
      logger.warn(
        { filePath: patch.filePath, err: err.message },
        "Patch failed — skipping",
      );
      failed.push(patch.filePath);
    }
  }

  return failed;
}

export interface RunResult {
  success: boolean;
  exitCode: number | null;
  logs: string;
  timedOut: boolean;
}

export async function runBuild(
  sandbox: Sandbox,
  projectRoot: string,
  repoRoot: string,
  installCmd: string,
  buildCmd: string | null,
): Promise<RunResult> {
  const logs: string[] = [];

  const buildEnv: Record<string, string> = {
    CI: "true",
    NODE_ENV: "production",
  };

  // --- install ---
  const installResult = await sandbox.process.executeCommand(
    `${installCmd} 2>&1`,
    repoRoot,
    buildEnv,
    BUILD_TIMEOUT_SECONDS,
  );
  if (installResult.result.trim()) logs.push(installResult.result.trim());

  if (installResult.exitCode !== 0) {
    return {
      success: false,
      exitCode: installResult.exitCode,
      logs: logs.join("\n"),
      timedOut: installResult.exitCode === 124,
    };
  }

  // --- build ---
  if (buildCmd) {
    const buildResult = await sandbox.process.executeCommand(
      `${buildCmd} 2>&1`,
      projectRoot,
      buildEnv,
      BUILD_TIMEOUT_SECONDS,
    );
    if (buildResult.result.trim()) logs.push(buildResult.result.trim());

    return {
      success: buildResult.exitCode === 0,
      exitCode: buildResult.exitCode,
      logs: logs.join("\n"),
      timedOut: buildResult.exitCode === 124,
    };
  }

  return { success: true, exitCode: 0, logs: logs.join("\n"), timedOut: false };
}

function appendRetrySection(
  body: string,
  attempt: number,
  patches: FilePatch[],
): string {
  const fileList = patches
    .map((p) => `- \`${p.filePath}\` (${p.type})`)
    .join("\n");
  return (
    body +
    `\n\n---\n\n### 🔄 Fix attempt ${attempt}\n\nApplied patches:\n\n${fileList}`
  );
}

const worker = new Worker(
  queueConfig.queue2.name,
  async (job: Job<BuildJobData>) => {
    const { owner, repo, commitSha, rootDirectory, patches, attempt } =
      job.data;
    let { body } = job.data;

    logger.info({ jobId: job.id, repo, attempt }, "Build verifier started");

    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    // Create an ephemeral Daytona sandbox for the build
    const sandbox = await daytona.create({
      language: "typescript",
      envVars: { CI: "true", NODE_ENV: "production" },
      autoStopInterval: 10,
      autoDeleteInterval: 0,
    });

    logger.info(
      { jobId: job.id, sandboxId: sandbox.id },
      "Daytona sandbox created",
    );

    try {
      const repoRoot = await prepareWorkspace(sandbox, repoUrl, commitSha);
      const projectRoot = resolveProjectRoot(sandbox, repoRoot, rootDirectory);
      const { installCmd, buildCmd } = await analyzeWorkspace(
        sandbox,
        await projectRoot,
        repoRoot,
      );

      const failedPatches = await applyPatches(sandbox, await projectRoot, patches);
      if (failedPatches.length)
        logger.warn({ failedPatches }, "Some patches could not be applied");

      logger.info(
        { jobId: job.id, attempt, installCmd, buildCmd },
        "Starting build",
      );
      const buildResult = await runBuild(
        sandbox,
        await projectRoot,
        repoRoot,
        installCmd,
        buildCmd,
      );
      logger.info(
        { jobId: job.id, attempt, success: buildResult.success },
        "Build finished",
      );

      if (buildResult.timedOut)
        logger.warn({ jobId: job.id }, "Build timed out");

      if (buildResult.success) {
        body = appendRetrySection(body, attempt, patches);
        await prQueue.add(
          "create-pr",
          { owner, repo, commitSha, rootDirectory, body },
          jobOptions,
        );
        logger.info({ jobId: job.id }, "Build passed — queued PR");
        return { success: true, attempt };
      }

      if (attempt >= MAX_FIX_ATTEMPTS) {
        logger.warn(
          { jobId: job.id },
          `Build failed after ${MAX_FIX_ATTEMPTS} attempts — giving up`,
        );
        return { success: false, attempt, exhausted: true };
      }

      logger.info(
        { jobId: job.id, attempt },
        "Build failed — re-running LLM with build errors",
      );

      const refined = await runLLMDebugger(
        `${commitSha}-retry-${attempt}`,
        `Attempt ${attempt} patches did not fix the build.\n\nPatches applied:\n${JSON.stringify(patches, null, 2)}\n\nBuild errors:\n${buildResult.logs}`,
      );

      if (!refined.patches.length) {
        logger.warn(
          { jobId: job.id },
          "LLM returned no patches on retry — giving up",
        );
        return { success: false, attempt, exhausted: true };
      }

      await buildQueue.add(
        "apply-patches",
        {
          owner,
          repo,
          commitSha,
          rootDirectory,
          patches: refined.patches,
          body,
          attempt: attempt + 1,
        } satisfies BuildJobData,
        jobOptions,
      );

      return { success: false, attempt, retrying: true };
    } finally {
      try {
        await sandbox.delete();
        logger.info(
          { jobId: job.id, sandboxId: sandbox.id },
          "Daytona sandbox deleted",
        );
      } catch (cleanupErr: any) {
        logger.warn(
          { jobId: job.id, sandboxId: sandbox.id, err: cleanupErr.message },
          "Failed to delete Daytona sandbox",
        );
      }
    }
  },
  { connection: redisConfig, lockDuration: 10 * 60 * 1000 },
);

worker.on("failed", (job, err) =>
  logger.error(
    {
      jobId: job?.id,
      repo: job?.data?.repo,
      attempt: job?.data?.attempt,
      err: err.message,
    },
    "Job failed",
  ),
);
worker.on("completed", (job, result) =>
  logger.info({ jobId: job.id, result }, "Job completed"),
);
