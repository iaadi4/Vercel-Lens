import { Job, Worker } from "bullmq";
import { queueConfig } from "../configs/queue.configs";
import { logger } from "../utils/logger.utils";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";

interface BuildJobData {
  owner: string;
  repo: string;
  commit_sha: string;
  rootDirectory: string | null;
  body: string;
}

const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

export function prepareWorkspace(
  repoUrl: string,
  commitSha: string,
  jobId: string,
): string {
  const workspacePath = path.join(os.tmpdir(), `vercellens-${jobId}`);

  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }

  execSync(`git clone --filter=blob:none ${repoUrl} ${workspacePath}`, {
    stdio: "ignore",
  });
  execSync(`git -C ${workspacePath} checkout ${commitSha}`, {
    stdio: "ignore",
  });

  return workspacePath;
}

function resolveProjectRoot(
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
      "Vercel rootDirectory not found on disk — falling back to scan",
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
        if (entry.isDirectory() && !IGNORE_DIRS.has(entry.name)) {
          queue.push(path.join(dir, entry.name));
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  const resolved = firstBuildPkgDir ?? firstPkgDir ?? repoRoot;
  logger.info({ resolved }, "Resolved project root via BFS scan");
  return resolved;
}

function analyzeWorkspace(projectRoot: string, repoRoot: string) {
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
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `No package.json found in resolved project root: ${projectRoot}`,
    );
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const buildCmd = pkg.scripts?.build ? `${packageManager} run build` : null;

  return { installCmd, buildCmd, packageManager };
}

interface RunResult {
  success: boolean;
  exitCode: number | null;
  logs: string;
  timedOut: boolean;
}

function runBuild(
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

    const timedOut = result.signal === "SIGTERM" && result.status === null;
    return { exitCode: result.status, timedOut };
  }

  const install = run(installCmd, repoRoot);
  if (install.timedOut) {
    return {
      success: false,
      exitCode: null,
      logs: logs.join("\n"),
      timedOut: true,
    };
  }
  if (install.exitCode !== 0) {
    return {
      success: false,
      exitCode: install.exitCode,
      logs: logs.join("\n"),
      timedOut: false,
    };
  }

  if (buildCmd) {
    const build = run(buildCmd, projectRoot);
    if (build.timedOut) {
      return {
        success: false,
        exitCode: null,
        logs: logs.join("\n"),
        timedOut: true,
      };
    }
    return {
      success: build.exitCode === 0,
      exitCode: build.exitCode,
      logs: logs.join("\n"),
      timedOut: false,
    };
  }

  return { success: true, exitCode: 0, logs: logs.join("\n"), timedOut: false };
}

const worker = new Worker(
  queueConfig.queue3.name,
  async (job: Job<BuildJobData>) => {
    const { owner, repo, commit_sha, rootDirectory } = job.data;

    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const repoRoot = prepareWorkspace(repoUrl, commit_sha, job.id!);

    try {
      const projectRoot = resolveProjectRoot(repoRoot, rootDirectory);
      const { installCmd, buildCmd } = analyzeWorkspace(projectRoot, repoRoot);

      logger.info(
        { jobId: job.id, projectRoot, installCmd, buildCmd },
        "Starting build",
      );

      const result = runBuild(projectRoot, repoRoot, installCmd, buildCmd);

      if (result.timedOut) {
        logger.warn({ jobId: job.id }, "Build timed out");
      }

      logger.info(
        { jobId: job.id, success: result.success, exitCode: result.exitCode },
        "Build finished",
      );

      return result;
    } finally {
      if (fs.existsSync(repoRoot)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  },
  { connection: redisConfig },
);

worker.on("failed", (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      repo: job?.data?.repo,
      err: err.message,
    },
    "Job failed",
  );
});

worker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, result }, "Job completed");
});
