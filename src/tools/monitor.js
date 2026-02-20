import { platform } from 'os';
import { shellRun as run } from '../utils/shell.js';

const isMac = platform() === 'darwin';

export const definitions = [
  {
    name: 'disk_usage',
    description: 'Show disk space usage.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_usage',
    description: 'Show memory (RAM) usage.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cpu_usage',
    description: 'Show CPU load information.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'system_logs',
    description: 'Read system or application logs.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Log source — file path or "journalctl" (default: journalctl)',
        },
        lines: { type: 'number', description: 'Number of lines to show (default 50)' },
        filter: { type: 'string', description: 'Filter string (optional)' },
      },
    },
  },
];

export const handlers = {
  disk_usage: async () => {
    return await run('df -h');
  },

  memory_usage: async () => {
    if (isMac) {
      // macOS doesn't have /proc/meminfo or free
      const vm = await run('vm_stat');
      const total = await run("sysctl -n hw.memsize | awk '{print $1/1073741824}'");
      return { output: `Total RAM: ${total.output}GB\n\n${vm.output}` };
    }
    return await run('free -h');
  },

  cpu_usage: async () => {
    if (isMac) {
      return await run('top -l 1 -n 0 | head -10');
    }
    return await run('uptime && echo "---" && cat /proc/loadavg');
  },

  system_logs: async (params) => {
    const lines = params.lines || 50;
    const source = params.source || 'journalctl';
    const filter = params.filter;

    if (source === 'journalctl') {
      const filterArg = filter ? ` -g "${filter}"` : '';
      return await run(`journalctl -n ${lines}${filterArg} --no-pager`);
    }

    // Reading a log file
    const filterCmd = filter ? ` | grep -i "${filter}"` : '';
    return await run(`tail -n ${lines} "${source}"${filterCmd}`);
  },
};
