import { shellRun as run, shellEscape } from '../utils/shell.js';

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
    const filter = params.filter;
    const cmd = filter ? `ps aux | head -1 && ps aux | grep -i ${shellEscape(filter)} | grep -v grep` : 'ps aux';
    return await run(cmd);
  },

  kill_process: async (params) => {
    if (params.pid) {
      const pid = parseInt(params.pid, 10);
      if (!Number.isFinite(pid) || pid <= 0) return { error: 'Invalid PID' };
      return await run(`kill ${pid}`);
    }
    if (params.name) {
      return await run(`pkill -f ${shellEscape(params.name)}`);
    }
    return { error: 'Provide either pid or name' };
  },

  service_control: async (params) => {
    const { service, action } = params;
    return await run(`systemctl ${shellEscape(action)} ${shellEscape(service)}`);
  },
};
