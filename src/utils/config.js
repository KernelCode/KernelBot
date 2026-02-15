import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

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

function findConfigFile() {
  const cwdPath = join(process.cwd(), 'config.yaml');
  if (existsSync(cwdPath)) return cwdPath;

  const homePath = join(homedir(), '.kernelbot', 'config.yaml');
  if (existsSync(homePath)) return homePath;

  return null;
}

export function loadConfig() {
  dotenv.config();

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

  return Object.freeze(config);
}
