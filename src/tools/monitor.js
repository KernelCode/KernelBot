import { platform } from 'os';
import { shellRun as run, shellEscape } from '../utils/shell.js';

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
    let finalLines = 50;
    if (params.lines != null) {
      const lines = parseInt(params.lines, 10);
      if (!Number.isFinite(lines) || lines <= 0 || lines > 10000) {
        return { error: 'Invalid lines value: must be between 1 and 10000' };
      }
      finalLines = lines;
    }
    const source = params.source || 'journalctl';
    const filter = params.filter;

    if (source === 'journalctl') {
      const filterArg = filter ? ` -g ${shellEscape(filter)}` : '';
      return await run(`journalctl -n ${finalLines}${filterArg} --no-pager`);
    }

    // Reading a log file
    const filterCmd = filter ? ` | grep -i ${shellEscape(filter)}` : '';
    return await run(`tail -n ${finalLines} ${shellEscape(source)}${filterCmd}`);
  },
};
