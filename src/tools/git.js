import simpleGit from 'simple-git';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { getLogger } from '../utils/logger.js';

function getWorkspaceDir(config) {
  const dir = config.claude_code?.workspace_dir || join(homedir(), '.kernelbot', 'workspaces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get the auth header value for GitHub HTTPS operations.
 * Uses extraheader instead of embedding credentials in the URL,
 * preventing token leaks in git remote -v, error messages, and process listings.
 */
function getGitAuthEnv(config) {
  const token = config.github?.token || process.env.GITHUB_TOKEN;
  if (!token) return null;
  const base64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `AUTHORIZATION: basic ${base64}`;
}

/**
 * Configure a simple-git instance with auth via extraheader (not URL embedding).
 */
function configureGitAuth(git, config) {
  const authHeader = getGitAuthEnv(config);
  if (authHeader) {
    git.env('GIT_CONFIG_COUNT', '1');
    git.env('GIT_CONFIG_KEY_0', 'http.extraheader');
    git.env('GIT_CONFIG_VALUE_0', authHeader);
  }
  return git;
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
    // Prevent path traversal — dest must not escape workspace directory
    if (repoName.includes('..') || repoName.startsWith('/')) {
      return { error: 'Invalid destination: path traversal is not allowed' };
    }
    const targetDir = join(workspaceDir, repoName);
    if (!targetDir.startsWith(workspaceDir)) {
      return { error: 'Invalid destination: path escapes workspace directory' };
    }

    try {
      const git = configureGitAuth(simpleGit(), context.config);
      await git.clone(url, targetDir);
      return { success: true, path: targetDir };
    } catch (err) {
      getLogger().error(`git_clone failed for ${params.repo}: ${err.message}`);
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
      getLogger().error(`git_checkout failed for branch ${params.branch}: ${err.message}`);
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
      getLogger().error(`git_commit failed: ${err.message}`);
      return { error: err.message };
    }
  },

  git_push: async (params, context) => {
    const { dir, force = false } = params;
    try {
      // Use extraheader auth instead of modifying remote URLs
      const git = configureGitAuth(simpleGit(dir), context.config);

      const branch = (await git.branchLocal()).current;
      const options = ['-u'];
      if (force) options.push('--force');
      await git.push('origin', branch, options);
      return { success: true, branch };
    } catch (err) {
      getLogger().error(`git_push failed: ${err.message}`);
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
      getLogger().error(`git_diff failed: ${err.message}`);
      return { error: err.message };
    }
  },
};
