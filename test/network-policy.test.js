import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, resolvePublicHost, validateHttpUrl } from '../src/security/network-policy.js';
import { createNetworkHandlers } from '../src/tools/network.js';
import { shellEscape } from '../src/utils/shell.js';

const publicV4 = '8.8.8.8';
const publicV6 = '2606:4700:4700::1111';
const forbidden = [
  '0.0.0.0', '10.0.0.5', '100.64.0.1', '100.127.255.255', '127.0.0.1',
  '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255',
  '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8',
  '64:ff9b::a00:1', '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::1',
  '2002:0a00:0001::1', '3fff::1', 'fc00::1', 'fd00::1', 'fe80::1',
  'fe80::1%eth0', 'fec0::1', 'ff02::1',
];
const resolver = (...addresses) => async () => addresses.map(address => ({ address }));
let unexpectedLookups = 0;
const noLookup = async () => {
  unexpectedLookups++;
  assert.fail('Unexpected DNS lookup');
};
after(() => assert.equal(unexpectedLookups, 0, 'literal/invalid destinations must not invoke DNS'));

for (const address of forbidden) {
  test(`rejects non-public address ${address}`, async () => {
    assert.equal(isPublicAddress(address), false);
    await assert.rejects(resolvePublicHost(address, { lookup: noLookup }));
    await assert.rejects(resolvePublicHost('public.example', { lookup: resolver(address) }));
  });
}

test('accepts public IPv4 and IPv6 and checks CIDR boundaries', async () => {
  for (const address of [publicV4, publicV6, '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0']) {
    assert.equal(isPublicAddress(address), true, address);
    assert.equal((await resolvePublicHost(address, { lookup: noLookup })).address, address);
  }
});

test('requests all DNS candidates and rejects mixed results in either order', async () => {
  let calls = 0;
  await assert.rejects(resolvePublicHost('public.example', { lookup: async (host, options) => {
    calls++;
    assert.equal(host, 'public.example');
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: publicV4 }, { address: '10.0.0.1' }];
  } }));
  assert.equal(calls, 1);
  await assert.rejects(resolvePublicHost('public.example', { lookup: resolver('10.0.0.1', publicV4) }));
});

test('DNS errors, empty/malformed answers and timeout fail closed', async () => {
  for (const result of [[], null, {}, [{}], [{ address: 'not-an-ip' }], [{ address: `${publicV6}%eth0` }]]) {
    await assert.rejects(resolvePublicHost('public.example', { lookup: async () => result }));
  }
  await assert.rejects(resolvePublicHost('public.example', { lookup: async () => { throw new Error('ENOTFOUND'); } }), /Unable to resolve/);
  await assert.rejects(resolvePublicHost('public.example', { lookup: () => new Promise(() => {}), timeoutMs: 1 }), /Unable to resolve/);
});

test('blocks internal names and pin-control syntax before DNS', async () => {
  for (const host of ['localhost', 'LOCALHOST.', 'foo.localhost', 'metadata.google.internal',
    '+public.example', '*.example', 'public.example:80', 'a,b', '[bad]', '']) {
    await assert.rejects(resolvePublicHost(host, { lookup: noLookup }));
  }
});

test('only HTTP(S), including canonicalized numeric hosts', async () => {
  for (const url of ['file:///etc/hostname', 'gopher://public.example', 'ftp://public.example',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]',
    'http://%31%32%37.0.0.1', 'not a url']) {
    await assert.rejects(validateHttpUrl(url, { lookup: noLookup }));
  }
  const result = await validateHttpUrl('https://PUBLIC.example.:8443/path?q=1', { lookup: resolver(publicV4) });
  assert.equal(result.url, 'https://public.example:8443/path?q=1');
  assert.equal(result.port, '8443');
});

function harness(lookup = resolver(publicV4), response = { output: 'hello\n---HTTP_STATUS:200' }) {
  const commands = [];
  const handlers = createNetworkHandlers({
    lookup,
    execute: async (...args) => { commands.push(args); return response; },
    logger: () => ({ debug() {}, error() {} }),
  });
  return { handlers, commands };
}

