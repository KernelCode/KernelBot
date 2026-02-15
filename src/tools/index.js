import { definitions as osDefinitions, handlers as osHandlers } from './os.js';
import { definitions as processDefinitions, handlers as processHandlers } from './process.js';
import { definitions as dockerDefinitions, handlers as dockerHandlers } from './docker.js';
import { definitions as monitorDefinitions, handlers as monitorHandlers } from './monitor.js';
import { definitions as networkDefinitions, handlers as networkHandlers } from './network.js';
import { definitions as gitDefinitions, handlers as gitHandlers } from './git.js';
import { definitions as githubDefinitions, handlers as githubHandlers } from './github.js';
import { definitions as codingDefinitions, handlers as codingHandlers } from './coding.js';
import { logToolCall } from '../security/audit.js';
import { requiresConfirmation } from '../security/confirm.js';

export const toolDefinitions = [
  ...osDefinitions,
  ...processDefinitions,
  ...dockerDefinitions,
  ...monitorDefinitions,
  ...networkDefinitions,
  ...gitDefinitions,
  ...githubDefinitions,
  ...codingDefinitions,
];

const handlerMap = {
  ...osHandlers,
  ...processHandlers,
  ...dockerHandlers,
  ...monitorHandlers,
  ...networkHandlers,
  ...gitHandlers,
  ...githubHandlers,
  ...codingHandlers,
};

export function checkConfirmation(name, params, config) {
  return requiresConfirmation(name, params, config);
}

export async function executeTool(name, params, context) {
  const handler = handlerMap[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  const start = Date.now();
  let output;
  let success = true;

  try {
    output = await handler(params, context);
    if (output?.error) success = false;
  } catch (err) {
    output = { error: err.message };
    success = false;
  }

  const duration = Date.now() - start;

  logToolCall({
    user: context.user,
    tool: name,
    params,
    output,
    success,
    duration,
  });

  return output;
}
