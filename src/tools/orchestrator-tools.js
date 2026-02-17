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
        context: {
          type: 'string',
          description: 'Optional background context for the worker — relevant conversation details, goals, constraints. The worker cannot see the chat history, so include anything important here.',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of job IDs that must complete before this worker starts. The worker will receive dependency results as context.',
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
  {
    name: 'create_automation',
    description: 'Create a recurring automation that runs on a schedule. The task description will be executed as a standalone prompt each time it fires.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short name for the automation (e.g. "Server Health Check").',
        },
        description: {
          type: 'string',
          description: 'Detailed task prompt that will be executed each time. Must be standalone and self-contained.',
        },
        schedule_type: {
          type: 'string',
          enum: ['cron', 'interval', 'random'],
          description: 'Schedule type: cron (fixed times), interval (every N minutes), random (human-like random intervals).',
        },
        cron_expression: {
          type: 'string',
          description: 'Cron expression for schedule_type=cron (e.g. "0 9 * * *" for 9am daily). 5 fields: minute hour dayOfMonth month dayOfWeek.',
        },
        interval_minutes: {
          type: 'number',
          description: 'Interval in minutes for schedule_type=interval (minimum 5).',
        },
        min_minutes: {
          type: 'number',
          description: 'Minimum interval in minutes for schedule_type=random.',
        },
        max_minutes: {
          type: 'number',
          description: 'Maximum interval in minutes for schedule_type=random.',
        },
      },
      required: ['name', 'description', 'schedule_type'],
    },
  },
  {
    name: 'list_automations',
    description: 'List all automations for the current chat with their status, schedule, and next run time.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_automation',
    description: 'Update an existing automation — change its name, description, schedule, or enable/disable it.',
    input_schema: {
      type: 'object',
      properties: {
        automation_id: {
          type: 'string',
          description: 'The ID of the automation to update.',
        },
        enabled: {
          type: 'boolean',
          description: 'Enable or disable the automation.',
        },
        name: {
          type: 'string',
          description: 'New name for the automation.',
        },
        description: {
          type: 'string',
          description: 'New task prompt for the automation.',
        },
        schedule_type: {
          type: 'string',
          enum: ['cron', 'interval', 'random'],
          description: 'New schedule type.',
        },
        cron_expression: { type: 'string' },
        interval_minutes: { type: 'number' },
        min_minutes: { type: 'number' },
        max_minutes: { type: 'number' },
      },
      required: ['automation_id'],
    },
  },
  {
    name: 'delete_automation',
    description: 'Permanently delete an automation by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        automation_id: {
          type: 'string',
          description: 'The ID of the automation to delete.',
        },
      },
      required: ['automation_id'],
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
  const { chatId, jobManager, config, spawnWorker, automationManager, user } = context;

  switch (name) {
    case 'dispatch_task': {
      const { worker_type, task, context: taskContext, depends_on } = input;
      logger.info(`[dispatch_task] Request: type=${worker_type}, task="${task.slice(0, 120)}", deps=${depends_on?.length || 0}`);

      // Validate worker type
      if (!WORKER_TYPES[worker_type]) {
        logger.warn(`[dispatch_task] Invalid worker type: ${worker_type}`);
        return { error: `Unknown worker type: ${worker_type}. Valid: ${workerTypeEnum.join(', ')}` };
      }

      // Validate dependency IDs
      const depIds = Array.isArray(depends_on) ? depends_on : [];
      for (const depId of depIds) {
        const depJob = jobManager.getJob(depId);
        if (!depJob) {
          logger.warn(`[dispatch_task] Unknown dependency job: ${depId}`);
          return { error: `Dependency job not found: ${depId}` };
        }
        if (depJob.status === 'failed' || depJob.status === 'cancelled') {
          logger.warn(`[dispatch_task] Dependency job ${depId} already ${depJob.status}`);
          return { error: `Dependency job ${depId} already ${depJob.status}. Cannot dispatch.` };
        }
      }

      // Check concurrent job limit (only if we'll spawn immediately)
      const hasUnmetDeps = depIds.some(id => {
        const dep = jobManager.getJob(id);
        return dep && dep.status !== 'completed';
      });

      if (!hasUnmetDeps) {
        const running = jobManager.getRunningJobsForChat(chatId);
        const maxConcurrent = config.swarm?.max_concurrent_jobs || 3;
        logger.debug(`[dispatch_task] Running jobs: ${running.length}/${maxConcurrent} for chat ${chatId}`);
        if (running.length >= maxConcurrent) {
          logger.warn(`[dispatch_task] Rejected — concurrent limit reached: ${running.length}/${maxConcurrent} jobs for chat ${chatId}`);
          return { error: `Maximum concurrent jobs (${maxConcurrent}) reached. Wait for a job to finish or cancel one.` };
        }
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

      // Create the job with context and dependencies
      const job = jobManager.createJob(chatId, worker_type, task);
      job.context = taskContext || null;
      job.dependsOn = depIds;
      job.userId = user?.id || null;
      const workerConfig = WORKER_TYPES[worker_type];

      // If dependencies are not all met, leave job queued (job:ready will spawn it later)
      if (hasUnmetDeps) {
        logger.info(`[dispatch_task] Job ${job.id} queued — waiting for dependencies: ${depIds.join(', ')}`);
        return {
          job_id: job.id,
          worker_type,
          status: 'queued_waiting',
          depends_on: depIds,
          message: `${workerConfig.emoji} ${workerConfig.label} queued — waiting for ${depIds.length} dependency job(s) to complete.`,
        };
      }

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
        jobs: jobs.slice(0, 20).map((j) => {
          const entry = {
            id: j.id,
            worker_type: j.workerType,
            status: j.status,
            task: j.task.slice(0, 100),
            duration: j.duration,
            recent_activity: j.progress.slice(-5),
            last_activity_seconds_ago: j.lastActivity ? Math.round((Date.now() - j.lastActivity) / 1000) : null,
            summary: j.toSummary(),
          };
          if (j.dependsOn.length > 0) entry.depends_on = j.dependsOn;
          if (j.structuredResult) {
            entry.result_summary = j.structuredResult.summary;
            entry.result_status = j.structuredResult.status;
            if (j.structuredResult.artifacts?.length > 0) entry.artifacts = j.structuredResult.artifacts;
            if (j.structuredResult.followUp) entry.follow_up = j.structuredResult.followUp;
          }
          return entry;
        }),
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

    case 'create_automation': {
      if (!automationManager) return { error: 'Automation system not available.' };

      const { name: autoName, description, schedule_type, cron_expression, interval_minutes, min_minutes, max_minutes } = input;
      logger.info(`[create_automation] Request: name="${autoName}", type=${schedule_type}`);

      let schedule;
      switch (schedule_type) {
        case 'cron':
          schedule = { type: 'cron', expression: cron_expression };
          break;
        case 'interval':
          schedule = { type: 'interval', minutes: interval_minutes };
          break;
        case 'random':
          schedule = { type: 'random', minMinutes: min_minutes, maxMinutes: max_minutes };
          break;
        default:
          return { error: `Unknown schedule type: ${schedule_type}` };
      }

      try {
        const auto = automationManager.create(chatId, { name: autoName, description, schedule });
        return {
          automation_id: auto.id,
          name: auto.name,
          schedule: auto.schedule,
          next_run: auto.nextRun ? new Date(auto.nextRun).toLocaleString() : null,
          message: `Automation "${auto.name}" created and armed.`,
        };
      } catch (err) {
        logger.warn(`[create_automation] Failed: ${err.message}`);
        return { error: err.message };
      }
    }

    case 'list_automations': {
      if (!automationManager) return { error: 'Automation system not available.' };

      const autos = automationManager.listForChat(chatId);
      logger.info(`[list_automations] Chat ${chatId} — ${autos.length} automation(s)`);

      if (autos.length === 0) {
        return { message: 'No automations for this chat.' };
      }

      return {
        automations: autos.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description.slice(0, 100),
          schedule: a.schedule,
          enabled: a.enabled,
          next_run: a.nextRun ? new Date(a.nextRun).toLocaleString() : null,
          run_count: a.runCount,
          last_error: a.lastError,
          summary: a.toSummary(),
        })),
      };
    }

    case 'update_automation': {
      if (!automationManager) return { error: 'Automation system not available.' };

      const { automation_id, enabled, name: newName, description: newDesc, schedule_type: newSchedType, cron_expression: newCron, interval_minutes: newInterval, min_minutes: newMin, max_minutes: newMax } = input;
      logger.info(`[update_automation] Request: id=${automation_id}`);

      const changes = {};
      if (enabled !== undefined) changes.enabled = enabled;
      if (newName !== undefined) changes.name = newName;
      if (newDesc !== undefined) changes.description = newDesc;

      if (newSchedType !== undefined) {
        switch (newSchedType) {
          case 'cron':
            changes.schedule = { type: 'cron', expression: newCron };
            break;
          case 'interval':
            changes.schedule = { type: 'interval', minutes: newInterval };
            break;
          case 'random':
            changes.schedule = { type: 'random', minMinutes: newMin, maxMinutes: newMax };
            break;
        }
      }

      try {
        const auto = automationManager.update(automation_id, changes);
        if (!auto) return { error: `Automation ${automation_id} not found.` };
        return {
          automation_id: auto.id,
          name: auto.name,
          enabled: auto.enabled,
          schedule: auto.schedule,
          next_run: auto.nextRun ? new Date(auto.nextRun).toLocaleString() : null,
          message: `Automation "${auto.name}" updated.`,
        };
      } catch (err) {
        logger.warn(`[update_automation] Failed: ${err.message}`);
        return { error: err.message };
      }
    }

    case 'delete_automation': {
      if (!automationManager) return { error: 'Automation system not available.' };

      const { automation_id } = input;
      logger.info(`[delete_automation] Request: id=${automation_id}`);

      const deleted = automationManager.delete(automation_id);
      if (!deleted) return { error: `Automation ${automation_id} not found.` };
      return { automation_id, status: 'deleted', message: `Automation deleted.` };
    }

    default:
      return { error: `Unknown orchestrator tool: ${name}` };
  }
}
