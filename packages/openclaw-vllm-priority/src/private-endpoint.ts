/**
 * Private/loopback endpoint classification for vLLM priority scheduling.
 *
 * This is a deliberately self-contained reimplementation, not a port of
 * OpenClaw core's `@openclaw/net-policy` SSRF-hardened IP classifier
 * (`isPrivateOrLoopbackIpAddress`). `@openclaw/net-policy` is a private,
 * internal-only workspace package - no OpenClaw provider/tool plugin depends
 * on it - and this plugin is restricted to importing from
 * `openclaw/plugin-sdk/plugin-entry` only. See the package README for the
 * full rationale; this covers the same address classes (loopback, RFC 1918
 * private ranges, link-local, carrier-grade NAT, and their IPv6 equivalents)
 * using only Node's `node:net` plus manual CIDR checks, but it is not the
 * SSRF-hardened implementation core uses to decide what a URL fetch tool may
 * reach. Do not reuse this for anything security-sensitive.
 */
import net from "node:net";

function ipv4ToUint32(parts: readonly [number, number, number, number]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseIpv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function isPrivateOrLoopbackIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) {
    return false;
  }
  const value = ipv4ToUint32(octets);
  const inRange = (base: string, prefixLength: number): boolean => {
    const baseOctets = parseIpv4(base);
    if (!baseOctets) {
      return false;
    }
    const baseValue = ipv4ToUint32(baseOctets);
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return (value & mask) === (baseValue & mask);
  };
  return (
    inRange("127.0.0.0", 8) || // loopback
    inRange("10.0.0.0", 8) || // RFC 1918 private
    inRange("172.16.0.0", 12) || // RFC 1918 private
    inRange("192.168.0.0", 16) || // RFC 1918 private
    inRange("169.254.0.0", 16) || // link-local
    inRange("100.64.0.0", 10) // carrier-grade NAT (RFC 6598)
  );
}

function isPrivateOrLoopbackIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") {
    return true; // loopback
  }
  // fc00::/7 (unique local) and fe80::/10 (link-local) both start with a
  // first hextet whose top bits match; check the common prefix forms.
  const firstHextet = normalized.split(":")[0] ?? "";
  const firstHextetValue = Number.parseInt(firstHextet || "0", 16);
  if (Number.isNaN(firstHextetValue)) {
    return false;
  }
  const isUniqueLocal = (firstHextetValue & 0xfe00) === 0xfc00; // fc00::/7
  const isLinkLocal = (firstHextetValue & 0xffc0) === 0xfe80; // fe80::/10
  if (isUniqueLocal || isLinkLocal) {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) - classify the embedded IPv4 address.
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mappedMatch?.[1]) {
    return isPrivateOrLoopbackIpv4(mappedMatch[1]);
  }
  return false;
}

/** True when `hostname` is `localhost` or a private/loopback IPv4/IPv6 literal. */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateOrLoopbackIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateOrLoopbackIpv6(normalized);
  }
  return false;
}

/** True when `baseUrl` resolves to a private/loopback host. Mirrors the fork's `isPrivateModelEndpoint`. */
export function isPrivateModelEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    return isPrivateOrLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
