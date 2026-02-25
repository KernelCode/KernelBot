#!/usr/bin/env node

// Suppress punycode deprecation warning from transitive deps
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });

import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { loadConfig, loadConfigInteractive, changeBrainModel, changeOrchestratorModel, saveDashboardToYaml } from '../src/utils/config.js';
import { createLogger, getLogger } from '../src/utils/logger.js';
import {
  showLogo,
  showStartupCheck,
  showStartupComplete,
  showError,
  showCharacterGallery,
  showCharacterCard,
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

function showMenu(config) {
  const orchProviderDef = PROVIDERS[config.orchestrator.provider];
  const orchProviderName = orchProviderDef ? orchProviderDef.name : config.orchestrator.provider;
  const orchModelId = config.orchestrator.model;

  const providerDef = PROVIDERS[config.brain.provider];
  const providerName = providerDef ? providerDef.name : config.brain.provider;
  const modelId = config.brain.model;

  console.log('');
  console.log(chalk.dim(`  Current orchestrator: ${orchProviderName} / ${orchModelId}`));
  console.log(chalk.dim(`  Current brain: ${providerName} / ${modelId}`));
  console.log('');
  console.log(chalk.bold('  What would you like to do?\n'));
  console.log(`  ${chalk.cyan('1.')} Start bot`);
  console.log(`  ${chalk.cyan('2.')} Check connections`);
  console.log(`  ${chalk.cyan('3.')} View logs`);
  console.log(`  ${chalk.cyan('4.')} View audit logs`);
  console.log(`  ${chalk.cyan('5.')} Change brain model`);
  console.log(`  ${chalk.cyan('6.')} Change orchestrator model`);
  console.log(`  ${chalk.cyan('7.')} Manage custom skills`);
  console.log(`  ${chalk.cyan('8.')} Manage automations`);
  console.log(`  ${chalk.cyan('9.')} Switch character`);
  console.log(`  ${chalk.cyan('10.')} Link LinkedIn account`);
  console.log(`  ${chalk.cyan('11.')} Dashboard`);
  console.log(`  ${chalk.cyan('12.')} Exit`);
  console.log('');
}

function ask(rl, question) {
  return new Promise((res) => rl.question(question, res));
}

/**
 * Register SIGINT/SIGTERM handlers to shut down the bot cleanly.
 * Stops polling, cancels running jobs, persists conversations,
 * disarms automations, stops the life engine, and clears intervals.
 */
function setupGracefulShutdown({ bot, lifeEngine, automationManager, jobManager, conversationManager, intervals, dashboardHandle }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return; // prevent double-shutdown
    shuttingDown = true;

    const logger = getLogger();
    logger.info(`[Shutdown] ${signal} received — shutting down gracefully...`);

    // 1. Stop Telegram polling so no new messages arrive
    try {
      bot.stopPolling();
      logger.info('[Shutdown] Telegram polling stopped');
    } catch (err) {
      logger.error(`[Shutdown] Failed to stop polling: ${err.message}`);
    }

    // 2. Stop life engine heartbeat
    try {
      lifeEngine.stop();
      logger.info('[Shutdown] Life engine stopped');
    } catch (err) {
      logger.error(`[Shutdown] Failed to stop life engine: ${err.message}`);
    }

    // 3. Disarm all automation timers
    try {
      automationManager.shutdown();
      logger.info('[Shutdown] Automation timers cancelled');
    } catch (err) {
      logger.error(`[Shutdown] Failed to shutdown automations: ${err.message}`);
    }

    // 4. Cancel all running jobs
    try {
      const running = [...jobManager.jobs.values()].filter(j => !j.isTerminal);
      for (const job of running) {
        jobManager.cancelJob(job.id);
      }
      if (running.length > 0) {
        logger.info(`[Shutdown] Cancelled ${running.length} running job(s)`);
      }
    } catch (err) {
      logger.error(`[Shutdown] Failed to cancel jobs: ${err.message}`);
    }

    // 5. Persist conversations to disk
    try {
      conversationManager.save();
      logger.info('[Shutdown] Conversations saved');
    } catch (err) {
      logger.error(`[Shutdown] Failed to save conversations: ${err.message}`);
    }

    // 6. Stop dashboard
    try {
      dashboardHandle?.stop();
    } catch (err) {
      logger.error(`[Shutdown] Failed to stop dashboard: ${err.message}`);
    }

    // 7. Clear periodic intervals
    for (const id of intervals) {
      clearInterval(id);
    }
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
  // Orchestrator check
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

  // Worker brain check
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

  // Orchestrator check — dynamic provider
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

  // Character system — manages multiple personas with isolated data
  const characterManager = new CharacterManager();

  // Install built-in characters if needed (fresh install or missing builtins).
  // Onboarding flag stays true until user picks a character via Telegram.
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

  // Life system managers — scoped to active character
  const codebaseKnowledge = new CodebaseKnowledge({ config });

  const agent = new Agent({
    config, conversationManager, personaManager,
    selfManager: charCtx.selfManager,
    jobManager, automationManager,
    memoryManager: charCtx.memoryManager,
    shareQueue: charCtx.shareQueue,
    characterManager,
  });

  // Load character context into agent (sets persona, name, etc.)
  agent.loadCharacter(activeCharacterId);

  // Wire codebase knowledge to agent for LLM-powered scanning
  codebaseKnowledge.setAgent(agent);

  // Life Engine — autonomous inner life (scoped to active character)
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

  // Periodic job cleanup and timeout enforcement
  const cleanupMs = (config.swarm.cleanup_interval_minutes || 30) * 60 * 1000;
  const cleanupInterval = setInterval(() => {
    jobManager.cleanup();
    jobManager.enforceTimeouts();
  }, Math.min(cleanupMs, 60_000)); // enforce timeouts every minute at most

  // Periodic memory pruning (daily)
  const retentionDays = config.life?.memory_retention_days || 90;
  const pruneInterval = setInterval(() => {
    charCtx.memoryManager.pruneOld(retentionDays);
    charCtx.shareQueue.prune(7);
  }, 24 * 3600_000);

  showStartupComplete();

  // Optional cyberpunk terminal dashboard
  let dashboardHandle = null;
  if (config.dashboard?.enabled) {
    const { startDashboard } = await import('../src/dashboard/server.js');
    dashboardHandle = startDashboard({
      port: config.dashboard.port,
      config, jobManager, automationManager, lifeEngine, conversationManager, characterManager,
      memoryManager: charCtx.memoryManager,
      journalManager: charCtx.journalManager,
      shareQueue: charCtx.shareQueue,
      evolutionTracker: charCtx.evolutionTracker,
      selfManager: charCtx.selfManager,
    });
    logger.info(`[Dashboard] Running on http://localhost:${config.dashboard.port}`);
  }

  // Start life engine if enabled
  const lifeEnabled = config.life?.enabled !== false;
  if (lifeEnabled) {
    logger.info('[Startup] Life engine enabled — waking up...');
    lifeEngine.wakeUp().then(() => {
      lifeEngine.start();
      logger.info('[Startup] Life engine running');
    }).catch(err => {
      logger.error(`[Startup] Life engine wake-up failed: ${err.message}`);
      lifeEngine.start(); // still start heartbeat even if wake-up fails
    });

    // Initial codebase scan (background, non-blocking)
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

  // Register graceful shutdown handlers
  setupGracefulShutdown({
    bot, lifeEngine, automationManager, jobManager,
    conversationManager, intervals: [cleanupInterval, pruneInterval],
    dashboardHandle,
  });

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

async function manageCharacters(rl, config) {
  const charManager = new CharacterManager();

  // Ensure builtins installed
  charManager.installAllBuiltins();

  let managing = true;
  while (managing) {
    const characters = charManager.listCharacters();
    const activeId = charManager.getActiveCharacterId();
    const active = charManager.getCharacter(activeId);

    console.log('');
    console.log(chalk.bold('  Character Management'));
    console.log(chalk.dim(`  Active: ${active?.emoji || ''} ${active?.name || 'None'}`));
    console.log('');
    console.log(`  ${chalk.cyan('1.')} Switch character`);
    console.log(`  ${chalk.cyan('2.')} Create custom character`);
    console.log(`  ${chalk.cyan('3.')} View character info`);
    console.log(`  ${chalk.cyan('4.')} Delete a custom character`);
    console.log(`  ${chalk.cyan('5.')} Back`);
    console.log('');

    const choice = await ask(rl, chalk.cyan('  > '));
    switch (choice.trim()) {
      case '1': {
        showCharacterGallery(characters, activeId);
        console.log('');
        characters.forEach((c, i) => {
          const marker = c.id === activeId ? chalk.green(' ✓') : '';
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${c.emoji} ${c.name}${marker}`);
        });
        console.log('');
        const pick = await ask(rl, chalk.cyan('  Select #: '));
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < characters.length) {
          charManager.setActiveCharacter(characters[idx].id);
          console.log(chalk.green(`\n  ${characters[idx].emoji} Switched to ${characters[idx].name}\n`));
        } else {
          console.log(chalk.dim('  Cancelled.\n'));
        }
        break;
      }
      case '2': {
        // Create custom character via Q&A
        console.log('');
        console.log(chalk.bold('  Custom Character Builder'));
        console.log(chalk.dim('  Answer a few questions to create your character.\n'));

        // Need an LLM provider for generation
        const orchProviderKey = config.orchestrator.provider || 'anthropic';
        const orchProviderDef = PROVIDERS[orchProviderKey];
        const orchApiKey = config.orchestrator.api_key || (orchProviderDef && process.env[orchProviderDef.envKey]);
        if (!orchApiKey) {
          console.log(chalk.red('  No API key configured for character generation.\n'));
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

        // Walk through all questions
        let q = builder.getNextQuestion(answers);
        while (q) {
          const progress = builder.getProgress(answers);
          console.log(chalk.bold(`  Question ${progress.answered + 1}/${progress.total}`));
          console.log(`  ${q.question}`);
          console.log(chalk.dim(`  Examples: ${q.examples}`));
          const answer = await ask(rl, chalk.cyan('  > '));
          if (answer.trim().toLowerCase() === 'cancel') {
            cancelled = true;
            break;
          }
          answers[q.id] = answer.trim();
          q = builder.getNextQuestion(answers);
          console.log('');
        }

        if (cancelled) {
          console.log(chalk.dim('  Character creation cancelled.\n'));
          break;
        }

        console.log(chalk.dim('  Generating character...'));
        try {
          const result = await builder.generateCharacter(answers);
          const id = result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          // Show preview
          console.log('');
          showCharacterCard({
            ...result,
            id,
            origin: 'Custom',
          });
          console.log('');

          const confirm = await ask(rl, chalk.cyan('  Install this character? (y/n): '));
          if (confirm.trim().toLowerCase() === 'y') {
            charManager.addCharacter(
              { id, type: 'custom', name: result.name, origin: 'Custom', age: result.age, emoji: result.emoji, tagline: result.tagline },
              result.personaMd,
              result.selfDefaults,
            );
            console.log(chalk.green(`\n  ${result.emoji} ${result.name} created!\n`));
          } else {
            console.log(chalk.dim('  Discarded.\n'));
          }
        } catch (err) {
          console.log(chalk.red(`\n  Character generation failed: ${err.message}\n`));
        }
        break;
      }
      case '3': {
        console.log('');
        characters.forEach((c, i) => {
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${c.emoji} ${c.name}`);
        });
        console.log('');
        const pick = await ask(rl, chalk.cyan('  View #: '));
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < characters.length) {
          showCharacterCard(characters[idx], characters[idx].id === activeId);
          if (characters[idx].evolutionHistory?.length > 0) {
            console.log(chalk.dim(`  Evolution events: ${characters[idx].evolutionHistory.length}`));
          }
          console.log('');
        } else {
          console.log(chalk.dim('  Cancelled.\n'));
        }
        break;
      }
      case '4': {
        const customChars = characters.filter(c => c.type === 'custom');
        if (customChars.length === 0) {
          console.log(chalk.dim('\n  No custom characters to delete.\n'));
          break;
        }
        console.log('');
        customChars.forEach((c, i) => {
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${c.emoji} ${c.name}`);
        });
        console.log('');
        const pick = await ask(rl, chalk.cyan('  Delete #: '));
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < customChars.length) {
          try {
            charManager.removeCharacter(customChars[idx].id);
            console.log(chalk.green(`\n  Deleted: ${customChars[idx].name}\n`));
          } catch (err) {
            console.log(chalk.red(`\n  ${err.message}\n`));
          }
        } else {
          console.log(chalk.dim('  Cancelled.\n'));
        }
        break;
      }
      case '5':
        managing = false;
        break;
      default:
        console.log(chalk.dim('  Invalid choice.\n'));
    }
  }
}

async function linkLinkedInCli(config, rl) {
  const { saveCredential } = await import('../src/utils/config.js');

  // Show current status
  if (config.linkedin?.access_token) {
    const truncated = `${config.linkedin.access_token.slice(0, 8)}...${config.linkedin.access_token.slice(-4)}`;
    console.log(chalk.dim(`\n  Currently connected — token: ${truncated}`));
    if (config.linkedin.person_urn) console.log(chalk.dim(`  URN: ${config.linkedin.person_urn}`));
    const relink = (await ask(rl, chalk.cyan('\n  Re-link? [y/N]: '))).trim().toLowerCase();
    if (relink !== 'y') {
      console.log(chalk.dim('  Cancelled.\n'));
      return;
    }
  }

  console.log('');
  console.log(chalk.bold('  Link LinkedIn Account\n'));
  console.log(chalk.dim('  1. Go to https://www.linkedin.com/developers/tools/oauth/token-generator'));
  console.log(chalk.dim('  2. Select your app, pick scopes: openid, profile, email, w_member_social'));
  console.log(chalk.dim('  3. Authorize and copy the token'));
  console.log('');

  const token = (await ask(rl, chalk.cyan('  Paste token (or "cancel"): '))).trim();
  if (!token || token.toLowerCase() === 'cancel') {
    console.log(chalk.dim('  Cancelled.\n'));
    return;
  }

  console.log(chalk.dim('\n  Validating token...'));

  try {
    // Try /v2/userinfo (requires "Sign in with LinkedIn" product → openid+profile scopes)
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.ok) {
      const profile = await res.json();
      const personUrn = `urn:li:person:${profile.sub}`;

      saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token);
      saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

      console.log(chalk.green(`\n  ✔ LinkedIn linked`));
      console.log(chalk.dim(`    Name: ${profile.name}`));
      if (profile.email) console.log(chalk.dim(`    Email: ${profile.email}`));
      console.log(chalk.dim(`    URN: ${personUrn}`));
      console.log('');
    } else if (res.status === 401) {
      throw new Error('Invalid or expired token.');
    } else {
      // 403 = token works but no profile scopes → save token, ask for URN
      console.log(chalk.yellow('\n  Token accepted but profile scopes missing (openid+profile).'));
      console.log(chalk.dim('  To auto-detect your URN, add "Sign in with LinkedIn using OpenID Connect"'));
      console.log(chalk.dim('  to your app at https://www.linkedin.com/developers/apps\n'));
      console.log(chalk.dim('  For now, enter your person URN manually.'));
      console.log(chalk.dim('  Find it: LinkedIn profile → URL contains /in/yourname'));
      console.log(chalk.dim('  Or: Developer Portal → Your App → Auth → Your member sub value\n'));

      const urn = (await ask(rl, chalk.cyan('  Person URN (urn:li:person:XXXXX): '))).trim();
      if (!urn) {
        console.log(chalk.yellow('  No URN provided. Token saved but LinkedIn posts will not work without a URN.\n'));
        saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token);
        return;
      }

      const personUrn = urn.startsWith('urn:li:person:') ? urn : `urn:li:person:${urn}`;
      saveCredential(config, 'LINKEDIN_ACCESS_TOKEN', token);
      saveCredential(config, 'LINKEDIN_PERSON_URN', personUrn);

      console.log(chalk.green(`\n  ✔ LinkedIn linked`));
      console.log(chalk.dim(`    URN: ${personUrn}`));
      console.log('');
    }
  } catch (err) {
    console.log(chalk.red(`\n  ✖ Token validation failed: ${err.message}\n`));
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
        await changeOrchestratorModel(config, rl);
        break;
      case '7':
        await manageCustomSkills(rl);
        break;
      case '8':
        await manageAutomations(rl);
        break;
      case '9':
        await manageCharacters(rl, config);
        break;
      case '10':
        await linkLinkedInCli(config, rl);
        break;
      case '11': {
        const dashEnabled = config.dashboard?.enabled;
        const dashPort = config.dashboard?.port || 3000;
        console.log('');
        console.log(chalk.bold('  Dashboard'));
        console.log(`  Auto-start on boot: ${dashEnabled ? chalk.green('yes') : chalk.yellow('no')}`);
        console.log(`  Port: ${chalk.cyan(dashPort)}`);
        console.log(`  URL: ${chalk.cyan(`http://localhost:${dashPort}`)}`);
        console.log('');
        console.log(`  ${chalk.cyan('1.')} ${dashEnabled ? 'Disable' : 'Enable'} auto-start on boot`);
        console.log(`  ${chalk.cyan('2.')} Change port`);
        console.log(`  ${chalk.cyan('3.')} Back`);
        console.log('');
        const dashChoice = await ask(rl, chalk.cyan('  > '));
        switch (dashChoice.trim()) {
          case '1': {
            const newEnabled = !dashEnabled;
            saveDashboardToYaml({ enabled: newEnabled });
            config.dashboard.enabled = newEnabled;
            console.log(chalk.green(`\n  ✔ Dashboard auto-start ${newEnabled ? 'enabled' : 'disabled'}\n`));
            if (newEnabled) {
              console.log(chalk.dim(`  Dashboard will start at http://localhost:${dashPort} on next bot launch.`));
              console.log(chalk.dim('  Or use /dashboard start in Telegram to start now.\n'));
            }
            break;
          }
          case '2': {
            const portInput = await ask(rl, chalk.cyan('  New port: '));
            const newPort = parseInt(portInput.trim(), 10);
            if (!newPort || newPort < 1 || newPort > 65535) {
              console.log(chalk.dim('  Invalid port.\n'));
              break;
            }
            saveDashboardToYaml({ port: newPort });
            config.dashboard.port = newPort;
            console.log(chalk.green(`\n  ✔ Dashboard port set to ${newPort}\n`));
            break;
          }
          default:
            break;
        }
        break;
      }
      case '12':
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
