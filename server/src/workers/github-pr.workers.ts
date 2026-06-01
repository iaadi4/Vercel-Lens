import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { Job, Worker } from "bullmq";
import { queueConfig } from "../configs/queue.configs";
import { logger } from "../utils/logger.utils";

interface GithubCommitCommentData {
  installationId: number;
  owner: string;
  repo: string;
  commit_sha: string;
  body: string;
  deploymentId: string;
}

const redisConfig = {
  host: queueConfig.redis.host,
  port: queueConfig.redis.port,
};

const privateKeyBase64 = queueConfig.githubApp.privateKey;
const privateKey = privateKeyBase64
  ? Buffer.from(privateKeyBase64, "base64").toString("utf8")
  : undefined;

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: queueConfig.githubApp.appId,
    privateKey,
  },
});

const worker = new Worker(
  queueConfig.queue2.name,
  async (job: Job<GithubCommitCommentData>) => {
    const { owner, repo, commit_sha, body } = job.data;

    const installationId = process.env.INSTALLATION_ID;

    const auth = (await octokit.auth({
      type: "installation",
      installationId,
    })) as { token: string };

    const installationOctokit = new Octokit({
      auth: auth.token,
    });

    await installationOctokit.rest.repos.createCommitComment({
      owner,
      repo,
      commit_sha,
      body,
    });
  },
  { connection: redisConfig },
);

worker.on("completed", (job, err) => {
  logger.info({ jobId: job.id }, "Job completed");
});

worker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, deploymentId: job?.data?.deploymentId, err: err.message },
    "Job failed",
  );
});
