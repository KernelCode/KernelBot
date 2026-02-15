import { definitions as osDefinitions, handlers as osHandlers } from './os.js';
import { logToolCall } from '../security/audit.js';

export const toolDefinitions = [...osDefinitions];

const handlerMap = { ...osHandlers };

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
