import simpleGit from 'simple-git';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

function getWorkspaceDir(config) {
  const dir = config.claude_code?.workspace_dir || join(homedir(), '.kernelbot', 'workspaces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const definitions = [
  {
    name: 'git_clone',
    description: 'Clone a git repository. Accepts "org/repo" shorthand (uses GitHub) or a full URL.',
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository — "org/repo" or full git URL',
        },
        dest: {
          type: 'string',
          description: 'Destination directory name (optional, defaults to repo name)',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'git_checkout',
    description: 'Checkout an existing branch or create a new one.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository directory path' },
        branch: { type: 'string', description: 'Branch name' },
        create: { type: 'boolean', description: 'Create the branch if it doesn\'t exist (default false)' },
      },
      required: ['dir', 'branch'],
    },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and create a commit.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository directory path' },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['dir', 'message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push the current branch to the remote.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository directory path' },
        force: { type: 'boolean', description: 'Force push (default false)' },
      },
      required: ['dir'],
    },
  },
  {
    name: 'git_diff',
    description: 'Get the diff of current uncommitted changes.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository directory path' },
      },
      required: ['dir'],
    },
  },
];

export const handlers = {
  git_clone: async (params, context) => {
    const { repo, dest } = params;
    const workspaceDir = getWorkspaceDir(context.config);

    let url = repo;
    if (!repo.includes('://') && !repo.startsWith('git@')) {
      url = `https://github.com/${repo}.git`;
    }

    const repoName = dest || repo.split('/').pop().replace('.git', '');
    const targetDir = join(workspaceDir, repoName);

    try {
      const git = simpleGit();
      await git.clone(url, targetDir);
      return { success: true, path: targetDir };
    } catch (err) {
      return { error: err.message };
    }
  },

  git_checkout: async (params) => {
    const { dir, branch, create = false } = params;
    try {
      const git = simpleGit(dir);
      if (create) {
        await git.checkoutLocalBranch(branch);
      } else {
        await git.checkout(branch);
      }
      return { success: true, branch };
    } catch (err) {
      return { error: err.message };
    }
  },

  git_commit: async (params) => {
    const { dir, message } = params;
    try {
      const git = simpleGit(dir);
      await git.add('.');
      const result = await git.commit(message);
      return { success: true, commit: result.commit, summary: result.summary };
    } catch (err) {
      return { error: err.message };
    }
  },

  git_push: async (params) => {
    const { dir, force = false } = params;
    try {
      const git = simpleGit(dir);
      const branch = (await git.branchLocal()).current;
      const options = force ? ['--force'] : [];
      await git.push('origin', branch, options);
      return { success: true, branch };
    } catch (err) {
      return { error: err.message };
    }
  },

  git_diff: async (params) => {
    const { dir } = params;
    try {
      const git = simpleGit(dir);
      const diff = await git.diff();
      const staged = await git.diff(['--cached']);
      return { unstaged: diff || '(no changes)', staged: staged || '(no staged changes)' };
    } catch (err) {
      return { error: err.message };
    }
  },
};
