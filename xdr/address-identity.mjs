import { isIP } from 'node:net';

// Offline adapter identity only; raw evidence and isolated judge entries stay
// unchanged. Validate before URL parsing so hosts, ports, aliases, and coercible
// objects can never be turned into address bindings.
export function addressIdentity(value) {
  if (typeof value !== 'string') return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const scopeAt = value.indexOf('%');
  const address = scopeAt === -1 ? value : value.slice(0, scopeAt);
  const scope = scopeAt === -1 ? '' : value.slice(scopeAt);
  try {
    const host = new URL(`http://[${address}]/`).hostname;
    // Canonical IPv6 retains colons, so mapped IPv6 cannot equal native IPv4.
    // A zone is local interface identity: retain its exact spelling and case.
    return host.slice(1, -1) + scope;
  } catch {
    return null;
  }
}
