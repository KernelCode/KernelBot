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
    getLogger().info(`Job created: ${job.id} [${workerType}] for chat ${chatId}`);
    return job;
  }

  /** Move a job to running. */
  startJob(jobId) {
    const job = this._get(jobId);
    job.transition('running');
    getLogger().info(`Job started: ${job.id}`);
  }

  /** Move a job to completed with a result. */
  completeJob(jobId, result) {
    const job = this._get(jobId);
    job.transition('completed');
    job.result = result;
    getLogger().info(`Job completed: ${job.id} (${job.duration}s)`);
    this.emit('job:completed', job);
  }

  /** Move a job to failed with an error message. */
  failJob(jobId, error) {
    const job = this._get(jobId);
    job.transition('failed');
    job.error = typeof error === 'string' ? error : error?.message || String(error);
    getLogger().error(`Job failed: ${job.id} — ${job.error}`);
    this.emit('job:failed', job);
  }

  /** Cancel a specific job. Returns the job or null if not found / already terminal. */
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.isTerminal) return null;

    job.transition('cancelled');
    // Abort the worker if it's running
    if (job.worker && typeof job.worker.cancel === 'function') {
      job.worker.cancel();
    }
    getLogger().info(`Job cancelled: ${job.id}`);
    this.emit('job:cancelled', job);
    return job;
  }

  /** Cancel all non-terminal jobs for a chat. Returns array of cancelled jobs. */
  cancelAllForChat(chatId) {
    const cancelled = [];
    for (const job of this.jobs.values()) {
      if (job.chatId === chatId && !job.isTerminal) {
        job.transition('cancelled');
        if (job.worker && typeof job.worker.cancel === 'function') {
          job.worker.cancel();
        }
        this.emit('job:cancelled', job);
        cancelled.push(job);
      }
    }
    if (cancelled.length) {
      getLogger().info(`Cancelled ${cancelled.length} jobs for chat ${chatId}`);
    }
    return cancelled;
  }

  /** Get all jobs for a chat (most recent first). */
  getJobsForChat(chatId) {
    return [...this.jobs.values()]
      .filter((j) => j.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get only running jobs for a chat. */
  getRunningJobsForChat(chatId) {
    return [...this.jobs.values()]
      .filter((j) => j.chatId === chatId && j.status === 'running');
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
    if (removed) getLogger().info(`JobManager cleanup: removed ${removed} old jobs`);
  }

  /** Enforce timeout on running jobs. Called periodically. */
  enforceTimeouts() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.startedAt && now - job.startedAt > this.jobTimeoutMs) {
        getLogger().warn(`Job ${job.id} timed out after ${this.jobTimeoutMs / 1000}s`);
        this.failJob(job.id, `Timed out after ${this.jobTimeoutMs / 1000}s`);
      }
    }
  }

  /** Internal: get job or throw. */
  _get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  }
}
