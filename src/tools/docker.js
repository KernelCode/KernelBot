import { shellRun, shellEscape } from '../utils/shell.js';

const run = (cmd, timeout = 30000) => shellRun(cmd, timeout, { maxBuffer: 10 * 1024 * 1024 });

export const definitions = [
  {
    name: 'docker_ps',
    description: 'List Docker containers.',
    input_schema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include stopped containers (default false)' },
      },
    },
  },
  {
    name: 'docker_logs',
    description: 'Get logs from a Docker container.',
    input_schema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        tail: { type: 'number', description: 'Number of lines to show (default 100)' },
      },
      required: ['container'],
    },
  },
  {
    name: 'docker_exec',
    description: 'Execute a command inside a running Docker container.',
    input_schema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or ID' },
        command: { type: 'string', description: 'Command to execute' },
      },
      required: ['container', 'command'],
    },
  },
  {
    name: 'docker_compose',
    description: 'Run a docker compose command.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Compose action (e.g. "up -d", "down", "build", "logs")' },
        project_dir: { type: 'string', description: 'Directory containing docker-compose.yml (optional)' },
      },
      required: ['action'],
    },
  },
];

export const handlers = {
  docker_ps: async (params) => {
    const flag = params.all ? '-a' : '';
    return await run(`docker ps ${flag} --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"`);
  },

  docker_logs: async (params) => {
    if (params.tail != null) {
      const tail = parseInt(params.tail, 10);
      if (!Number.isFinite(tail) || tail <= 0 || tail > 10000) {
        return { error: 'Invalid tail value: must be between 1 and 10000' };
      }
      return await run(`docker logs --tail ${tail} ${shellEscape(params.container)}`);
    }
    return await run(`docker logs --tail 100 ${shellEscape(params.container)}`);
  },

  docker_exec: async (params) => {
    return await run(`docker exec ${shellEscape(params.container)} ${params.command}`);
  },

  docker_compose: async (params) => {
    const dir = params.project_dir ? `-f ${shellEscape(params.project_dir + '/docker-compose.yml')}` : '';
    return await run(`docker compose ${dir} ${params.action}`, 120000);
  },
};
