#!/usr/bin/env node

// Suppress punycode deprecation warning from transitive deps
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });

import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { loadConfig, loadConfigInteractive, changeBrainModel } from '../src/utils/config.js';
import { createLogger, getLogger } from '../src/utils/logger.js';
import {
  showLogo,
  showStartupCheck,
  showStartupComplete,
  showError,
} from '../src/utils/display.js';
import { createAuditLogger } from '../src/security/audit.js';
import { ConversationManager } from '../src/conversation.js';
import { UserPersonaManager } from '../src/persona.js';
import { Agent } from '../src/agent.js';
import { JobManager } from '../src/swarm/job-manager.js';
import { startBot } from '../src/bot.js';
import { AutomationManager } from '../src/automation/index.js';
import { createProvider, PROVIDERS } from '../src/providers/index.js';
import {
  loadCustomSkills,
  getCustomSkills,
  addCustomSkill,
  deleteCustomSkill,
} from '../src/skills/custom.js';

function showMenu(config) {
  const providerDef = PROVIDERS[config.brain.provider];
  const providerName = providerDef ? providerDef.name : config.brain.provider;
  const modelId = config.brain.model;

  console.log('');
  console.log(chalk.dim(`  Current brain: ${providerName} / ${modelId}`));
  console.log('');
  console.log(chalk.bold('  What would you like to do?\n'));
  console.log(`  ${chalk.cyan('1.')} Start bot`);
  console.log(`  ${chalk.cyan('2.')} Check connections`);
  console.log(`  ${chalk.cyan('3.')} View logs`);
  console.log(`  ${chalk.cyan('4.')} View audit logs`);
  console.log(`  ${chalk.cyan('5.')} Change brain model`);
  console.log(`  ${chalk.cyan('6.')} Manage custom skills`);
  console.log(`  ${chalk.cyan('7.')} Manage automations`);
  console.log(`  ${chalk.cyan('8.')} Exit`);
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
  const providerDef = PROVIDERS[config.brain.provider];
  const providerLabel = providerDef ? providerDef.name : config.brain.provider;
  const envKeyLabel = providerDef ? providerDef.envKey : 'API_KEY';

  await showStartupCheck(envKeyLabel, async () => {
    if (!config.brain.api_key) throw new Error('Not set');
  });

  await showStartupCheck('TELEGRAM_BOT_TOKEN', async () => {
    if (!config.telegram.bot_token) throw new Error('Not set');
  });

  await showStartupCheck(`${providerLabel} API connection`, async () => {
    const provider = createProvider(config);
    await provider.ping();
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

  const providerDef = PROVIDERS[config.brain.provider];
  const providerLabel = providerDef ? providerDef.name : config.brain.provider;

  const checks = [];

  // Orchestrator always needs Anthropic API key
  checks.push(
    await showStartupCheck('Orchestrator (Anthropic) API', async () => {
      const orchestratorKey = config.orchestrator.api_key || process.env.ANTHROPIC_API_KEY;
      if (!orchestratorKey) throw new Error('ANTHROPIC_API_KEY is required for the orchestrator');
      const provider = createProvider({
        brain: {
          provider: 'anthropic',
          model: config.orchestrator.model,
          max_tokens: config.orchestrator.max_tokens,
          temperature: config.orchestrator.temperature,
          api_key: orchestratorKey,
        },
      });
      await provider.ping();
    }),
  );

  // Worker brain check
  checks.push(
    await showStartupCheck(`Worker (${providerLabel}) API`, async () => {
      const provider = createProvider(config);
      await provider.ping();
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
  const personaManager = new UserPersonaManager();
  const jobManager = new JobManager({
    jobTimeoutSeconds: config.swarm.job_timeout_seconds,
    cleanupIntervalMinutes: config.swarm.cleanup_interval_minutes,
  });

  const automationManager = new AutomationManager();

  const agent = new Agent({ config, conversationManager, personaManager, jobManager, automationManager });

  startBot(config, agent, conversationManager, jobManager, automationManager);

  // Periodic job cleanup and timeout enforcement
  const cleanupMs = (config.swarm.cleanup_interval_minutes || 30) * 60 * 1000;
  setInterval(() => {
    jobManager.cleanup();
    jobManager.enforceTimeouts();
  }, Math.min(cleanupMs, 60_000)); // enforce timeouts every minute at most

  showStartupComplete();
  return true;
}

async function manageCustomSkills(rl) {
  loadCustomSkills();

  let managing = true;
  while (managing) {
    const customs = getCustomSkills();
    console.log('');
    console.log(chalk.bold('  Custom Skills\n'));
    console.log(`  ${chalk.cyan('1.')} Create new skill`);
    console.log(`  ${chalk.cyan('2.')} List skills (${customs.length})`);
    console.log(`  ${chalk.cyan('3.')} Delete a skill`);
    console.log(`  ${chalk.cyan('4.')} Back`);
    console.log('');

    const choice = await ask(rl, chalk.cyan('  > '));
    switch (choice.trim()) {
      case '1': {
        const name = await ask(rl, chalk.cyan('  Skill name: '));
        if (!name.trim()) {
          console.log(chalk.dim('  Cancelled.\n'));
          break;
        }
        console.log(chalk.dim('  Enter the system prompt (multi-line). Type END on a blank line to finish:\n'));
        const lines = [];
        while (true) {
          const line = await ask(rl, '  ');
          if (line.trim() === 'END') break;
          lines.push(line);
        }
        const prompt = lines.join('\n').trim();
        if (!prompt) {
          console.log(chalk.dim('  Empty prompt — cancelled.\n'));
          break;
        }
        const skill = addCustomSkill({ name: name.trim(), systemPrompt: prompt });
        console.log(chalk.green(`\n  ✅ Created: ${skill.name} (${skill.id})\n`));
        break;
      }
      case '2': {
        const customs = getCustomSkills();
        if (!customs.length) {
          console.log(chalk.dim('\n  No custom skills yet.\n'));
          break;
        }
        console.log('');
        for (const s of customs) {
          const preview = s.systemPrompt.slice(0, 60).replace(/\n/g, ' ');
          console.log(`  🛠️  ${chalk.bold(s.name)} (${s.id})`);
          console.log(chalk.dim(`     ${preview}${s.systemPrompt.length > 60 ? '...' : ''}`));
        }
        console.log('');
        break;
      }
      case '3': {
        const customs = getCustomSkills();
        if (!customs.length) {
          console.log(chalk.dim('\n  No custom skills to delete.\n'));
          break;
        }
        console.log('');
        customs.forEach((s, i) => {
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${s.name} (${s.id})`);
        });
        console.log('');
        const pick = await ask(rl, chalk.cyan('  Delete #: '));
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < customs.length) {
          const deleted = deleteCustomSkill(customs[idx].id);
          if (deleted) console.log(chalk.green(`\n  🗑️  Deleted: ${customs[idx].name}\n`));
          else console.log(chalk.dim('  Not found.\n'));
        } else {
          console.log(chalk.dim('  Cancelled.\n'));
        }
        break;
      }
      case '4':
        managing = false;
        break;
      default:
        console.log(chalk.dim('  Invalid choice.\n'));
    }
  }
}

async function manageAutomations(rl) {
  const manager = new AutomationManager();

  let managing = true;
  while (managing) {
    const autos = manager.listAll();
    console.log('');
    console.log(chalk.bold('  Automations\n'));
    console.log(`  ${chalk.cyan('1.')} List all automations (${autos.length})`);
    console.log(`  ${chalk.cyan('2.')} Delete an automation`);
    console.log(`  ${chalk.cyan('3.')} Back`);
    console.log('');

    const choice = await ask(rl, chalk.cyan('  > '));
    switch (choice.trim()) {
      case '1': {
        if (!autos.length) {
          console.log(chalk.dim('\n  No automations found.\n'));
          break;
        }
        console.log('');
        for (const a of autos) {
          const status = a.enabled ? chalk.green('enabled') : chalk.yellow('paused');
          const next = a.nextRun ? new Date(a.nextRun).toLocaleString() : 'not scheduled';
          console.log(`  ${chalk.bold(a.name)} (${a.id}) — chat ${a.chatId}`);
          console.log(chalk.dim(`     Status: ${status} | Runs: ${a.runCount} | Next: ${next}`));
          console.log(chalk.dim(`     Task: ${a.description.slice(0, 80)}${a.description.length > 80 ? '...' : ''}`));
        }
        console.log('');
        break;
      }
      case '2': {
        if (!autos.length) {
          console.log(chalk.dim('\n  No automations to delete.\n'));
          break;
        }
        console.log('');
        autos.forEach((a, i) => {
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${a.name} (${a.id}) — chat ${a.chatId}`);
        });
        console.log('');
        const pick = await ask(rl, chalk.cyan('  Delete #: '));
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < autos.length) {
          const deleted = manager.delete(autos[idx].id);
          if (deleted) console.log(chalk.green(`\n  🗑️  Deleted: ${autos[idx].name}\n`));
          else console.log(chalk.dim('  Not found.\n'));
        } else {
          console.log(chalk.dim('  Cancelled.\n'));
        }
        break;
      }
      case '3':
        managing = false;
        break;
      default:
        console.log(chalk.dim('  Invalid choice.\n'));
    }
  }
}

async function main() {
  showLogo();

  const config = await loadConfigInteractive();
  createLogger(config);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let running = true;
  while (running) {
    showMenu(config);
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
        await changeBrainModel(config, rl);
        break;
      case '6':
        await manageCustomSkills(rl);
        break;
      case '7':
        await manageAutomations(rl);
        break;
      case '8':
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
