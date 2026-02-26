#!/usr/bin/env node

// Suppress punycode deprecation warning from transitive deps
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { loadConfig, loadConfigInteractive, changeBrainModel, changeOrchestratorModel, saveDashboardToYaml } from '../src/utils/config.js';
import { createLogger, getLogger } from '../src/utils/logger.js';
import {
  showLogo,
  showStartupCheck,
  showStartupComplete,
  showError,
  showCharacterCard,
  showWelcomeScreen,
  handleCancel,
  formatProviderLabel,
} from '../src/utils/display.js';
import { createAuditLogger } from '../src/security/audit.js';
import { CharacterBuilder } from '../src/characters/builder.js';
import { ConversationManager } from '../src/conversation.js';
import { UserPersonaManager } from '../src/persona.js';
import { Agent } from '../src/agent.js';
import { JobManager } from '../src/swarm/job-manager.js';
import { startBot } from '../src/bot.js';
import { AutomationManager } from '../src/automation/index.js';
import { createProvider, PROVIDERS } from '../src/providers/index.js';
import { CodebaseKnowledge } from '../src/life/codebase.js';
import { LifeEngine } from '../src/life/engine.js';
import { CharacterManager } from '../src/character.js';
import {
  loadCustomSkills,
  getCustomSkills,
  addCustomSkill,
  deleteCustomSkill,
} from '../src/skills/custom.js';

/**
 * Register SIGINT/SIGTERM handlers to shut down the bot cleanly.
 */
function setupGracefulShutdown({ bot, lifeEngine, automationManager, jobManager, conversationManager, intervals, dashboardHandle }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const logger = getLogger();
    logger.info(`[Shutdown] ${signal} received — shutting down gracefully...`);

    try { bot.stopPolling(); logger.info('[Shutdown] Telegram polling stopped'); } catch (err) { logger.error(`[Shutdown] Failed to stop polling: ${err.message}`); }
    try { lifeEngine.stop(); logger.info('[Shutdown] Life engine stopped'); } catch (err) { logger.error(`[Shutdown] Failed to stop life engine: ${err.message}`); }
    try { automationManager.shutdown(); logger.info('[Shutdown] Automation timers cancelled'); } catch (err) { logger.error(`[Shutdown] Failed to shutdown automations: ${err.message}`); }

    try {
      const running = [...jobManager.jobs.values()].filter(j => !j.isTerminal);
      for (const job of running) jobManager.cancelJob(job.id);
      if (running.length > 0) logger.info(`[Shutdown] Cancelled ${running.length} running job(s)`);
    } catch (err) { logger.error(`[Shutdown] Failed to cancel jobs: ${err.message}`); }

    try { conversationManager.save(); logger.info('[Shutdown] Conversations saved'); } catch (err) { logger.error(`[Shutdown] Failed to save conversations: ${err.message}`); }
    try { dashboardHandle?.stop(); } catch (err) { logger.error(`[Shutdown] Failed to stop dashboard: ${err.message}`); }

    for (const id of intervals) clearInterval(id);
    logger.info('[Shutdown] Periodic timers cleared');
    logger.info('[Shutdown] Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function viewLog(filename) {
  const paths = [
    join(process.cwd(), filename),
    join(homedir(), '.kernelbot', filename),
  ];

  for (const logPath of paths) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const recent = lines.slice(-30);

      const formatted = recent.map(line => {
        try {
          const entry = JSON.parse(line);
          const time = entry.timestamp || '';
          const level = entry.level || '';
          const msg = entry.message || '';
          const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.dim;
          return `${chalk.dim(time)} ${color(level)} ${msg}`;
        } catch {
          return line;
        }
      }).join('\n');

      p.note(formatted, `Last ${recent.length} entries from ${logPath}`);
      return;
    }
  }
  p.log.info(`No ${filename} found yet.`);
}

