import { Job, Worker, Queue } from "bullmq";
import { queueConfig } from "../configs/queue.configs";
import { runLLMDebugger } from "../services/llm-debugger.services";
import { FilePatch } from "../types/debug-report.types";
import { logger } from "../utils/logger.utils";
import { spawnSync, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const MAX_FIX_ATTEMPTS = 3;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

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
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

const buildQueue = new Queue(queueConfig.queue2.name, {
  connection: redisConfig,
});
const prQueue = new Queue(queueConfig.queue3.name, { connection: redisConfig });

export function prepareWorkspace(
  repoUrl: string,
  commitSha: string,
  jobId: string,
): string {
  const workspacePath = path.join(os.tmpdir(), `vercellens-${jobId}`);
  if (fs.existsSync(workspacePath))
    fs.rmSync(workspacePath, { recursive: true, force: true });
  execSync(`git clone --filter=blob:none ${repoUrl} ${workspacePath}`, {
    stdio: "ignore",
  });
  execSync(`git -C ${workspacePath} checkout ${commitSha}`, {
    stdio: "ignore",
  });
  return workspacePath;
}

export function resolveProjectRoot(
  repoRoot: string,
  rootDirectory: string | null,
): string {
  if (rootDirectory) {
    const fromVercel = path.join(repoRoot, rootDirectory);
    if (fs.existsSync(fromVercel)) {
      logger.info({ fromVercel }, "Using rootDirectory from Vercel API");
      return fromVercel;
    }
    logger.warn(
      { rootDirectory, fromVercel },
      "Vercel rootDirectory not found — falling back to scan",
    );
  }

  const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".vercel",
  ]);
  let firstPkgDir: string | null = null;
  let firstBuildPkgDir: string | null = null;
  const queue: string[] = [repoRoot];

  while (queue.length > 0 && firstBuildPkgDir === null) {
    const dir = queue.shift()!;
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (firstPkgDir === null) firstPkgDir = dir;
        if (pkg.scripts?.build) {
          firstBuildPkgDir = dir;
          break;
        }
      } catch {
        /* skip malformed */
      }
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !IGNORE_DIRS.has(entry.name))
          queue.push(path.join(dir, entry.name));
      }
    } catch {
      /* skip unreadable */
    }
  }

  const resolved = firstBuildPkgDir ?? firstPkgDir ?? repoRoot;
  logger.info({ resolved }, "Resolved project root via BFS scan");
  return resolved;
}

export function analyzeWorkspace(projectRoot: string, repoRoot: string) {
  const searchDirs = [...new Set([projectRoot, repoRoot])];
  let packageManager = "npm";
  let installCmd = "npm install";

  for (const dir of searchDirs) {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
      installCmd = "pnpm install --no-frozen-lockfile";
      break;
    } else if (fs.existsSync(path.join(dir, "yarn.lock"))) {
      packageManager = "yarn";
      installCmd = "yarn install";
      break;
    } else if (fs.existsSync(path.join(dir, "bun.lockb"))) {
      packageManager = "bun";
      installCmd = "bun install";
      break;
    }
  }

  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath))
    throw new Error(
      `No package.json found in resolved project root: ${projectRoot}`,
    );

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const buildCmd = pkg.scripts?.build ? `${packageManager} run build` : null;
  return { installCmd, buildCmd, packageManager };
}

function applyPatches(projectRoot: string, patches: FilePatch[]): string[] {
  const failed: string[] = [];

  for (const patch of patches) {
    const absPath = path.join(projectRoot, patch.filePath);
    try {
      if (patch.type === "delete") {
        fs.rmSync(absPath, { force: true });
        continue;
      }
      if (patch.type === "create") {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, patch.replace ?? "", "utf-8");
        continue;
      }
      // edit
      if (!patch.find) {
        failed.push(patch.filePath);
        continue;
      }
      const original = fs.readFileSync(absPath, "utf-8");
      if (!original.includes(patch.find)) {
        failed.push(patch.filePath);
        continue;
      }
      fs.writeFileSync(
        absPath,
        original.replace(patch.find, patch.replace ?? ""),
        "utf-8",
      );
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

export function runBuild(
  projectRoot: string,
  repoRoot: string,
  installCmd: string,
  buildCmd: string | null,
): RunResult {
  const logs: string[] = [];

  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: repoRoot,
    npm_config_cache: path.join(repoRoot, ".npm-cache"),
    npm_config_prefix: path.join(repoRoot, ".npm-prefix"),
    CI: "true",
    NODE_ENV: "production",
  };

  function run(
    cmd: string,
    cwd: string,
  ): { exitCode: number | null; timedOut: boolean } {
    const [bin, ...args] = cmd.split(" ");
    const result = spawnSync(bin, args, {
      cwd,
      env: safeEnv,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    const combined = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (combined) logs.push(combined);
    return {
      exitCode: result.status,
      timedOut: result.signal === "SIGTERM" && result.status === null,
    };
  }

  const install = run(installCmd, repoRoot);
  if (install.timedOut || install.exitCode !== 0)
    return {
      success: false,
      exitCode: install.exitCode,
      logs: logs.join("\n"),
      timedOut: install.timedOut,
    };

  if (buildCmd) {
    const build = run(buildCmd, projectRoot);
    return {
      success: build.exitCode === 0,
      exitCode: build.exitCode,
      logs: logs.join("\n"),
      timedOut: build.timedOut,
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
    const repoRoot = prepareWorkspace(repoUrl, commitSha, job.id!);

    try {
      const projectRoot = resolveProjectRoot(repoRoot, rootDirectory);
      const { installCmd, buildCmd } = analyzeWorkspace(projectRoot, repoRoot);

      const failedPatches = applyPatches(projectRoot, patches);
      if (failedPatches.length)
        logger.warn({ failedPatches }, "Some patches could not be applied");

      logger.info(
        { jobId: job.id, attempt, installCmd, buildCmd },
        "Starting build",
      );
      const buildResult = runBuild(projectRoot, repoRoot, installCmd, buildCmd);
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
      if (fs.existsSync(repoRoot))
        fs.rmSync(repoRoot, { recursive: true, force: true });
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
