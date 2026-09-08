import { shellRun, shellEscape } from '../utils/shell.js';
import { getLogger } from '../utils/logger.js';
import { resolvePublicHost, validateHttpUrl } from '../security/network-policy.js';
import { isIP } from 'node:net';

const run = (cmd, timeout = 15000) => shellRun(cmd, timeout);

export const definitions = [
  {
    name: 'check_port',
    description: 'Check if a port is open and listening.',
    input_schema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'Port number to check' },
        host: { type: 'string', description: 'Host to check (default: localhost)' },
      },
      required: ['port'],
    },
  },
  {
    name: 'curl_url',
    description: 'Make an HTTP request to a URL and return the response.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to request' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Request headers (optional)' },
        body: { type: 'string', description: 'Request body (optional)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'nginx_reload',
    description: 'Test nginx configuration and reload if valid.',
    input_schema: { type: 'object', properties: {} },
  },
];

// Dependency injection keeps policy/execution regression tests off the network.
export const createNetworkHandlers = ({ lookup, execute = run, logger = getLogger } = {}) => ({
  check_port: async (params) => {
    const host = params.host || 'localhost';
    const port = parseInt(params.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return { error: 'Invalid port number' };

    let destination;
    try {
      // Keep the explicit local diagnostic exception, without trusting DNS for it.
      destination = host === 'localhost' ? { address: '127.0.0.1', family: 4 }
        : await resolvePublicHost(host, { lookup });
    } catch (error) {
      return { error: error.message };
    }

    logger().debug(`check_port: checking ${host}:${port}`);
    // Use nc (netcat) for port check — works on both macOS and Linux
    const result = await execute(`nc -${destination.family} -n -z -w 3 ${shellEscape(destination.address)} ${port} 2>&1 && echo "OPEN" || echo "CLOSED"`, 5000);

    if (result.error) {
      logger().error(`check_port failed for ${host}:${port}: ${result.error}`);
      return { port, host, status: 'closed', detail: result.error };
    }

    const isOpen = result.output.includes('OPEN');
    return { port, host, status: isOpen ? 'open' : 'closed' };
  },

  curl_url: async (params) => {
    const { url, method = 'GET', headers, body } = params;

    let destination;
    try {
      destination = await validateHttpUrl(url, { lookup });
    } catch (error) {
      return { error: error.message };
    }

    // -q must be first: curlrc, proxies and URL expansion must not override the
    // validated destination. Redirects remain disabled (curl's default).
    let cmd = `curl -q --globoff --proto '=http,https' --noproxy '*' -s -w "\\n---HTTP_STATUS:%{http_code}" -X ${shellEscape(method)}`;
    if (!isIP(destination.host)) {
      const address = destination.family === 6 ? `[${destination.address}]` : destination.address;
      cmd += ` --resolve ${shellEscape(`${destination.host}:${destination.port}:${address}`)}`;
    }

    if (headers) {
      for (const [key, val] of Object.entries(headers)) {
        cmd += ` -H ${shellEscape(`${key}: ${val}`)}`;
      }
    }

    if (body) {
      cmd += ` -d ${shellEscape(body)}`;
    }

    cmd += ` --url ${shellEscape(destination.url)}`;

    const result = await execute(cmd);

    if (result.error) return result;

    const parts = result.output.split('---HTTP_STATUS:');
    const responseBody = parts[0].trim();
    const statusCode = parts[1] ? parseInt(parts[1].trim()) : null;

    return { status_code: statusCode, body: responseBody };
  },

  nginx_reload: async () => {
    const logger = getLogger();
    // Test config first
    logger.debug('nginx_reload: testing configuration');
    const test = await run('nginx -t 2>&1');
    if (test.error || (test.output && test.output.includes('failed'))) {
      logger.error(`nginx_reload: config test failed: ${test.error || test.output}`);
      return { error: `Config test failed: ${test.error || test.output}` };
    }

    const reload = await run('nginx -s reload 2>&1');
    if (reload.error) {
      logger.error(`nginx_reload failed: ${reload.error}`);
      return reload;
    }

    logger.debug('nginx_reload: successfully reloaded');
    return { success: true, test_output: test.output };
  },
});

export const handlers = createNetworkHandlers();