test('HTTP and HTTPS execute the validated address once and preserve hostname/TLS identity', async () => {
  for (const [scheme, port] of [['http', '80'], ['https', '443']]) {
    let lookups = 0;
    const { handlers, commands } = harness(async () => {
      lookups++;
      return [{ address: lookups === 1 ? publicV4 : '127.0.0.1' }, { address: publicV6 }];
    });
    assert.deepEqual(await handlers.curl_url({ url: `${scheme}://public.example/path` }), { status_code: 200, body: 'hello' });
    assert.equal(lookups, 1);
    assert.equal(commands.length, 1);
    const [command] = commands[0];
    assert.ok(command.startsWith('curl -q --globoff '));
    assert.ok(command.includes("--proto '=http,https' --noproxy '*'"));
    assert.ok(command.includes(`--resolve 'public.example:${port}:${publicV4}'`));
    assert.ok(command.endsWith(`--url '${scheme}://public.example/path'`));
    assert.doesNotMatch(command, /--location|--follow|--insecure|(?:^| )-[Lk](?: |$)/);
  }
});

test('pins custom ports and IPv6 DNS answers with bracketed addresses', async () => {
  const { handlers, commands } = harness(resolver(publicV6));
  await handlers.curl_url({ url: 'https://public.example:8443/' });
  assert.ok(commands[0][0].includes(`--resolve 'public.example:8443:[${publicV6}]'`));
});

test('public numeric URLs are already pinned and need no DNS/resolve entry', async () => {
  const { handlers, commands } = harness(noLookup);
  for (const url of [`https://${publicV4}/`, `https://[${publicV6}]/`]) {
    assert.equal((await handlers.curl_url({ url })).status_code, 200);
    assert.ok(commands.at(-1)[0].endsWith(`--url '${url}'`));
    assert.ok(!commands.at(-1)[0].includes('--resolve'));
  }
});

test('denied destinations never reach execution in either handler', async () => {
  const { handlers, commands } = harness(resolver(publicV4, '10.0.0.1'));
  assert.ok((await handlers.curl_url({ url: 'https://public.example' })).error);
  assert.ok((await handlers.check_port({ host: 'public.example', port: 22 })).error);
  assert.ok((await handlers.curl_url({ url: 'file:///etc/hostname' })).error);
  assert.equal(commands.length, 0);
});

test('check_port pins public answers and preserves the explicit localhost exception', async () => {
  const { handlers, commands } = harness(resolver(publicV6), { output: 'OPEN' });
  assert.deepEqual(await handlers.check_port({ host: 'public.example', port: 22 }), { host: 'public.example', port: 22, status: 'open' });
  assert.equal(commands[0][0], `nc -6 -n -z -w 3 '${publicV6}' 22 2>&1 && echo "OPEN" || echo "CLOSED"`);
  const local = harness(noLookup, { output: 'OPEN' });
  for (const params of [{ port: 80 }, { host: 'localhost', port: 80 }]) {
    assert.equal((await local.handlers.check_port(params)).status, 'open');
    assert.ok(local.commands.at(-1)[0].startsWith("nc -4 -n -z -w 3 '127.0.0.1' 80"));
  }
  assert.ok((await local.handlers.check_port({ host: '127.0.0.1', port: 80 })).error);
  assert.ok((await local.handlers.check_port({ host: '10.0.0.1', port: 80 })).error);
  assert.ok((await local.handlers.check_port({ port: 65536 })).error);
  assert.equal(local.commands.length, 2);
});

test('preserves method, headers, body escaping and execution errors', async () => {
  const { handlers, commands } = harness();
  await handlers.curl_url({ url: 'https://public.example/{a,b}', method: 'POST', headers: { 'X-Test': "it's fine" }, body: "it's data" });
  assert.ok(commands[0][0].includes("-X 'POST'"));
  assert.ok(commands[0][0].includes(`-H ${shellEscape("X-Test: it's fine")}`));
  assert.ok(commands[0][0].includes(`-d ${shellEscape("it's data")}`));
  const failed = harness(resolver(publicV4), { error: 'connection failed' });
  assert.deepEqual(await failed.handlers.curl_url({ url: 'https://public.example' }), { error: 'connection failed' });
});
