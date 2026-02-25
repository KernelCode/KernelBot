import { TOOL_CATEGORIES } from '../tools/categories.js';
import { toolDefinitions } from '../tools/index.js';

/**
 * Worker type definitions — maps each worker type to the tool categories it needs.
 */
export const WORKER_TYPES = {
  coding: {
    label: 'Coding Worker',
    emoji: '💻',
    categories: ['core', 'coding', 'git', 'github'],
    description: 'Write code, fix bugs, create PRs',
    timeout: 86400,  // 24 hours — Claude Code can legitimately run for hours
  },
  browser: {
    label: 'Browser Worker',
    emoji: '🌐',
    categories: ['browser'],
    description: 'Web search, scraping, screenshots',
    timeout: 300,    // 5 minutes
  },
  system: {
    label: 'System Worker',
    emoji: '🖥️',
    categories: ['core', 'process', 'monitor', 'network'],
    description: 'OS operations, monitoring, network',
    timeout: 600,    // 10 minutes
  },
  devops: {
    label: 'DevOps Worker',
    emoji: '🚀',
    categories: ['core', 'docker', 'process', 'monitor', 'network', 'git'],
    description: 'Docker, deploy, infrastructure',
    timeout: 3600,   // 1 hour
  },
  research: {
    label: 'Research Worker',
    emoji: '🔍',
    categories: ['browser', 'core'],
    description: 'Deep web research and analysis',
    timeout: 600,    // 10 minutes
  },
  social: {
    label: 'Social Worker',
    emoji: '📱',
    categories: ['linkedin', 'x'],
    description: 'LinkedIn and X (Twitter) posting, engagement, feed reading',
    timeout: 120,    // 2 minutes
  },
};

/**
 * Get the tool name set for a given worker type.
 * @param {string} workerType
 * @returns {Set<string>}
 */
function getToolNamesForWorker(workerType) {
  const config = WORKER_TYPES[workerType];
  if (!config) throw new Error(`Unknown worker type: ${workerType}`);

  const names = new Set();
  for (const cat of config.categories) {
    const tools = TOOL_CATEGORIES[cat];
    if (tools) tools.forEach((t) => names.add(t));
  }
  return names;
}

/**
 * Get Anthropic-format tool definitions scoped to a worker type.
 * @param {string} workerType
 * @returns {Array} filtered tool definitions
 */
export function getToolsForWorker(workerType) {
  const names = getToolNamesForWorker(workerType);
  return toolDefinitions.filter((t) => names.has(t.name));
}

/**
 * Get all tool names for a worker type (for credential checking).
 * @param {string} workerType
 * @returns {string[]}
 */
export function getToolNamesForWorkerType(workerType) {
  return [...getToolNamesForWorker(workerType)];
}
