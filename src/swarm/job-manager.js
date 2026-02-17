import { EventEmitter } from 'events';
import { Job } from './job.js';
import { WORKER_TYPES } from './worker-registry.js';
import { getLogger } from '../utils/logger.js';

/**
 * Manages all jobs across all chats. Emits lifecycle events
 * so the orchestrator can react when workers finish.
 *
 * Events:
 *   job:completed  (job)
 *   job:failed     (job)
 *   job:cancelled  (job)
 *   job:ready      (job) — emitted when a queued job's dependencies are all met
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
    // Set per-job timeout from worker type config, fall back to global
    const workerConfig = WORKER_TYPES[workerType];
    job.timeoutMs = workerConfig?.timeout ? workerConfig.timeout * 1000 : this.jobTimeoutMs;
    this.jobs.set(job.id, job);
    const logger = getLogger();
    logger.info(`[JobManager] Job created: ${job.id} [${workerType}] for chat ${chatId} — timeout: ${job.timeoutMs / 1000}s — "${task.slice(0, 100)}"`);
    logger.debug(`[JobManager] Total jobs tracked: ${this.jobs.size}`);
    return job;
  }

  /** Move a job to running. */
  startJob(jobId) {
    const job = this._get(jobId);
    job.transition('running');
    getLogger().info(`[JobManager] Job ${job.id} [${job.workerType}] → running`);
  }

  /** Move a job to completed with a result and optional structured data. */
  completeJob(jobId, result, structuredResult = null) {
    const job = this._get(jobId);
    job.transition('completed');
    job.result = result;
    if (structuredResult) {
      job.structuredResult = structuredResult;
    }
    getLogger().info(`[JobManager] Job ${job.id} [${job.workerType}] → completed (${job.duration}s) — result: ${(result || '').length} chars, structured: ${!!structuredResult}`);
    this.emit('job:completed', job);
    this._checkDependents(job);
  }

  /** Move a job to failed with an error message. */
  failJob(jobId, error) {
    const job = this._get(jobId);
    job.transition('failed');
    job.error = typeof error === 'string' ? error : error?.message || String(error);
    getLogger().error(`[JobManager] Job ${job.id} [${job.workerType}] → failed (${job.duration}s) — ${job.error}`);
    this.emit('job:failed', job);
    this._failDependents(job);
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
        const timeoutMs = job.timeoutMs || this.jobTimeoutMs;
        if (elapsed > timeoutMs) {
          getLogger().warn(`[JobManager] Job ${job.id} [${job.workerType}] timed out — elapsed: ${Math.round(elapsed / 1000)}s, limit: ${timeoutMs / 1000}s`);
          // Cancel the worker first so it stops executing & frees resources
          if (job.worker && typeof job.worker.cancel === 'function') {
            job.worker.cancel();
          }
          this.failJob(job.id, `Timed out after ${timeoutMs / 1000}s`);
        }
      }
    }
    if (checkedCount > 0) {
      getLogger().debug(`[JobManager] Timeout check: ${checkedCount} running jobs checked`);
    }
  }

  /** Check if any queued jobs have all dependencies met after a job completes. */
  _checkDependents(completedJob) {
    const logger = getLogger();
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || job.dependsOn.length === 0) continue;
      if (!job.dependsOn.includes(completedJob.id)) continue;

      // Check if ALL dependencies are completed
      const allMet = job.dependsOn.every(depId => {
        const dep = this.jobs.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allMet) {
        logger.info(`[JobManager] Job ${job.id} [${job.workerType}] — all dependencies met, emitting job:ready`);
        this.emit('job:ready', job);
      }
    }
  }

  /** Cascade failure to dependent jobs when a job fails. */
  _failDependents(failedJob) {
    const logger = getLogger();
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || job.dependsOn.length === 0) continue;
      if (!job.dependsOn.includes(failedJob.id)) continue;

      logger.warn(`[JobManager] Job ${job.id} [${job.workerType}] — dependency ${failedJob.id} failed, cascading failure`);
      job.transition('failed');
      job.error = `Dependency job ${failedJob.id} failed: ${failedJob.error || 'unknown error'}`;
      this.emit('job:failed', job);
      // Recursively cascade to jobs depending on this one
      this._failDependents(job);
    }
  }

  /** Internal: get job or throw. */
  _get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  }
}
