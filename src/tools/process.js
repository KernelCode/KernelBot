import { exec } from 'child_process';

function run(cmd, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (error, stdout, stderr) => {
      if (error) return resolve({ error: stderr || error.message });
      resolve({ output: stdout.trim() });
    });
  });
}

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
    const cmd = filter ? `ps aux | head -1 && ps aux | grep -i "${filter}" | grep -v grep` : 'ps aux';
    return await run(cmd);
  },

  kill_process: async (params) => {
    if (params.pid) {
      return await run(`kill ${params.pid}`);
    }
    if (params.name) {
      return await run(`pkill -f "${params.name}"`);
    }
    return { error: 'Provide either pid or name' };
  },

  service_control: async (params) => {
    const { service, action } = params;
    return await run(`systemctl ${action} ${service}`);
  },
};
