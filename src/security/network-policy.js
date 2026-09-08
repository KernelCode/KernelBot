import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Conservative outbound policy: exclude special-purpose IPv4 ranges and allow
// only ordinary IPv6 global unicast (no mapped, translation or tunnel ranges).
// Registries: https://www.iana.org/assignments/iana-ipv4-special-registry/
//             https://www.iana.org/assignments/iana-ipv6-special-registry/
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export async function resolvePublicHost(host, { lookup = dnsLookup, timeoutMs = 5000 } = {}) {
  if (typeof host !== 'string' || !host) throw new Error('Invalid host');
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
    if (isIP(host) !== 6) throw new Error('Invalid host');
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new Error('Blocked: cannot access internal or cloud metadata addresses');
  }

  let addresses;
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    // Also prevents curl --resolve control syntax (+, *, :, comma) in names.
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('Invalid host');
    let timer;
    try {
      addresses = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
        }),
      ]);
    } catch {
      throw new Error('Unable to resolve host');
    } finally {
      clearTimeout(timer);
    }
  }
  if (!Array.isArray(addresses) || !addresses.length ||
      addresses.some(result => !isPublicAddress(result?.address))) {
    throw new Error('Blocked: destination must resolve only to public addresses');
  }
  // Execution must use this numeric address, never resolve the hostname again.
  return { host, address: addresses[0].address, family: isIP(addresses[0].address) };
}

export async function validateHttpUrl(url, options) {
  let parsed;
  try {
    if (typeof url !== 'string') throw new Error();
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Blocked: only HTTP and HTTPS URLs are allowed');
  }
  const destination = await resolvePublicHost(parsed.hostname, options);
  // Use the parsed URL at execution too, including canonical numeric hosts.
  parsed.hostname = destination.family === 6 && isIP(destination.host)
    ? `[${destination.host}]` : destination.host;
  return { ...destination, url: parsed.href, port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80') };
}
