import { shellRun, shellEscape } from '../utils/shell.js';
import { getLogger } from '../utils/logger.js';

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
    const logger = getLogger();
    const flag = params.all ? '-a' : '';
    logger.debug('docker_ps: listing containers');
    const result = await run(`docker ps ${flag} --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"`);
    if (result.error) logger.error(`docker_ps failed: ${result.error}`);
    return result;
  },

  docker_logs: async (params) => {
    const logger = getLogger();
    if (params.tail != null) {
      const tail = parseInt(params.tail, 10);
      if (!Number.isFinite(tail) || tail <= 0 || tail > 10000) {
        return { error: 'Invalid tail value: must be between 1 and 10000' };
      }
      logger.debug(`docker_logs: fetching ${tail} lines from ${params.container}`);
      const result = await run(`docker logs --tail ${tail} ${shellEscape(params.container)}`);
      if (result.error) logger.error(`docker_logs failed for ${params.container}: ${result.error}`);
      return result;
    }
    logger.debug(`docker_logs: fetching 100 lines from ${params.container}`);
    const result = await run(`docker logs --tail 100 ${shellEscape(params.container)}`);
    if (result.error) logger.error(`docker_logs failed for ${params.container}: ${result.error}`);
    return result;
  },

  docker_exec: async (params) => {
    const logger = getLogger();
    if (!params.command || !params.command.trim()) {
      return { error: 'Command must not be empty' };
    }
    logger.debug(`docker_exec: running command in ${params.container}`);
    const result = await run(`docker exec ${shellEscape(params.container)} sh -c ${shellEscape(params.command)}`);
    if (result.error) logger.error(`docker_exec failed in ${params.container}: ${result.error}`);
    return result;
  },

  docker_compose: async (params) => {
    const logger = getLogger();
    const dir = params.project_dir ? `-f ${shellEscape(params.project_dir + '/docker-compose.yml')}` : '';
    logger.debug(`docker_compose: ${params.action}`);
    const result = await run(`docker compose ${dir} ${params.action}`, 120000);
    if (result.error) logger.error(`docker_compose '${params.action}' failed: ${result.error}`);
    return result;
  },
};
