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

  return config;
}

export async function loadConfigInteractive() {
  const config = loadConfig();
  return await promptForMissing(config);
}
