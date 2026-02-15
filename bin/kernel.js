#!/usr/bin/env node

// Suppress punycode deprecation warning from transitive deps
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });

import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { loadConfig, loadConfigInteractive } from '../src/utils/config.js';
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

function showMenu() {
  console.log('');
  console.log(chalk.bold('  What would you like to do?\n'));
  console.log(`  ${chalk.cyan('1.')} Start bot`);
  console.log(`  ${chalk.cyan('2.')} Check connections`);
  console.log(`  ${chalk.cyan('3.')} View logs`);
  console.log(`  ${chalk.cyan('4.')} View audit logs`);
  console.log(`  ${chalk.cyan('5.')} Exit`);
  console.log('');
}

function ask(rl, question) {
  return new Promise((res) => rl.question(question, res));
}

function viewLog(filename) {
  const paths = [
    join(process.cwd(), filename),
    join(homedir(), '.kernelbot', filename),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const recent = lines.slice(-30);
      console.log(chalk.dim(`\n  Showing last ${recent.length} entries from ${p}\n`));
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          const time = entry.timestamp || '';
          const level = entry.level || '';
          const msg = entry.message || '';
          const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.dim;
          console.log(`  ${chalk.dim(time)} ${color(level)} ${msg}`);
        } catch {
          console.log(`  ${line}`);
        }
      }
      console.log('');
      return;
    }
  }
  console.log(chalk.dim(`\n  No ${filename} found yet.\n`));
}

async function runCheck(config) {
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

  console.log(chalk.green('\n  All checks passed.\n'));
}

async function startBotFlow(config) {
  createAuditLogger();
  const logger = getLogger();

  const checks = [];

  checks.push(
    await showStartupCheck('Anthropic API', async () => {
      const client = new Anthropic({ apiKey: config.anthropic.api_key });
      await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
    }),
  );

  checks.push(
    await showStartupCheck('Telegram Bot API', async () => {
      const res = await fetch(
        `https://api.telegram.org/bot${config.telegram.bot_token}/getMe`,
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Invalid token');
    }),
  );

  if (checks.some((c) => !c)) {
    showError('Startup failed. Fix the issues above and try again.');
    return false;
  }

  const conversationManager = new ConversationManager(config);
  const agent = new Agent({ config, conversationManager });

  startBot(config, agent, conversationManager);
  showStartupComplete();
  return true;
}

async function main() {
  showLogo();

  const config = await loadConfigInteractive();
  createLogger(config);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let running = true;
  while (running) {
    showMenu();
    const choice = await ask(rl, chalk.cyan('  > '));

    switch (choice.trim()) {
      case '1': {
        rl.close();
        const started = await startBotFlow(config);
        if (!started) process.exit(1);
        return; // bot is running, don't show menu again
      }
      case '2':
        await runCheck(config);
        break;
      case '3':
        viewLog('kernel.log');
        break;
      case '4':
        viewLog('kernel-audit.log');
        break;
      case '5':
        running = false;
        break;
      default:
        console.log(chalk.dim('  Invalid choice.\n'));
    }
  }

  rl.close();
  console.log(chalk.dim('  Goodbye.\n'));
}

main().catch((err) => {
  showError(err.message);
  process.exit(1);
});
