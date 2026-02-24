import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { PROVIDERS } from '../providers/models.js';

const DEFAULTS = {
  bot: {
    name: 'KernelBot',
    description: 'AI engineering agent with full OS control',
  },
  orchestrator: {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    temperature: 0.3,
    max_tool_depth: 5,
  },
  brain: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    temperature: 0.3,
  },
  swarm: {
    max_concurrent_jobs: 3,
    job_timeout_seconds: 300,
    cleanup_interval_minutes: 30,
  },
  telegram: {
    allowed_users: [],
    batch_window_ms: 3000,
  },
  claude_code: {
    model: 'claude-opus-4-6',
    max_turns: 50,
    timeout_seconds: 600,
    workspace_dir: null, // defaults to ~/.kernelbot/workspaces
    auth_mode: 'system', // system | api_key | oauth_token
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
    recent_window: 10,
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

/**
 * Migrate legacy `anthropic` config section → `brain` section.
 */
function migrateAnthropicConfig(config) {
  if (config.anthropic && !config.brain) {
    config.brain = {
      provider: 'anthropic',
      model: config.anthropic.model || DEFAULTS.brain.model,
      max_tokens: config.anthropic.max_tokens || DEFAULTS.brain.max_tokens,
      temperature: config.anthropic.temperature ?? DEFAULTS.brain.temperature,
      max_tool_depth: config.anthropic.max_tool_depth || DEFAULTS.brain.max_tool_depth,
    };
    if (config.anthropic.api_key) {
      config.brain.api_key = config.anthropic.api_key;
    }
  }
  return config;
}

/**
 * Interactive provider → model picker.
 */
export async function promptProviderSelection(rl) {
  const providerKeys = Object.keys(PROVIDERS);

  console.log(chalk.bold('\n  Select AI provider:\n'));
  providerKeys.forEach((key, i) => {
    console.log(`  ${chalk.cyan(`${i + 1}.`)} ${PROVIDERS[key].name}`);
  });
  console.log('');

  let providerIdx;
  while (true) {
    const input = await ask(rl, chalk.cyan('  Provider (number): '));
    providerIdx = parseInt(input.trim(), 10) - 1;
    if (providerIdx >= 0 && providerIdx < providerKeys.length) break;
    console.log(chalk.dim('  Invalid choice, try again.'));
  }

  const providerKey = providerKeys[providerIdx];
  const provider = PROVIDERS[providerKey];

  console.log(chalk.bold(`\n  Select model for ${provider.name}:\n`));
  provider.models.forEach((m, i) => {
    console.log(`  ${chalk.cyan(`${i + 1}.`)} ${m.label} (${m.id})`);
  });
  console.log('');

  let modelIdx;
  while (true) {
    const input = await ask(rl, chalk.cyan('  Model (number): '));
    modelIdx = parseInt(input.trim(), 10) - 1;
    if (modelIdx >= 0 && modelIdx < provider.models.length) break;
    console.log(chalk.dim('  Invalid choice, try again.'));
  }

  const model = provider.models[modelIdx];
  return { providerKey, modelId: model.id };
}

/**
 * Read config.yaml, merge changes into a top-level section, and write it back.
 * @param {string} section - The top-level YAML key to update (e.g. 'brain', 'orchestrator').
 * @param {object} changes - Key-value pairs to merge into that section.
 * @returns {string} The path to the written config file.
 */
function _patchConfigYaml(section, changes) {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.yaml');

  let existing = {};
  if (existsSync(configPath)) {
    existing = yaml.load(readFileSync(configPath, 'utf-8')) || {};
  }

  existing[section] = { ...(existing[section] || {}), ...changes };
  writeFileSync(configPath, yaml.dump(existing, { lineWidth: -1 }));
  return configPath;
}

/**
 * Save provider and model to config.yaml.
 */
export function saveProviderToYaml(providerKey, modelId) {
  const configPath = _patchConfigYaml('brain', { provider: providerKey, model: modelId });

  // Remove legacy anthropic section if migrating
  let existing = yaml.load(readFileSync(configPath, 'utf-8')) || {};
  if (existing.anthropic) {
    delete existing.anthropic;
    writeFileSync(configPath, yaml.dump(existing, { lineWidth: -1 }));
  }

  return configPath;
}

/**
 * Save orchestrator provider and model to config.yaml.
 */
export function saveOrchestratorToYaml(providerKey, modelId) {
  return _patchConfigYaml('orchestrator', { provider: providerKey, model: modelId });
}

/**
 * Save Claude Code model to config.yaml.
 */
export function saveClaudeCodeModelToYaml(modelId) {
  return _patchConfigYaml('claude_code', { model: modelId });
}

/**
 * Save Claude Code auth mode + credential to config.yaml and .env.
 */
export function saveClaudeCodeAuth(config, mode, value) {
  _patchConfigYaml('claude_code', { auth_mode: mode });

  // Update live config
  config.claude_code.auth_mode = mode;

  if (mode === 'api_key' && value) {
    saveCredential(config, 'CLAUDE_CODE_API_KEY', value);
    config.claude_code.api_key = value;
  } else if (mode === 'oauth_token' && value) {
    saveCredential(config, 'CLAUDE_CODE_OAUTH_TOKEN', value);
    config.claude_code.oauth_token = value;
  }
  // mode === 'system' — no credentials to save
}

/**
 * Full interactive flow: change orchestrator model + optionally enter API key.
 */
export async function changeOrchestratorModel(config, rl) {
  const { createProvider } = await import('../providers/index.js');
  const { providerKey, modelId } = await promptProviderSelection(rl);

  const providerDef = PROVIDERS[providerKey];

  // Resolve API key
  const envKey = providerDef.envKey;
  let apiKey = process.env[envKey];
  if (!apiKey) {
    const key = await ask(rl, chalk.cyan(`\n  ${providerDef.name} API key (${envKey}): `));
    if (!key.trim()) {
      console.log(chalk.yellow('\n  No API key provided. Orchestrator not changed.\n'));
      return config;
    }
    apiKey = key.trim();
  }

  // Validate the new provider before saving anything
  console.log(chalk.dim(`\n  Verifying ${providerDef.name} / ${modelId}...`));
  const testConfig = {
    brain: {
      provider: providerKey,
      model: modelId,
      max_tokens: config.orchestrator.max_tokens,
      temperature: config.orchestrator.temperature,
      api_key: apiKey,
    },
  };
  try {
    const testProvider = createProvider(testConfig);
    await testProvider.ping();
  } catch (err) {
    console.log(chalk.red(`\n  ✖ Verification failed: ${err.message}`));
    console.log(chalk.yellow(`  Orchestrator not changed. Keeping current model.\n`));
    return config;
  }

  // Validation passed — save everything
  const savedPath = saveOrchestratorToYaml(providerKey, modelId);
  console.log(chalk.dim(`  Saved to ${savedPath}`));

  config.orchestrator.provider = providerKey;
  config.orchestrator.model = modelId;
  config.orchestrator.api_key = apiKey;

  // Save the key if it was newly entered
  if (!process.env[envKey]) {
    saveCredential(config, envKey, apiKey);
    console.log(chalk.dim('  API key saved.\n'));
  }

  console.log(chalk.green(`  ✔ Orchestrator switched to ${providerDef.name} / ${modelId}\n`));
  return config;
}

/**
 * Full interactive flow: change brain model + optionally enter API key.
 */
export async function changeBrainModel(config, rl) {
  const { createProvider } = await import('../providers/index.js');
  const { providerKey, modelId } = await promptProviderSelection(rl);

  const providerDef = PROVIDERS[providerKey];

  // Resolve API key
  const envKey = providerDef.envKey;
  let apiKey = process.env[envKey];
  if (!apiKey) {
    const key = await ask(rl, chalk.cyan(`\n  ${providerDef.name} API key (${envKey}): `));
    if (!key.trim()) {
      console.log(chalk.yellow('\n  No API key provided. Brain not changed.\n'));
      return config;
    }
    apiKey = key.trim();
  }

  // Validate the new provider before saving anything
  console.log(chalk.dim(`\n  Verifying ${providerDef.name} / ${modelId}...`));
  const testConfig = { ...config, brain: { ...config.brain, provider: providerKey, model: modelId, api_key: apiKey } };
  try {
    const testProvider = createProvider(testConfig);
    await testProvider.ping();
  } catch (err) {
    console.log(chalk.red(`\n  ✖ Verification failed: ${err.message}`));
    console.log(chalk.yellow(`  Brain not changed. Keeping current model.\n`));
    return config;
  }

  // Validation passed — save everything
  const savedPath = saveProviderToYaml(providerKey, modelId);
  console.log(chalk.dim(`  Saved to ${savedPath}`));

  config.brain.provider = providerKey;
  config.brain.model = modelId;
  config.brain.api_key = apiKey;

  // Save the key if it was newly entered
  if (!process.env[envKey]) {
    saveCredential(config, envKey, apiKey);
    console.log(chalk.dim('  API key saved.\n'));
  }

  console.log(chalk.green(`  ✔ Brain switched to ${providerDef.name} / ${modelId}\n`));
  return config;
}

async function promptForMissing(config) {
  const missing = [];
  if (!config.brain.api_key) missing.push('brain_api_key');
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

  if (!mutableConfig.brain.api_key) {
    // Run brain provider selection flow
    console.log(chalk.bold('\n  🧠 Worker Brain'));
    const { providerKey, modelId } = await promptProviderSelection(rl);
    mutableConfig.brain.provider = providerKey;
    mutableConfig.brain.model = modelId;
    saveProviderToYaml(providerKey, modelId);

    const providerDef = PROVIDERS[providerKey];
    const envKey = providerDef.envKey;

    const key = await ask(rl, chalk.cyan(`\n  ${providerDef.name} API key: `));
    mutableConfig.brain.api_key = key.trim();
    envLines.push(`${envKey}=${key.trim()}`);

    // Orchestrator provider selection
    console.log(chalk.bold('\n  🎛️  Orchestrator'));
    const sameChoice = await ask(rl, chalk.cyan(`  Use same provider (${providerDef.name} / ${modelId}) for orchestrator? [Y/n]: `));
    if (!sameChoice.trim() || sameChoice.trim().toLowerCase() === 'y') {
      mutableConfig.orchestrator.provider = providerKey;
      mutableConfig.orchestrator.model = modelId;
      mutableConfig.orchestrator.api_key = key.trim();
      saveOrchestratorToYaml(providerKey, modelId);
    } else {
      const orch = await promptProviderSelection(rl);
      mutableConfig.orchestrator.provider = orch.providerKey;
      mutableConfig.orchestrator.model = orch.modelId;
      saveOrchestratorToYaml(orch.providerKey, orch.modelId);

      const orchProviderDef = PROVIDERS[orch.providerKey];
      if (orch.providerKey === providerKey) {
        // Same provider — reuse the API key
        mutableConfig.orchestrator.api_key = key.trim();
      } else {
        // Different provider — need a separate key
        const orchEnvKey = orchProviderDef.envKey;
        const orchExisting = process.env[orchEnvKey];
        if (orchExisting) {
          mutableConfig.orchestrator.api_key = orchExisting;
        } else {
          const orchKey = await ask(rl, chalk.cyan(`\n  ${orchProviderDef.name} API key: `));
          mutableConfig.orchestrator.api_key = orchKey.trim();
          envLines.push(`${orchEnvKey}=${orchKey.trim()}`);
        }
      }
    }
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

  // Backward compat: migrate anthropic → brain
  migrateAnthropicConfig(fileConfig);

  const config = deepMerge(DEFAULTS, fileConfig);

  // Brain — resolve API key from env based on configured provider
  const providerDef = PROVIDERS[config.brain.provider];
  if (providerDef && process.env[providerDef.envKey]) {
    config.brain.api_key = process.env[providerDef.envKey];
  }

  // Orchestrator — resolve API key based on configured provider
  const orchProvider = PROVIDERS[config.orchestrator.provider];
  if (orchProvider && process.env[orchProvider.envKey]) {
    config.orchestrator.api_key = process.env[orchProvider.envKey];
  }
  // If orchestrator uses the same provider as brain, share the key
  if (!config.orchestrator.api_key && config.orchestrator.provider === config.brain.provider && config.brain.api_key) {
    config.orchestrator.api_key = config.brain.api_key;
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram.bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  // Merge OWNER_TELEGRAM_ID into allowed_users if set
  if (process.env.OWNER_TELEGRAM_ID) {
    const ownerId = Number(process.env.OWNER_TELEGRAM_ID);
    if (!config.telegram.allowed_users.includes(ownerId)) {
      config.telegram.allowed_users.push(ownerId);
    }
  }
  if (process.env.GITHUB_TOKEN) {
    if (!config.github) config.github = {};
    config.github.token = process.env.GITHUB_TOKEN;
  }
  // ElevenLabs voice credentials
  if (process.env.ELEVENLABS_API_KEY) {
    if (!config.elevenlabs) config.elevenlabs = {};
    config.elevenlabs.api_key = process.env.ELEVENLABS_API_KEY;
  }
  if (process.env.ELEVENLABS_VOICE_ID) {
    if (!config.elevenlabs) config.elevenlabs = {};
    config.elevenlabs.voice_id = process.env.ELEVENLABS_VOICE_ID;
  }

  if (process.env.JIRA_BASE_URL || process.env.JIRA_EMAIL || process.env.JIRA_API_TOKEN) {
    if (!config.jira) config.jira = {};
    if (process.env.JIRA_BASE_URL) config.jira.base_url = process.env.JIRA_BASE_URL;
    if (process.env.JIRA_EMAIL) config.jira.email = process.env.JIRA_EMAIL;
    if (process.env.JIRA_API_TOKEN) config.jira.api_token = process.env.JIRA_API_TOKEN;
  }

  // Claude Code auth credentials from env
  if (process.env.CLAUDE_CODE_API_KEY) {
    config.claude_code.api_key = process.env.CLAUDE_CODE_API_KEY;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    config.claude_code.oauth_token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
      if (config.brain.provider === 'anthropic') config.brain.api_key = value;
      break;
    case 'OPENAI_API_KEY':
      if (config.brain.provider === 'openai') config.brain.api_key = value;
      break;
    case 'GOOGLE_API_KEY':
      if (config.brain.provider === 'google') config.brain.api_key = value;
      break;
    case 'GROQ_API_KEY':
      if (config.brain.provider === 'groq') config.brain.api_key = value;
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
