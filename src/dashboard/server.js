/**
 * Dashboard HTTP server — cyberpunk terminal monitoring UI.
 * Zero external dependencies — uses Node.js built-in http, fs, path, os, url.
 *
 * Exports startDashboard(deps) → { server, stop() }
 */

import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadavg, totalmem, freemem, cpus } from 'os';
import { getLogger } from '../utils/logger.js';
import { WORKER_TYPES } from '../swarm/worker-registry.js';
import { TOOL_CATEGORIES } from '../tools/categories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the dashboard HTTP server.
 * @param {object} deps - All system dependencies
 * @returns {{ server: import('http').Server, stop: () => void }}
 */
export function startDashboard(deps) {
  const {
    port = 3000,
    config,
    jobManager,
    automationManager,
    lifeEngine,
    conversationManager,
    characterManager,
    memoryManager,
    journalManager,
    shareQueue,
    evolutionTracker,
    selfManager,
  } = deps;

  const logger = getLogger();

  // --- Static file caching ---
  let cachedHtml = null;
  const htmlPath = join(__dirname, 'index.html');

  function getHtml() {
    // Re-read on each request in case we're developing, but cache in production
    if (!cachedHtml) {
      cachedHtml = readFileSync(htmlPath, 'utf-8');
    }
    return cachedHtml;
  }

  // --- Log tail ---
  const logPaths = [
    join(process.cwd(), 'kernel.log'),
    join(process.env.HOME || '', '.kernelbot', 'kernel.log'),
  ];
  let logCache = { mtime: 0, lines: [] };

  function tailLog(count = 100) {
    for (const p of logPaths) {
      try {
        const st = statSync(p);
        if (st.mtimeMs !== logCache.mtime) {
          const content = readFileSync(p, 'utf-8');
          const allLines = content.split('\n').filter(Boolean);
          logCache = { mtime: st.mtimeMs, lines: allLines.slice(-count) };
        }
        return logCache.lines;
      } catch { /* skip */ }
    }
    return [];
  }

  function parseLogs(lines) {
    return lines.map(line => {
      try {
        const entry = JSON.parse(line);
        return {
          timestamp: entry.timestamp || '',
          level: entry.level || 'info',
          message: entry.message || '',
        };
      } catch {
        return { timestamp: '', level: 'info', message: line };
      }
    });
  }

  // --- API data builders ---

  function getSystemData() {
    const load = loadavg();
    const total = totalmem();
    const free = freemem();
    const mem = process.memoryUsage();
    return {
      cpu: { load1: load[0], load5: load[1], load15: load[2], cores: cpus().length },
      ram: { total, free, used: total - free, percent: ((total - free) / total * 100).toFixed(1) },
      process: { heap: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss, external: mem.external },
      uptime: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: Date.now() - process.uptime() * 1000,
    };
  }

  function getConfigData() {
    const mask = (val) => val ? '●●●●●●●●' : 'NOT SET';
    const has = (val) => !!val;
    return {
      orchestrator: {
        provider: config.orchestrator?.provider || 'anthropic',
        model: config.orchestrator?.model || 'default',
        max_tokens: config.orchestrator?.max_tokens,
        temperature: config.orchestrator?.temperature,
        api_key: mask(config.orchestrator?.api_key),
      },
      brain: {
        provider: config.brain?.provider || 'anthropic',
        model: config.brain?.model || 'default',
        max_tokens: config.brain?.max_tokens,
        temperature: config.brain?.temperature,
        max_tool_depth: config.brain?.max_tool_depth,
        api_key: mask(config.brain?.api_key),
      },
      swarm: config.swarm || {},
      life: {
        enabled: config.life?.enabled !== false,
        min_interval: config.life?.min_interval_minutes,
        max_interval: config.life?.max_interval_minutes,
        activity_weights: config.life?.activity_weights,
        quiet_hours: config.life?.quiet_hours,
        self_coding: config.life?.self_coding ? {
          enabled: config.life.self_coding.enabled,
          branch_prefix: config.life.self_coding.branch_prefix,
          cooldown_hours: config.life.self_coding.cooldown_hours,
          max_active_prs: config.life.self_coding.max_active_prs,
          allowed_scopes: config.life.self_coding.allowed_scopes,
        } : null,
      },
      telegram: { allowed_users: config.telegram?.allowed_users?.length || 0 },
      bot: config.bot || {},
      claude_code: {
        model: config.claude_code?.model || 'default',
        max_turns: config.claude_code?.max_turns,
        timeout_seconds: config.claude_code?.timeout_seconds,
        auth_mode: config.claude_code?.auth_mode || 'system',
      },
      integrations: {
        telegram: has(config.telegram?.bot_token),
        github: has(config.github?.token),
        jira: has(config.jira?.api_token),
        linkedin: has(config.linkedin?.access_token),
        x: has(config.x?.consumer_key),
        elevenlabs: has(config.elevenlabs?.api_key),
        claude_code: has(config.claude_code?.api_key || config.claude_code?.oauth_token) || config.claude_code?.auth_mode === 'system',
      },
    };
  }

  function getJobsData() {
    const jobs = [];
    for (const [id, job] of jobManager.jobs) {
      jobs.push({
        id,
        type: job.workerType,
        status: job.status,
        task: job.task,
        duration: job.duration,
        llmCalls: job.llmCalls,
        toolCalls: job.toolCalls,
        progress: job.progress || [],
        lastThinking: job.lastThinking,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        chatId: job.chatId,
        error: job.error,
        context: job.context,
        dependsOn: job.dependsOn || [],
        timeoutMs: job.timeoutMs,
        lastActivity: job.lastActivity,
        structuredResult: job.structuredResult ? {
          summary: job.structuredResult.summary,
          status: job.structuredResult.status,
          details: job.structuredResult.details,
          artifacts: job.structuredResult.artifacts,
          followUp: job.structuredResult.followUp,
          toolsUsed: job.structuredResult.toolsUsed,
          errors: job.structuredResult.errors,
        } : null,
      });
    }
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  function getAutomationsData() {
    try {
      return automationManager.listAll().map(a => ({
        id: a.id,
        chatId: a.chatId,
        name: a.name,
        description: a.description,
        schedule: a.schedule,
        enabled: a.enabled,
        lastRun: a.lastRun,
        nextRun: a.nextRun,
        runCount: a.runCount,
        lastError: a.lastError,
      }));
    } catch { return []; }
  }

  function getLifeData() {
    try {
      const status = lifeEngine.getStatus();
      const state = lifeEngine._state || {};
      const now = Date.now();
      const scCfg = config.life?.self_coding || {};
      const cooldowns = {
        journal: state.lastJournalTime ? Math.max(0, 4 * 3600000 - (now - state.lastJournalTime)) : 0,
        self_code: state.lastSelfCodeTime ? Math.max(0, (scCfg.cooldown_hours ?? 2) * 3600000 - (now - state.lastSelfCodeTime)) : 0,
        code_review: state.lastCodeReviewTime ? Math.max(0, (scCfg.code_review_cooldown_hours ?? 4) * 3600000 - (now - state.lastCodeReviewTime)) : 0,
        reflect: state.lastReflectTime ? Math.max(0, 4 * 3600000 - (now - state.lastReflectTime)) : 0,
      };
      let ideas = [];
      try { ideas = lifeEngine._loadIdeas(); } catch { /* skip */ }
      const weights = config.life?.activity_weights || {};
      return { ...status, cooldowns, ideas: ideas.slice(-20), weights };
    } catch { return { status: 'unknown' }; }
  }

  function getMemoriesData() {
    try {
      return memoryManager.getRecentEpisodic(72, 30);
    } catch { return []; }
  }

  function getJournalData() {
    try {
      return {
        content: journalManager.getToday() || '',
        recent: journalManager.getRecent(7),
        dates: journalManager.list(30),
      };
    } catch { return { content: '', recent: [], dates: [] }; }
  }

  function getEvolutionData() {
    try {
      return {
        stats: evolutionTracker.getStats(),
        active: evolutionTracker.getActiveProposal(),
        recent: evolutionTracker.getRecentProposals(10),
        lessons: evolutionTracker.getRecentLessons(15),
        prsToCheck: evolutionTracker.getPRsToCheck().length,
      };
    } catch { return { stats: {}, active: null, recent: [], lessons: [], prsToCheck: 0 }; }
  }

  function getConversationsData() {
    try {
      const summaries = [];
      for (const [chatId, messages] of conversationManager.conversations) {
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const skill = conversationManager.activeSkills?.get(chatId) || null;
        const userMsgs = messages.filter(m => m.role === 'user').length;
        const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
        summaries.push({
          chatId,
          messageCount: messages.length,
          userMessages: userMsgs,
          assistantMessages: assistantMsgs,
          lastTimestamp: last?.timestamp || null,
          activeSkill: skill,
        });
      }
      return summaries.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
    } catch { return []; }
  }

  function getCharacterData() {
    try {
      const activeId = characterManager.getActiveCharacterId();
      const active = characterManager.getCharacter(activeId);
      const all = characterManager.listCharacters();
      return {
        active: active ? {
          id: activeId, name: active.name, emoji: active.emoji,
          type: active.type, tagline: active.tagline,
          origin: active.origin, age: active.age,
          lastActiveAt: active.lastActiveAt,
        } : null,
        characters: all.map(c => ({
          id: c.id, name: c.name, emoji: c.emoji, type: c.type, tagline: c.tagline,
        })),
      };
    } catch { return { active: null, characters: [] }; }
  }

  function getSharesData() {
    try {
      return {
        pending: shareQueue.getPending(null, 20),
        shared: (shareQueue._data?.shared || []).slice(-15),
        todayCount: shareQueue.getSharedTodayCount(),
      };
    } catch { return { pending: [], shared: [], todayCount: 0 }; }
  }

  function getSelfData() {
    try {
      return { content: selfManager.loadAll() };
    } catch { return { content: '' }; }
  }

  function getCapabilitiesData() {
    const workers = {};
    for (const [type, def] of Object.entries(WORKER_TYPES)) {
      const toolNames = [];
      for (const cat of def.categories) {
        const tools = TOOL_CATEGORIES[cat];
        if (tools) toolNames.push(...tools);
      }
      workers[type] = {
        label: def.label,
        emoji: def.emoji,
        description: def.description,
        timeout: def.timeout,
        categories: def.categories,
        tools: [...new Set(toolNames)],
      };
    }
    const totalTools = new Set(Object.values(TOOL_CATEGORIES).flat()).size;
    return { workers, categories: Object.keys(TOOL_CATEGORIES), totalTools };
  }

  function getKnowledgeData() {
    try {
      const data = memoryManager._loadSemantic();
      return Object.entries(data).map(([topic, val]) => ({
        topic,
        summary: val.summary,
        sources: val.sources || [],
        relatedTopics: val.relatedTopics || [],
        learnedAt: val.learnedAt,
      })).sort((a, b) => (b.learnedAt || 0) - (a.learnedAt || 0));
    } catch { return []; }
  }

  // --- Full snapshot for SSE ---
  function getSnapshot() {
    return {
      ts: Date.now(),
      system: getSystemData(),
      jobs: getJobsData(),
      automations: getAutomationsData(),
      life: getLifeData(),
      memories: getMemoriesData(),
      journal: getJournalData(),
      evolution: getEvolutionData(),
      conversations: getConversationsData(),
      character: getCharacterData(),
      shares: getSharesData(),
      logs: parseLogs(tailLog(100)),
      capabilities: getCapabilitiesData(),
      knowledge: getKnowledgeData(),
    };
  }

  // --- SSE ---
  const sseClients = new Set();

  function broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  }

  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      broadcastSSE(getSnapshot());
    } catch (err) {
      logger.warn(`[Dashboard] SSE broadcast error: ${err.message}`);
    }
  }, 3000);

  // --- HTTP routing ---
  function sendJson(res, data) {
    const body = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Serve index.html
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
      return;
    }

    // SSE endpoint
    if (path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // JSON API
    const routes = {
      '/api/system': getSystemData,
      '/api/config': getConfigData,
      '/api/jobs': getJobsData,
      '/api/automations': getAutomationsData,
      '/api/life': getLifeData,
      '/api/memories': getMemoriesData,
      '/api/journal': getJournalData,
      '/api/evolution': getEvolutionData,
      '/api/conversations': getConversationsData,
      '/api/character': getCharacterData,
      '/api/logs': () => parseLogs(tailLog(100)),
      '/api/shares': getSharesData,
      '/api/self': getSelfData,
      '/api/capabilities': getCapabilitiesData,
      '/api/knowledge': getKnowledgeData,
    };

    if (routes[path]) {
      try {
        sendJson(res, routes[path]());
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    logger.info(`[Dashboard] Cyberpunk terminal running on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    logger.error(`[Dashboard] Server error: ${err.message}`);
  });

  return {
    server,
    stop() {
      clearInterval(sseInterval);
      for (const res of sseClients) {
        try { res.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      server.close();
    },
  };
}