async function runCheck(config) {
  const orchProviderKey = config.orchestrator.provider || 'anthropic';
  const orchProviderDef = PROVIDERS[orchProviderKey];
  const orchLabel = orchProviderDef ? orchProviderDef.name : orchProviderKey;
  const orchEnvKey = orchProviderDef ? orchProviderDef.envKey : 'API_KEY';

  await showStartupCheck(`Orchestrator ${orchEnvKey}`, async () => {
    if (!config.orchestrator.api_key) throw new Error('Not set');
  });

  await showStartupCheck(`Orchestrator (${orchLabel}) API connection`, async () => {
    const provider = createProvider({
      brain: {
        provider: orchProviderKey,
        model: config.orchestrator.model,
        max_tokens: config.orchestrator.max_tokens,
        temperature: config.orchestrator.temperature,
        api_key: config.orchestrator.api_key,
      },
    });
    await provider.ping();
  });

  const providerDef = PROVIDERS[config.brain.provider];
  const providerLabel = providerDef ? providerDef.name : config.brain.provider;
  const envKeyLabel = providerDef ? providerDef.envKey : 'API_KEY';

  await showStartupCheck(`Worker ${envKeyLabel}`, async () => {
    if (!config.brain.api_key) throw new Error('Not set');
  });

  await showStartupCheck(`Worker (${providerLabel}) API connection`, async () => {
    const provider = createProvider(config);
    await provider.ping();
  });

  await showStartupCheck('TELEGRAM_BOT_TOKEN', async () => {
    if (!config.telegram.bot_token) throw new Error('Not set');
  });

  await showStartupCheck('Telegram Bot API', async () => {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.bot_token}/getMe`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Invalid token');
  });

  p.log.success('All checks passed.');
}

async function startBotFlow(config) {
  createAuditLogger();
  const logger = getLogger();

  const providerDef = PROVIDERS[config.brain.provider];
  const providerLabel = providerDef ? providerDef.name : config.brain.provider;

  const checks = [];

  const orchProviderKey = config.orchestrator.provider || 'anthropic';
  const orchProviderDef = PROVIDERS[orchProviderKey];
  const orchLabel = orchProviderDef ? orchProviderDef.name : orchProviderKey;
  const orchEnvKey = orchProviderDef?.envKey || 'API_KEY';
  checks.push(
    await showStartupCheck(`Orchestrator (${orchLabel}) API`, async () => {
      const orchestratorKey = config.orchestrator.api_key;
      if (!orchestratorKey) throw new Error(`${orchEnvKey} is required for the orchestrator (${orchLabel})`);
      const provider = createProvider({
        brain: {
          provider: orchProviderKey,
          model: config.orchestrator.model,
          max_tokens: config.orchestrator.max_tokens,
          temperature: config.orchestrator.temperature,
          api_key: orchestratorKey,
        },
      });
      await provider.ping();
    }),
  );

  checks.push(
    await showStartupCheck(`Worker (${providerLabel}) API`, async () => {
      const provider = createProvider(config);
      await provider.ping();
    }),
  );

  checks.push(
    await showStartupCheck('Telegram Bot API', async () => {
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.bot_token}/getMe`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Invalid token');
    }),
  );

  if (checks.some((c) => !c)) {
    showError('Startup failed. Fix the issues above and try again.');
    return false;
  }

  const characterManager = new CharacterManager();
  if (characterManager.needsOnboarding) {
    characterManager.installAllBuiltins();
  }

  const activeCharacterId = characterManager.getActiveCharacterId();
  const charCtx = characterManager.buildContext(activeCharacterId);

  const conversationManager = new ConversationManager(config, charCtx.conversationFilePath);
  const personaManager = new UserPersonaManager();
  const jobManager = new JobManager({
    jobTimeoutSeconds: config.swarm.job_timeout_seconds,
    cleanupIntervalMinutes: config.swarm.cleanup_interval_minutes,
  });

  const automationManager = new AutomationManager();
  const codebaseKnowledge = new CodebaseKnowledge({ config });

  const agent = new Agent({
    config, conversationManager, personaManager,
    selfManager: charCtx.selfManager,
    jobManager, automationManager,
    memoryManager: charCtx.memoryManager,
    shareQueue: charCtx.shareQueue,
    characterManager,
  });

  agent.loadCharacter(activeCharacterId);
  codebaseKnowledge.setAgent(agent);

  const lifeEngine = new LifeEngine({
    config, agent,
    memoryManager: charCtx.memoryManager,
    journalManager: charCtx.journalManager,
    shareQueue: charCtx.shareQueue,
    evolutionTracker: charCtx.evolutionTracker,
    codebaseKnowledge,
    selfManager: charCtx.selfManager,
    basePath: charCtx.lifeBasePath,
    characterId: activeCharacterId,
  });

  const dashboardDeps = {
    config, jobManager, automationManager, lifeEngine, conversationManager, characterManager,
    memoryManager: charCtx.memoryManager,
    journalManager: charCtx.journalManager,
    shareQueue: charCtx.shareQueue,
    evolutionTracker: charCtx.evolutionTracker,
    selfManager: charCtx.selfManager,
  };

  let dashboardHandle = null;
  if (config.dashboard?.enabled) {
    const { startDashboard } = await import('../src/dashboard/server.js');
    dashboardHandle = startDashboard({ port: config.dashboard.port, ...dashboardDeps });
    logger.info(`[Dashboard] Running on http://localhost:${config.dashboard.port}`);
  }

  const bot = startBot(config, agent, conversationManager, jobManager, automationManager, {
    lifeEngine,
    memoryManager: charCtx.memoryManager,
    journalManager: charCtx.journalManager,
    shareQueue: charCtx.shareQueue,
    evolutionTracker: charCtx.evolutionTracker,
    codebaseKnowledge,
    characterManager,
    dashboardHandle,
    dashboardDeps,
  });

  const cleanupMs = (config.swarm.cleanup_interval_minutes || 30) * 60 * 1000;
  const cleanupInterval = setInterval(() => {
    jobManager.cleanup();
    jobManager.enforceTimeouts();
  }, Math.min(cleanupMs, 60_000));

  const retentionDays = config.life?.memory_retention_days || 90;
  const pruneInterval = setInterval(() => {
    charCtx.memoryManager.pruneOld(retentionDays);
    charCtx.shareQueue.prune(7);
  }, 24 * 3600_000);

  showStartupComplete();

  const lifeEnabled = config.life?.enabled !== false;
  if (lifeEnabled) {
    logger.info('[Startup] Life engine enabled — waking up...');
    lifeEngine.wakeUp().then(() => {
      lifeEngine.start();
      logger.info('[Startup] Life engine running');
    }).catch(err => {
      logger.error(`[Startup] Life engine wake-up failed: ${err.message}`);
      lifeEngine.start();
    });

    if (config.life?.self_coding?.enabled) {
      codebaseKnowledge.scanChanged().then(count => {
        if (count > 0) logger.info(`[Startup] Codebase scan: ${count} files indexed`);
      }).catch(err => {
        logger.warn(`[Startup] Codebase scan failed: ${err.message}`);
      });
    }
  } else {
    logger.info('[Startup] Life engine disabled');
  }

  setupGracefulShutdown({
    bot, lifeEngine, automationManager, jobManager,
    conversationManager, intervals: [cleanupInterval, pruneInterval],
    dashboardHandle,
  });

  return true;
}

