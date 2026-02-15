import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import chalk from 'chalk';

const DEFAULTS = {
  bot: {
    name: 'KernelBot',
    description: 'AI engineering agent with full OS control',
  },
  anthropic: {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    temperature: 0.3,
    max_tool_depth: 25,
  },
  telegram: {
    allowed_users: [],
  },
  claude_code: {
    model: 'claude-opus-4-6',
    max_turns: 50,
    timeout_seconds: 600,
    workspace_dir: null, // defaults to ~/.kernelbot/workspaces
  },
  github: {
    default_branch: 'main',
    default_org: null,
  },
  security: {
    blocked_paths: [
      '/etc/shadow',
      '/etc/passwd',
      '~/.ssh/id_rsa',
      '~/.ssh/id_ed25519',
    ],
  },
  logging: {
    level: 'info',
    max_file_size: 5_242_880,
  },
  conversation: {
    max_history: 50,
  },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function getConfigDir() {
  return join(homedir(), '.kernelbot');
}

function getEnvPath() {
  const cwdEnv = join(process.cwd(), '.env');
  if (existsSync(cwdEnv)) return cwdEnv;
  return join(getConfigDir(), '.env');
}

function findConfigFile() {
  const cwdPath = join(process.cwd(), 'config.yaml');
  if (existsSync(cwdPath)) return cwdPath;

  const homePath = join(getConfigDir(), 'config.yaml');
  if (existsSync(homePath)) return homePath;

  return null;
}

function ask(rl, question) {
  return new Promise((res) => rl.question(question, res));
}

async function promptForMissing(config) {
  const missing = [];
  if (!config.anthropic.api_key) missing.push('ANTHROPIC_API_KEY');
  if (!config.telegram.bot_token) missing.push('TELEGRAM_BOT_TOKEN');

  if (missing.length === 0) return config;

  console.log(chalk.yellow('\n  Missing credentials detected. Let\'s set them up.\n'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const mutableConfig = JSON.parse(JSON.stringify(config));
  const envLines = [];

  // Read existing .env if any
  const envPath = getEnvPath();
  let existingEnv = '';
  if (existsSync(envPath)) {
    existingEnv = readFileSync(envPath, 'utf-8');
  }

  if (!mutableConfig.anthropic.api_key) {
    const key = await ask(rl, chalk.cyan('  Anthropic API key: '));
    mutableConfig.anthropic.api_key = key.trim();
    envLines.push(`ANTHROPIC_API_KEY=${key.trim()}`);
  }

  if (!mutableConfig.telegram.bot_token) {
    const token = await ask(rl, chalk.cyan('  Telegram Bot Token: '));
    mutableConfig.telegram.bot_token = token.trim();
    envLines.push(`TELEGRAM_BOT_TOKEN=${token.trim()}`);
  }

  rl.close();

  // Save to ~/.kernelbot/.env so it persists globally
  if (envLines.length > 0) {
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const savePath = join(configDir, '.env');

    // Merge with existing content
    let content = existingEnv ? existingEnv.trimEnd() + '\n' : '';
    for (const line of envLines) {
      const key = line.split('=')[0];
      // Replace if exists, append if not
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, line);
      } else {
        content += line + '\n';
      }
    }
    writeFileSync(savePath, content);
    console.log(chalk.dim(`\n  Saved to ${savePath}\n`));
  }

  return mutableConfig;
}

export function loadConfig() {
  // Load .env from CWD first, then from ~/.kernelbot/
  dotenv.config();
  const globalEnv = join(getConfigDir(), '.env');
  if (existsSync(globalEnv)) {
    dotenv.config({ path: globalEnv });
  }

  let fileConfig = {};
  const configPath = findConfigFile();
  if (configPath) {
    const raw = readFileSync(configPath, 'utf-8');
    fileConfig = yaml.load(raw) || {};
  }

  const config = deepMerge(DEFAULTS, fileConfig);

  // Overlay env vars for secrets
  if (process.env.ANTHROPIC_API_KEY) {
    config.anthropic.api_key = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram.bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.GITHUB_TOKEN) {
    if (!config.github) config.github = {};
    config.github.token = process.env.GITHUB_TOKEN;
  }
  if (process.env.JIRA_BASE_URL || process.env.JIRA_EMAIL || process.env.JIRA_API_TOKEN) {
    if (!config.jira) config.jira = {};
    if (process.env.JIRA_BASE_URL) config.jira.base_url = process.env.JIRA_BASE_URL;
    if (process.env.JIRA_EMAIL) config.jira.email = process.env.JIRA_EMAIL;
    if (process.env.JIRA_API_TOKEN) config.jira.api_token = process.env.JIRA_API_TOKEN;
  }

  return config;
}

export async function loadConfigInteractive() {
  const config = loadConfig();
  return await promptForMissing(config);
}

/**
 * Save a credential to ~/.kernelbot/.env and update the live config object.
 * Called at runtime when a user provides a missing token via Telegram.
 */
export function saveCredential(config, envKey, value) {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const envPath = join(configDir, '.env');

  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8').trimEnd() + '\n';
  }

  const regex = new RegExp(`^${envKey}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${envKey}=${value}`);
  } else {
    content += `${envKey}=${value}\n`;
  }
  writeFileSync(envPath, content);

  // Update live config
  switch (envKey) {
    case 'GITHUB_TOKEN':
      if (!config.github) config.github = {};
      config.github.token = value;
      break;
    case 'ANTHROPIC_API_KEY':
      config.anthropic.api_key = value;
      break;
    case 'TELEGRAM_BOT_TOKEN':
      config.telegram.bot_token = value;
      break;
    case 'JIRA_BASE_URL':
      if (!config.jira) config.jira = {};
      config.jira.base_url = value;
      break;
    case 'JIRA_EMAIL':
      if (!config.jira) config.jira = {};
      config.jira.email = value;
      break;
    case 'JIRA_API_TOKEN':
      if (!config.jira) config.jira = {};
      config.jira.api_token = value;
      break;
  }

  // Also set in process.env so tools pick it up
  process.env[envKey] = value;
}

/**
 * Check which credentials a tool needs and return the missing one, if any.
 */
export function getMissingCredential(toolName, config) {
  const githubTools = ['github_create_pr', 'github_get_pr_diff', 'github_post_review', 'github_create_repo', 'github_list_prs', 'git_clone', 'git_push'];

  if (githubTools.includes(toolName)) {
    const token = config.github?.token || process.env.GITHUB_TOKEN;
    if (!token) {
      return { envKey: 'GITHUB_TOKEN', label: 'GitHub Personal Access Token' };
    }
  }

  const jiraTools = ['jira_get_ticket', 'jira_search_tickets', 'jira_list_my_tickets', 'jira_get_project_tickets'];

  if (jiraTools.includes(toolName)) {
    if (!config.jira?.base_url && !process.env.JIRA_BASE_URL) {
      return { envKey: 'JIRA_BASE_URL', label: 'JIRA Base URL (e.g. https://yourcompany.atlassian.net)' };
    }
    if (!config.jira?.email && !process.env.JIRA_EMAIL) {
      return { envKey: 'JIRA_EMAIL', label: 'JIRA Email / Username' };
    }
    if (!config.jira?.api_token && !process.env.JIRA_API_TOKEN) {
      return { envKey: 'JIRA_API_TOKEN', label: 'JIRA API Token' };
    }
  }

  return null;
}
