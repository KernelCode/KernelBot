import { ClaudeCodeSpawner } from '../coder.js';

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
    try {
      const coder = getSpawner(context.config);
      const result = await coder.run({
        workingDirectory: params.working_directory,
        prompt: params.prompt,
        maxTurns: params.max_turns,
      });
      return { success: true, output: result.output };
    } catch (err) {
      return { error: err.message };
    }
  },
};
