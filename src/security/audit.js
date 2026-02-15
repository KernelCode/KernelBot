import winston from 'winston';

const SECRET_PATTERNS = /token|key|secret|password|api_key/i;

function redactSecrets(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return obj;

  const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(redacted)) {
    if (SECRET_PATTERNS.test(k)) {
      redacted[k] = '[REDACTED]';
    } else if (typeof redacted[k] === 'object') {
      redacted[k] = redactSecrets(redacted[k]);
    }
  }
  return redacted;
}

function truncate(str, max = 500) {
  if (typeof str !== 'string') str = JSON.stringify(str);
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...[truncated]' : str;
}

let auditLogger = null;

export function createAuditLogger() {
  auditLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({
        filename: 'kernel-audit.log',
        maxsize: 5_242_880,
        maxFiles: 3,
      }),
    ],
  });
  return auditLogger;
}

export function logToolCall({ user, tool, params, output, success, duration }) {
  if (!auditLogger) return;

  auditLogger.info('tool_call', {
    user,
    tool,
    params: redactSecrets(params),
    output: truncate(output),
    success,
    duration_ms: duration,
  });
}
