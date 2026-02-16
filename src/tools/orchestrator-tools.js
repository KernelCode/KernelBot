import { WORKER_TYPES, getToolsForWorker, getToolNamesForWorkerType } from '../swarm/worker-registry.js';
import { getMissingCredential } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const workerTypeEnum = Object.keys(WORKER_TYPES);

/**
 * Tool definitions for the orchestrator's 3 meta-tools.
 */
export const orchestratorToolDefinitions = [
  {
    name: 'dispatch_task',
    description: `Dispatch a task to a specialized background worker. Available worker types: ${workerTypeEnum.join(', ')}. The worker runs in the background and you'll be notified when it completes.`,
    input_schema: {
      type: 'object',
      properties: {
        worker_type: {
          type: 'string',
          enum: workerTypeEnum,
          description: 'The type of worker to dispatch the task to.',
        },
        task: {
          type: 'string',
          description: 'A clear, detailed description of what the worker should do.',
        },
      },
      required: ['worker_type', 'task'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List all jobs for the current chat with their status, type, and summary.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cancel_job',
    description: 'Cancel a running or queued job by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'The ID of the job to cancel.',
        },
      },
      required: ['job_id'],
    },
  },
];

/**
 * Execute an orchestrator meta-tool.
 * The dispatch_task handler is async and fire-and-forget — it returns immediately.
 *
 * @param {string} name - Tool name
 * @param {object} input - Tool input
 * @param {object} context - { chatId, jobManager, config, spawnWorker }
 * @returns {object} Tool result
 */
export async function executeOrchestratorTool(name, input, context) {
  const logger = getLogger();
  const { chatId, jobManager, config, spawnWorker } = context;

  switch (name) {
    case 'dispatch_task': {
      const { worker_type, task } = input;
      logger.info(`[dispatch_task] Request: type=${worker_type}, task="${task.slice(0, 120)}"`);

      // Validate worker type
      if (!WORKER_TYPES[worker_type]) {
        logger.warn(`[dispatch_task] Invalid worker type: ${worker_type}`);
        return { error: `Unknown worker type: ${worker_type}. Valid: ${workerTypeEnum.join(', ')}` };
      }

      // Check concurrent job limit
      const running = jobManager.getRunningJobsForChat(chatId);
      const maxConcurrent = config.swarm?.max_concurrent_jobs || 3;
      logger.debug(`[dispatch_task] Running jobs: ${running.length}/${maxConcurrent} for chat ${chatId}`);
      if (running.length >= maxConcurrent) {
        logger.warn(`[dispatch_task] Rejected — concurrent limit reached: ${running.length}/${maxConcurrent} jobs for chat ${chatId}`);
        return { error: `Maximum concurrent jobs (${maxConcurrent}) reached. Wait for a job to finish or cancel one.` };
      }

      // Pre-check credentials for the worker's tools
      const toolNames = getToolNamesForWorkerType(worker_type);
      for (const toolName of toolNames) {
        const missing = getMissingCredential(toolName, config);
        if (missing) {
          logger.warn(`[dispatch_task] Missing credential for ${worker_type}: ${missing.envKey}`);
          return {
            error: `Missing credential for ${worker_type} worker: ${missing.label} (${missing.envKey}). Ask the user to provide it.`,
          };
        }
      }

      // Create and spawn the job
      const job = jobManager.createJob(chatId, worker_type, task);
      const workerConfig = WORKER_TYPES[worker_type];

      logger.info(`[dispatch_task] Dispatching job ${job.id} — ${workerConfig.emoji} ${workerConfig.label}: "${task.slice(0, 100)}"`);

      // Fire and forget — spawnWorker handles lifecycle
      spawnWorker(job).catch((err) => {
        logger.error(`[dispatch_task] Worker spawn error for job ${job.id}: ${err.message}`);
        if (!job.isTerminal) {
          jobManager.failJob(job.id, err.message);
        }
      });

      return {
        job_id: job.id,
        worker_type,
        status: 'dispatched',
        message: `${workerConfig.emoji} ${workerConfig.label} started.`,
      };
    }

    case 'list_jobs': {
      const jobs = jobManager.getJobsForChat(chatId);
      logger.info(`[list_jobs] Chat ${chatId} — ${jobs.length} jobs found`);
      if (jobs.length > 0) {
        logger.debug(`[list_jobs] Jobs: ${jobs.slice(0, 5).map(j => `${j.id}[${j.status}]`).join(', ')}${jobs.length > 5 ? '...' : ''}`);
      }
      if (jobs.length === 0) {
        return { message: 'No jobs for this chat.' };
      }
      return {
        jobs: jobs.slice(0, 20).map((j) => ({
          id: j.id,
          worker_type: j.workerType,
          status: j.status,
          task: j.task.slice(0, 100),
          duration: j.duration,
          summary: j.toSummary(),
        })),
      };
    }

    case 'cancel_job': {
      const { job_id } = input;
      logger.info(`[cancel_job] Request to cancel job ${job_id} in chat ${chatId}`);
      const job = jobManager.cancelJob(job_id);
      if (!job) {
        logger.warn(`[cancel_job] Job ${job_id} not found or already finished`);
        return { error: `Job ${job_id} not found or already finished.` };
      }
      logger.info(`[cancel_job] Successfully cancelled job ${job_id} [${job.workerType}]`);
      return {
        job_id: job.id,
        status: 'cancelled',
        message: `Cancelled ${WORKER_TYPES[job.workerType]?.emoji || ''} ${job.workerType} worker.`,
      };
    }

    default:
      return { error: `Unknown orchestrator tool: ${name}` };
  }
}
