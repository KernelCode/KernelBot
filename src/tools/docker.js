import { exec } from 'child_process';

function run(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ error: stderr || error.message });
      resolve({ output: stdout.trim() });
    });
  });
}

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
    const tail = params.tail || 100;
    return await run(`docker logs --tail ${tail} ${params.container}`);
  },

  docker_exec: async (params) => {
    return await run(`docker exec ${params.container} ${params.command}`);
  },

  docker_compose: async (params) => {
    const dir = params.project_dir ? `-f ${params.project_dir}/docker-compose.yml` : '';
    return await run(`docker compose ${dir} ${params.action}`, 120000);
  },
};
