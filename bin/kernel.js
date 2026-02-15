#!/usr/bin/env node

// Suppress punycode deprecation warning from transitive deps
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });

import { Command } from 'commander';
import { createInterface } from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { loadConfig } from '../src/utils/config.js';
import { createLogger, getLogger } from '../src/utils/logger.js';
import {
  showLogo,
  showStartupCheck,
  showStartupComplete,
  showError,
} from '../src/utils/display.js';
import { createAuditLogger } from '../src/security/audit.js';
import { ConversationManager } from '../src/conversation.js';
import { Agent } from '../src/agent.js';
import { startBot } from '../src/bot.js';
import Anthropic from '@anthropic-ai/sdk';

const program = new Command();

program
  .name('kernelbot')
  .description('KernelBot — AI engineering agent with full OS control')
  .version('1.0.0');

// ─── kernel start ────────────────────────────────────────────
program
  .command('start')
  .description('Start KernelBot Telegram bot')
  .action(async () => {
    showLogo();

    const config = loadConfig();
    createLogger(config);
    createAuditLogger();
    const logger = getLogger();

    // Startup checks
    const checks = [];

    checks.push(
      await showStartupCheck('Configuration loaded', async () => {
        if (!config.anthropic.api_key) throw new Error('ANTHROPIC_API_KEY not set');
        if (!config.telegram.bot_token) throw new Error('TELEGRAM_BOT_TOKEN not set');
      }),
    );

    checks.push(
      await showStartupCheck('Anthropic API connection', async () => {
        const client = new Anthropic({ apiKey: config.anthropic.api_key });
        await client.messages.create({
          model: config.anthropic.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        });
      }),
    );

    if (checks.some((c) => !c)) {
      showError('Startup checks failed. Fix the issues above and try again.');
      process.exit(1);
    }

    const conversationManager = new ConversationManager(config);
    const agent = new Agent({ config, conversationManager });

    startBot(config, agent);
    showStartupComplete();
  });

// ─── kernel run ──────────────────────────────────────────────
program
  .command('run')
  .description('Run a one-off prompt through the agent (no Telegram)')
  .argument('<prompt>', 'The prompt to send')
  .action(async (prompt) => {
    const config = loadConfig();
    createLogger(config);
    createAuditLogger();

    if (!config.anthropic.api_key) {
      showError('ANTHROPIC_API_KEY not set. Run `kernelbot init` first.');
      process.exit(1);
    }

    const conversationManager = new ConversationManager(config);
    const agent = new Agent({ config, conversationManager });

    const reply = await agent.processMessage('cli', prompt, {
      id: 'cli',
      username: 'cli',
    });

    console.log('\n' + reply);
  });

// ─── kernel check ────────────────────────────────────────────
program
  .command('check')
  .description('Validate configuration and test API connections')
  .action(async () => {
    showLogo();

    const config = loadConfig();
    createLogger(config);

    await showStartupCheck('Configuration file', async () => {
      // loadConfig already succeeded if we got here
    });

    await showStartupCheck('ANTHROPIC_API_KEY', async () => {
      if (!config.anthropic.api_key) throw new Error('Not set');
    });

    await showStartupCheck('TELEGRAM_BOT_TOKEN', async () => {
      if (!config.telegram.bot_token) throw new Error('Not set');
    });

    await showStartupCheck('Anthropic API connection', async () => {
      const client = new Anthropic({ apiKey: config.anthropic.api_key });
      await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
    });

    await showStartupCheck('Telegram Bot API', async () => {
      const res = await fetch(
        `https://api.telegram.org/bot${config.telegram.bot_token}/getMe`,
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Invalid token');
    });

    console.log('\nAll checks complete.');
  });

// ─── kernel init ─────────────────────────────────────────────
program
  .command('init')
  .description('Interactive setup: create .env and config.yaml')
  .action(async () => {
    showLogo();

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));

    const apiKey = await ask('Anthropic API key: ');
    const botToken = await ask('Telegram Bot Token: ');
    const userId = await ask('Your Telegram User ID (leave blank for dev mode): ');

    rl.close();

    // Write .env
    const envContent = `ANTHROPIC_API_KEY=${apiKey}\nTELEGRAM_BOT_TOKEN=${botToken}\n`;
    writeFileSync('.env', envContent);

    // Write config.yaml
    const allowedUsers =
      userId.trim() ? `\n  allowed_users:\n    - ${userId.trim()}` : '\n  allowed_users: []';

    const configContent = `bot:
  name: KernelBot

anthropic:
  model: claude-sonnet-4-20250514
  max_tokens: 8192
  temperature: 0.3
  max_tool_depth: 25

telegram:${allowedUsers}

security:
  blocked_paths:
    - /etc/shadow
    - /etc/passwd

logging:
  level: info
  max_file_size: 5242880

conversation:
  max_history: 50
`;
    writeFileSync('config.yaml', configContent);

    console.log('\nCreated .env and config.yaml');
    console.log('Run `kernelbot check` to verify, then `kernelbot start` to launch.');
  });

program.parse();
