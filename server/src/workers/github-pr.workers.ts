import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { Job, Worker } from "bullmq";
import { queueConfig } from "../configs/queue.configs";
import { logger } from "../utils/logger.utils";

interface GithubCommitCommentData {
  installationId: number;
  owner: string;
  repo: string;
  commitSha: string;
  body: string;
}

const redisConfig = { host: queueConfig.redis.host, port: queueConfig.redis.port };

const privateKey = queueConfig.githubApp.privateKey
  ? Buffer.from(queueConfig.githubApp.privateKey, "base64").toString("utf-8")
  : undefined;

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: { appId: queueConfig.githubApp.appId, privateKey },
});

const worker = new Worker(
  queueConfig.queue3.name,
  async (job: Job<GithubCommitCommentData>) => {
    const { owner, repo, commitSha, body, installationId } = job.data;

    const auth = (await octokit.auth({
      type: "installation",
      installationId,
    })) as { token: string };

    const installationOctokit = new Octokit({ auth: auth.token });

    await installationOctokit.rest.repos.createCommitComment({
      owner,
      repo,
      commit_sha: commitSha,
      body,
    });
  },
  {
    connection: redisConfig,
    limiter: { max: 10, duration: 1000 },
  },
);

worker.on("completed", (job) =>
  logger.info({ jobId: job.id, owner: job.data.owner, repo: job.data.repo }, "Commit comment posted"),
);
worker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, owner: job?.data?.owner, repo: job?.data?.repo, err: err.message }, "Job failed"),
);