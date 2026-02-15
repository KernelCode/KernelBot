import { existsSync } from 'fs';
import { resolve } from 'path';
import { ClaudeCodeSpawner } from '../coder.js';
import { getLogger } from '../utils/logger.js';

let spawner = null;

function getSpawner(config) {
  if (!spawner) spawner = new ClaudeCodeSpawner(config);
  return spawner;
}

export const definitions = [
  {
    name: 'spawn_claude_code',
    description:
      'Spawn Claude Code CLI to perform coding tasks in a directory. Use for writing code, fixing bugs, reviewing diffs, and scaffolding projects. Claude Code has full access to the filesystem within the given directory.',
    input_schema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'The directory to run Claude Code in (should be a cloned repo)',
        },
        prompt: {
          type: 'string',
          description: 'The coding task to perform — be specific about what to do',
        },
        max_turns: {
          type: 'number',
          description: 'Max turns for Claude Code (optional, default from config)',
        },
      },
      required: ['working_directory', 'prompt'],
    },
  },
];

export const handlers = {
  spawn_claude_code: async (params, context) => {
    const logger = getLogger();
    const onUpdate = context.onUpdate || null;
    const dir = resolve(params.working_directory);

    // Validate directory exists
    if (!existsSync(dir)) {
      const msg = `Directory not found: ${dir}`;
      logger.error(`spawn_claude_code: ${msg}`);
      if (onUpdate) onUpdate(`❌ ${msg}`).catch(() => {});
      return { error: msg };
    }

    try {
      const coder = getSpawner(context.config);
      const result = await coder.run({
        workingDirectory: dir,
        prompt: params.prompt,
        maxTurns: params.max_turns,
        onOutput: onUpdate,
      });

      // Show stderr if any
      if (result.stderr && onUpdate) {
        onUpdate(`⚠️ Claude Code stderr:\n\`\`\`\n${result.stderr.slice(0, 500)}\n\`\`\``).catch(() => {});
      }

      return { success: true, output: result.output };
    } catch (err) {
      logger.error(`spawn_claude_code failed: ${err.message}`);
      if (onUpdate) onUpdate(`❌ Claude Code error: ${err.message}`).catch(() => {});
      return { error: err.message };
    }
  },
};
