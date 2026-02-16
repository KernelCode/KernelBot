import { EventEmitter } from 'events';
import { Job } from './job.js';
import { getLogger } from '../utils/logger.js';

/**
 * Manages all jobs across all chats. Emits lifecycle events
 * so the orchestrator can react when workers finish.
 *
 * Events:
 *   job:completed  (job)
 *   job:failed     (job)
 *   job:cancelled  (job)
 */
export class JobManager extends EventEmitter {
  constructor({ jobTimeoutSeconds = 300, cleanupIntervalMinutes = 30 } = {}) {
    super();
    this.jobs = new Map();            // id -> Job
    this.jobTimeoutMs = jobTimeoutSeconds * 1000;
    this.cleanupMaxAge = cleanupIntervalMinutes * 60 * 1000;
  }

  /** Create a new job (status: queued). */
  createJob(chatId, workerType, task) {
    const job = new Job({ chatId, workerType, task });
    this.jobs.set(job.id, job);
    const logger = getLogger();
    logger.info(`[JobManager] Job created: ${job.id} [${workerType}] for chat ${chatId} — "${task.slice(0, 100)}"`);
    logger.debug(`[JobManager] Total jobs tracked: ${this.jobs.size}`);
    return job;
  }

  /** Move a job to running. */
  startJob(jobId) {
    const job = this._get(jobId);
    job.transition('running');
    getLogger().info(`[JobManager] Job ${job.id} [${job.workerType}] → running`);
  }

  /** Move a job to completed with a result. */
  completeJob(jobId, result) {
    const job = this._get(jobId);
    job.transition('completed');
    job.result = result;
    getLogger().info(`[JobManager] Job ${job.id} [${job.workerType}] → completed (${job.duration}s) — result: ${(result || '').length} chars`);
    this.emit('job:completed', job);
  }

  /** Move a job to failed with an error message. */
  failJob(jobId, error) {
    const job = this._get(jobId);
    job.transition('failed');
    job.error = typeof error === 'string' ? error : error?.message || String(error);
    getLogger().error(`[JobManager] Job ${job.id} [${job.workerType}] → failed (${job.duration}s) — ${job.error}`);
    this.emit('job:failed', job);
  }

  /** Cancel a specific job. Returns the job or null if not found / already terminal. */
  cancelJob(jobId) {
    const logger = getLogger();
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn(`[JobManager] Cancel: job ${jobId} not found`);
      return null;
    }
    if (job.isTerminal) {
      logger.warn(`[JobManager] Cancel: job ${jobId} already in terminal state (${job.status})`);
      return null;
    }

    const prevStatus = job.status;
    job.transition('cancelled');
    // Abort the worker if it's running
    if (job.worker && typeof job.worker.cancel === 'function') {
      logger.info(`[JobManager] Job ${job.id} [${job.workerType}] → cancelled (was: ${prevStatus}) — sending cancel to worker`);
      job.worker.cancel();
    } else {
      logger.info(`[JobManager] Job ${job.id} [${job.workerType}] → cancelled (was: ${prevStatus}) — no active worker to abort`);
    }
    this.emit('job:cancelled', job);
    return job;
  }

  /** Cancel all non-terminal jobs for a chat. Returns array of cancelled jobs. */
  cancelAllForChat(chatId) {
    const logger = getLogger();
    const allForChat = [...this.jobs.values()].filter(j => j.chatId === chatId && !j.isTerminal);
    logger.info(`[JobManager] Cancel all for chat ${chatId} — ${allForChat.length} active jobs found`);

    const cancelled = [];
    for (const job of allForChat) {
      const prevStatus = job.status;
      job.transition('cancelled');
      if (job.worker && typeof job.worker.cancel === 'function') {
        job.worker.cancel();
      }
      logger.info(`[JobManager] Job ${job.id} [${job.workerType}] → cancelled (was: ${prevStatus})`);
      this.emit('job:cancelled', job);
      cancelled.push(job);
    }
    return cancelled;
  }

  /** Get all jobs for a chat (most recent first). */
  getJobsForChat(chatId) {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt);
    getLogger().debug(`[JobManager] getJobsForChat(${chatId}): ${jobs.length} jobs`);
    return jobs;
  }

  /** Get only running jobs for a chat. */
  getRunningJobsForChat(chatId) {
    const running = [...this.jobs.values()]
      .filter((j) => j.chatId === chatId && j.status === 'running');
    getLogger().debug(`[JobManager] getRunningJobsForChat(${chatId}): ${running.length} running`);
    return running;
  }

  /** Get a job by id. */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /** Garbage-collect old terminal jobs. */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.isTerminal && job.completedAt && now - job.completedAt > this.cleanupMaxAge) {
        this.jobs.delete(id);
        removed++;
      }
    }
    if (removed) {
      getLogger().info(`[JobManager] Cleanup: removed ${removed} old jobs — ${this.jobs.size} remaining`);
    }
  }

  /** Enforce timeout on running jobs. Called periodically. */
  enforceTimeouts() {
    const now = Date.now();
    let checkedCount = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.startedAt) {
        checkedCount++;
        const elapsed = now - job.startedAt;
        if (elapsed > this.jobTimeoutMs) {
          getLogger().warn(`[JobManager] Job ${job.id} [${job.workerType}] timed out — elapsed: ${Math.round(elapsed / 1000)}s, limit: ${this.jobTimeoutMs / 1000}s`);
          // Cancel the worker first so it stops executing & frees resources
          if (job.worker && typeof job.worker.cancel === 'function') {
            job.worker.cancel();
          }
          this.failJob(job.id, `Timed out after ${this.jobTimeoutMs / 1000}s`);
        }
      }
    }
    if (checkedCount > 0) {
      getLogger().debug(`[JobManager] Timeout check: ${checkedCount} running jobs checked`);
    }
  }

  /** Internal: get job or throw. */
  _get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  }
}
