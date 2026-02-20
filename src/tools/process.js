import { shellRun as run, shellEscape } from '../utils/shell.js';
import { getLogger } from '../utils/logger.js';

export const definitions = [
  {
    name: 'process_list',
    description: 'List running processes. Optionally filter by name.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter processes by name (optional)' },
      },
    },
  },
  {
    name: 'kill_process',
    description: 'Kill a process by PID or name.',
    input_schema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process ID to kill' },
        name: { type: 'string', description: 'Process name to kill (uses pkill)' },
      },
    },
  },
  {
    name: 'service_control',
    description: 'Manage systemd services (start, stop, restart, status).',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['start', 'stop', 'restart', 'status'],
        },
      },
      required: ['service', 'action'],
    },
  },
];

export const handlers = {
  process_list: async (params) => {
    const logger = getLogger();
    const filter = params.filter;
    logger.debug(`process_list: ${filter ? `filtering by "${filter}"` : 'listing all'}`);
    const cmd = filter ? `ps aux | head -1 && ps aux | grep -i ${shellEscape(filter)} | grep -v grep` : 'ps aux';
    return await run(cmd);
  },

  kill_process: async (params) => {
    const logger = getLogger();
    if (params.pid) {
      const pid = parseInt(params.pid, 10);
      if (!Number.isFinite(pid) || pid <= 0) return { error: 'Invalid PID' };
      logger.debug(`kill_process: killing PID ${pid}`);
      const result = await run(`kill ${pid}`);
      if (result.error) logger.error(`kill_process failed for PID ${pid}: ${result.error}`);
      return result;
    }
    if (params.name) {
      logger.debug(`kill_process: killing processes matching "${params.name}"`);
      const result = await run(`pkill -f ${shellEscape(params.name)}`);
      if (result.error) logger.error(`kill_process failed for name "${params.name}": ${result.error}`);
      return result;
    }
    return { error: 'Provide either pid or name' };
  },

  service_control: async (params) => {
    const logger = getLogger();
    const { service, action } = params;
    logger.debug(`service_control: ${action} ${service}`);
    const result = await run(`systemctl ${shellEscape(action)} ${shellEscape(service)}`);
    if (result.error) logger.error(`service_control failed: ${action} ${service}: ${result.error}`);
    return result;
  },
};