async function manageCustomSkills() {
  loadCustomSkills();

  let managing = true;
  while (managing) {
    const customs = getCustomSkills();

    const choice = await p.select({
      message: `Custom Skills (${customs.length})`,
      options: [
        { value: 'create', label: 'Create new skill' },
        { value: 'list', label: `List skills`, hint: `${customs.length} total` },
        { value: 'delete', label: 'Delete a skill' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (handleCancel(choice)) return;

    switch (choice) {
      case 'create': {
        const name = await p.text({ message: 'Skill name' });
        if (handleCancel(name) || !name.trim()) break;

        const prompt = await p.text({
          message: 'System prompt',
          placeholder: 'Enter the system prompt for this skill...',
        });
        if (handleCancel(prompt) || !prompt.trim()) break;

        const skill = addCustomSkill({ name: name.trim(), systemPrompt: prompt.trim() });
        p.log.success(`Created: ${skill.name} (${skill.id})`);
        break;
      }
      case 'list': {
        if (!customs.length) {
          p.log.info('No custom skills yet.');
          break;
        }
        const formatted = customs.map(s => {
          const preview = s.systemPrompt.slice(0, 60).replace(/\n/g, ' ');
          return `${chalk.bold(s.name)} (${s.id})\n${chalk.dim(preview + (s.systemPrompt.length > 60 ? '...' : ''))}`;
        }).join('\n\n');
        p.note(formatted, 'Custom Skills');
        break;
      }
      case 'delete': {
        if (!customs.length) {
          p.log.info('No custom skills to delete.');
          break;
        }
        const toDelete = await p.select({
          message: 'Select skill to delete',
          options: [
            ...customs.map(s => ({ value: s.id, label: s.name, hint: s.id })),
            { value: '__back', label: 'Cancel' },
          ],
        });
        if (handleCancel(toDelete) || toDelete === '__back') break;
        const deleted = deleteCustomSkill(toDelete);
        if (deleted) p.log.success(`Deleted: ${customs.find(s => s.id === toDelete)?.name}`);
        break;
      }
      case 'back':
        managing = false;
        break;
    }
  }
}

async function manageAutomations() {
  const manager = new AutomationManager();

  let managing = true;
  while (managing) {
    const autos = manager.listAll();

    const choice = await p.select({
      message: `Automations (${autos.length})`,
      options: [
        { value: 'list', label: 'List all automations', hint: `${autos.length} total` },
        { value: 'delete', label: 'Delete an automation' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (handleCancel(choice)) return;

    switch (choice) {
      case 'list': {
        if (!autos.length) {
          p.log.info('No automations found.');
          break;
        }
        const formatted = autos.map(a => {
          const status = a.enabled ? chalk.green('enabled') : chalk.yellow('paused');
          const next = a.nextRun ? new Date(a.nextRun).toLocaleString() : 'not scheduled';
          return `${chalk.bold(a.name)} (${a.id}) — chat ${a.chatId}\n` +
            chalk.dim(`Status: ${status} | Runs: ${a.runCount} | Next: ${next}\n`) +
            chalk.dim(`Task: ${a.description.slice(0, 80)}${a.description.length > 80 ? '...' : ''}`);
        }).join('\n\n');
        p.note(formatted, 'Automations');
        break;
      }
      case 'delete': {
        if (!autos.length) {
          p.log.info('No automations to delete.');
          break;
        }
        const toDelete = await p.select({
          message: 'Select automation to delete',
          options: [
            ...autos.map(a => ({ value: a.id, label: a.name, hint: `chat ${a.chatId}` })),
            { value: '__back', label: 'Cancel' },
          ],
        });
        if (handleCancel(toDelete) || toDelete === '__back') break;
        const deleted = manager.delete(toDelete);
        if (deleted) p.log.success(`Deleted: ${autos.find(a => a.id === toDelete)?.name}`);
        break;
      }
      case 'back':
        managing = false;
        break;
    }
  }
}

async function manageCharacters(config) {
  const charManager = new CharacterManager();
  charManager.installAllBuiltins();

  let managing = true;
  while (managing) {
    const characters = charManager.listCharacters();
    const activeId = charManager.getActiveCharacterId();
    const active = charManager.getCharacter(activeId);

    const choice = await p.select({
      message: `Characters — Active: ${active?.emoji || ''} ${active?.name || 'None'}`,
      options: [
        { value: 'switch', label: 'Switch character' },
        { value: 'create', label: 'Create custom character' },
        { value: 'view', label: 'View character info' },
        { value: 'delete', label: 'Delete a custom character' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (handleCancel(choice)) return;

    switch (choice) {
      case 'switch': {
        const picked = await p.select({
          message: 'Select character',
          options: characters.map(c => ({
            value: c.id,
            label: `${c.emoji} ${c.name}`,
            hint: c.id === activeId ? 'active' : undefined,
          })),
        });
        if (handleCancel(picked)) break;
        charManager.setActiveCharacter(picked);
        const char = characters.find(c => c.id === picked);
        p.log.success(`${char.emoji} Switched to ${char.name}`);
        break;
      }
      case 'create': {
        p.log.step('Custom Character Builder');

        const orchProviderKey = config.orchestrator.provider || 'anthropic';
        const orchProviderDef = PROVIDERS[orchProviderKey];
        const orchApiKey = config.orchestrator.api_key || (orchProviderDef && process.env[orchProviderDef.envKey]);
        if (!orchApiKey) {
          p.log.error('No API key configured for character generation.');
          break;
        }

        const provider = createProvider({
          brain: {
            provider: orchProviderKey,
            model: config.orchestrator.model,
            max_tokens: config.orchestrator.max_tokens,
            temperature: config.orchestrator.temperature,
            api_key: orchApiKey,
          },
        });

        const builder = new CharacterBuilder(provider);
        const answers = {};
        let cancelled = false;

        let q = builder.getNextQuestion(answers);
        while (q) {
          const progress = builder.getProgress(answers);
          const answer = await p.text({
            message: `(${progress.answered + 1}/${progress.total}) ${q.question}`,
            placeholder: q.examples,
          });
          if (handleCancel(answer)) { cancelled = true; break; }
          answers[q.id] = answer.trim();
          q = builder.getNextQuestion(answers);
        }

        if (cancelled) break;

        const s = p.spinner();
        s.start('Generating character...');
        try {
          const result = await builder.generateCharacter(answers);
          s.stop('Character generated');
          const id = result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          console.log('');
          showCharacterCard({ ...result, id, origin: 'Custom' });
          console.log('');

          const install = await p.confirm({ message: 'Install this character?' });
          if (handleCancel(install) || !install) {
            p.log.info('Discarded.');
            break;
          }

          charManager.addCharacter(
            { id, type: 'custom', name: result.name, origin: 'Custom', age: result.age, emoji: result.emoji, tagline: result.tagline },
            result.personaMd,
            result.selfDefaults,
          );
          p.log.success(`${result.emoji} ${result.name} created!`);
        } catch (err) {
          s.stop(chalk.red(`Character generation failed: ${err.message}`));
        }
        break;
      }
      case 'view': {
        const picked = await p.select({
          message: 'Select character to view',
          options: characters.map(c => ({
            value: c.id,
            label: `${c.emoji} ${c.name}`,
          })),
        });
        if (handleCancel(picked)) break;
        const char = characters.find(c => c.id === picked);
        showCharacterCard(char, char.id === activeId);
        if (char.evolutionHistory?.length > 0) {
          p.log.info(`Evolution events: ${char.evolutionHistory.length}`);
        }
        break;
      }
      case 'delete': {
        const customChars = characters.filter(c => c.type === 'custom');
        if (customChars.length === 0) {
          p.log.info('No custom characters to delete.');
          break;
        }
        const picked = await p.select({
          message: 'Select character to delete',
          options: [
            ...customChars.map(c => ({ value: c.id, label: `${c.emoji} ${c.name}` })),
            { value: '__back', label: 'Cancel' },
          ],
        });
        if (handleCancel(picked) || picked === '__back') break;
        try {
          const char = customChars.find(c => c.id === picked);
          charManager.removeCharacter(picked);
          p.log.success(`Deleted: ${char.name}`);
        } catch (err) {
          p.log.error(err.message);
        }
        break;
      }
      case 'back':
        managing = false;
        break;
    }
  }
}

async function linkLinkedInCli(config) {
  const { saveCredential } = await import('../src/utils/config.js');

  if (config.linkedin?.access_token) {
    const truncated = `${config.linkedin.access_token.slice(0, 8)}...${config.linkedin.access_token.slice(-4)}`;
    p.note(
      `Token: ${truncated}${config.linkedin.person_urn ? `\nURN: ${config.linkedin.person_urn}` : ''}`,
      'LinkedIn — Connected',
    );
    const relink = await p.confirm({ message: 'Re-link account?', initialValue: false });
    if (handleCancel(relink) || !relink) return;
  }

  p.note(
    '1. Go to https://www.linkedin.com/developers/tools/oauth/token-generator\n' +
    '2. Select your app, pick scopes: openid, profile, email, w_member_social\n' +
    '3. Authorize and copy the token',
    'Link LinkedIn Account',
  );

  const token = await p.text({ message: 'Paste access token' });
  if (handleCancel(token) || !token.trim()) return;

  const s = p.spinner();
  s.start('Validating token...');

  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${token.trim()}` },
    });

    if (res.ok) {
      const profile = await res.json();
      const personUrn = `urn:li:person:${profile.sub}`;

      saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token.trim());
      saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

      s.stop('LinkedIn linked');
      p.log.info(`Name: ${profile.name}${profile.email ? ` | Email: ${profile.email}` : ''}\nURN: ${personUrn}`);
    } else if (res.status === 401) {
      throw new Error('Invalid or expired token.');
    } else {
      s.stop('Token accepted (profile scopes missing)');
      p.log.warn(
        'To auto-detect your URN, add "Sign in with LinkedIn using OpenID Connect"\n' +
        'to your app at https://www.linkedin.com/developers/apps',
      );

      const urn = await p.text({
        message: 'Person URN (urn:li:person:XXXXX)',
        placeholder: 'urn:li:person:...',
      });
      if (handleCancel(urn) || !urn.trim()) {
        p.log.warn('No URN provided. Token saved but LinkedIn posts will not work without a URN.');
        saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token.trim());
        return;
      }

      const personUrn = urn.trim().startsWith('urn:li:person:') ? urn.trim() : `urn:li:person:${urn.trim()}`;
      saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token.trim());
      saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

      p.log.success(`LinkedIn linked — URN: ${personUrn}`);
    }
  } catch (err) {
    s.stop(chalk.red(`Token validation failed: ${err.message}`));
  }
}

async function manageDashboard(config) {
  const dashEnabled = config.dashboard?.enabled;
  const dashPort = config.dashboard?.port || 3000;

  p.note(
    `Auto-start: ${dashEnabled ? chalk.green('yes') : chalk.yellow('no')}\n` +
    `Port: ${dashPort}\n` +
    `URL: http://localhost:${dashPort}`,
    'Dashboard',
  );

  const choice = await p.select({
    message: 'Dashboard settings',
    options: [
      { value: 'toggle', label: `${dashEnabled ? 'Disable' : 'Enable'} auto-start on boot` },
      { value: 'port', label: 'Change port', hint: String(dashPort) },
      { value: 'back', label: 'Back' },
    ],
  });
  if (handleCancel(choice) || choice === 'back') return;

  if (choice === 'toggle') {
    const newEnabled = !dashEnabled;
    saveDashboardToYaml({ enabled: newEnabled });
    config.dashboard.enabled = newEnabled;
    p.log.success(`Dashboard auto-start ${newEnabled ? 'enabled' : 'disabled'}`);
    if (newEnabled) {
      p.log.info(`Dashboard will start at http://localhost:${dashPort} on next bot launch.`);
    }
  } else if (choice === 'port') {
    const portInput = await p.text({
      message: 'New port',
      placeholder: String(dashPort),
      validate: (v) => {
        const n = parseInt(v.trim(), 10);
        if (!n || n < 1 || n > 65535) return 'Enter a valid port (1-65535)';
      },
    });
    if (handleCancel(portInput)) return;
    const newPort = parseInt(portInput.trim(), 10);
    saveDashboardToYaml({ port: newPort });
    config.dashboard.port = newPort;
    p.log.success(`Dashboard port set to ${newPort}`);
  }
}

async function main() {
  showLogo();

  const config = await loadConfigInteractive();
  createLogger(config);

  // Show welcome screen with system info
  const characterManager = new CharacterManager();
  characterManager.installAllBuiltins();
  showWelcomeScreen(config, characterManager);

  let running = true;
  while (running) {
    const brainHint = formatProviderLabel(config, 'brain');
    const orchHint = formatProviderLabel(config, 'orchestrator');

    const choice = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'start', label: 'Start bot' },
        { value: 'check', label: 'Check connections' },
        { value: 'logs', label: 'View logs' },
        { value: 'audit', label: 'View audit logs' },
        { value: 'brain', label: 'Change brain model', hint: brainHint },
        { value: 'orch', label: 'Change orchestrator model', hint: orchHint },
        { value: 'skills', label: 'Manage custom skills' },
        { value: 'automations', label: 'Manage automations' },
        { value: 'characters', label: 'Switch character' },
        { value: 'linkedin', label: 'Link LinkedIn account' },
        { value: 'dashboard', label: 'Dashboard settings' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (handleCancel(choice)) {
      running = false;
      break;
    }

    switch (choice) {
      case 'start': {
        const started = await startBotFlow(config);
        if (!started) process.exit(1);
        return;
      }
      case 'check':
        await runCheck(config);
        break;
      case 'logs':
        viewLog('kernel.log');
        break;
      case 'audit':
        viewLog('kernel-audit.log');
        break;
      case 'brain':
        await changeBrainModel(config);
        break;
      case 'orch':
        await changeOrchestratorModel(config);
        break;
      case 'skills':
        await manageCustomSkills();
        break;
      case 'automations':
        await manageAutomations();
        break;
      case 'characters':
        await manageCharacters(config);
        break;
      case 'linkedin':
        await linkLinkedInCli(config);
        break;
      case 'dashboard':
        await manageDashboard(config);
        break;
      case 'exit':
        running = false;
        break;
    }
  }

  p.outro('Goodbye.');
}

main().catch((err) => {
  showError(err.message);
  process.exit(1);
});
