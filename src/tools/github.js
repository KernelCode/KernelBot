import { Octokit } from '@octokit/rest';

function getOctokit(config) {
  const token = config.github?.token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured');
  return new Octokit({ auth: token });
}

function parseRepo(repo) {
  const parts = repo.replace('https://github.com/', '').replace('.git', '').split('/');
  if (parts.length < 2) throw new Error(`Invalid repo format: ${repo}. Use "owner/repo".`);
  return { owner: parts[0], repo: parts[1] };
}

export const definitions = [
  {
    name: 'github_create_pr',
    description: 'Create a pull request on GitHub.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format' },
        head: { type: 'string', description: 'Source branch name' },
        base: { type: 'string', description: 'Target branch (default: main)' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description' },
      },
      required: ['repo', 'head', 'title'],
    },
  },
  {
    name: 'github_get_pr_diff',
    description: 'Get the diff of a pull request.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format' },
        pr_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['repo', 'pr_number'],
    },
  },
  {
    name: 'github_post_review',
    description: 'Post a review on a pull request.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format' },
        pr_number: { type: 'number', description: 'Pull request number' },
        body: { type: 'string', description: 'Review body text' },
        event: {
          type: 'string',
          description: 'Review action',
          enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
        },
      },
      required: ['repo', 'pr_number', 'body', 'event'],
    },
  },
  {
    name: 'github_create_repo',
    description: 'Create a new GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        org: { type: 'string', description: 'Organization (optional, defaults to personal)' },
        private: { type: 'boolean', description: 'Private repo (default true)' },
        description: { type: 'string', description: 'Repo description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'github_list_prs',
    description: 'List pull requests for a repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format' },
        state: { type: 'string', description: 'Filter by state: open, closed, all (default: open)' },
      },
      required: ['repo'],
    },
  },
];

export const handlers = {
  github_create_pr: async (params, context) => {
    try {
      const octokit = getOctokit(context.config);
      const { owner, repo } = parseRepo(params.repo);
      const base = params.base || context.config.github?.default_branch || 'main';

      const { data } = await octokit.pulls.create({
        owner,
        repo,
        head: params.head,
        base,
        title: params.title,
        body: params.body || '',
      });

      return { success: true, pr_number: data.number, url: data.html_url };
    } catch (err) {
      return { error: err.message };
    }
  },

  github_get_pr_diff: async (params, context) => {
    try {
      const octokit = getOctokit(context.config);
      const { owner, repo } = parseRepo(params.repo);

      const { data } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: params.pr_number,
        mediaType: { format: 'diff' },
      });

      return { diff: data };
    } catch (err) {
      return { error: err.message };
    }
  },

  github_post_review: async (params, context) => {
    try {
      const octokit = getOctokit(context.config);
      const { owner, repo } = parseRepo(params.repo);

      const { data } = await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: params.pr_number,
        body: params.body,
        event: params.event,
      });

      return { success: true, review_id: data.id };
    } catch (err) {
      return { error: err.message };
    }
  },

  github_create_repo: async (params, context) => {
    try {
      const octokit = getOctokit(context.config);
      const org = params.org || context.config.github?.default_org;
      const isPrivate = params.private !== false;

      let data;
      if (org) {
        ({ data } = await octokit.repos.createInOrg({
          org,
          name: params.name,
          private: isPrivate,
          description: params.description || '',
        }));
      } else {
        ({ data } = await octokit.repos.createForAuthenticatedUser({
          name: params.name,
          private: isPrivate,
          description: params.description || '',
        }));
      }

      return { success: true, url: data.html_url, clone_url: data.clone_url };
    } catch (err) {
      return { error: err.message };
    }
  },

  github_list_prs: async (params, context) => {
    try {
      const octokit = getOctokit(context.config);
      const { owner, repo } = parseRepo(params.repo);

      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: params.state || 'open',
      });

      const prs = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user.login,
        url: pr.html_url,
        created_at: pr.created_at,
      }));

      return { prs };
    } catch (err) {
      return { error: err.message };
    }
  },
};
