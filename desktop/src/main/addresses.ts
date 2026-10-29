/**
 * Network addresses players can reach this machine on (docs/DESKTOP.md §6.3 item 2): every non-internal IPv4
 * of os.networkInterfaces(), classified as vpn / lan / other and ordered vpn → lan → other.
 */
import os from 'node:os';
import type { Address, AddressKind } from '../shared/ipc';

/** Adapter names of the usual mesh VPNs (Hamachi, NetBird, Tailscale, ZeroTier, WireGuard and the generic tunnel names). */
export const VPN_ADAPTER = /hamachi|netbird|tailscale|zerotier|wireguard|wt\d|tun\d/i;

const KIND_ORDER: Record<AddressKind, number> = { vpn: 0, lan: 1, other: 2 };

/** Dotted IPv4 → unsigned 32-bit number, or null when it is not an IPv4 literal. */
export function ipv4ToInt(address: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** True when `address` is inside `cidr` (e.g. "100.64.0.0/10"). */
export function inCidr(address: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const ip = ipv4ToInt(address);
  const base = ipv4ToInt(net ?? '');
  const bits = Number(bitsStr);
  if (ip === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * Adapters of virtual machines and containers on this PC (Hyper-V / WSL "vEthernet", VirtualBox, VMware, Docker
 * bridges, Npcap loopback, Bluetooth PAN). Their RFC 1918 addresses look like a LAN but no player can reach them,
 * so they are `other` (listed last, never the default).
 */
export const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|vmnet|docker|\bbr-|\bveth|Npcap|Bluetooth/i;
/** VirtualBox's default host-only network. */
const VIRTUAL_RANGES = ['192.168.56.0/24'];

/** Hamachi hands out 25.0.0.0/8 (and historically 5.0.0.0/8); NetBird and Tailscale use the CGNAT range 100.64.0.0/10. */
const VPN_RANGES = ['25.0.0.0/8', '5.0.0.0/8', '100.64.0.0/10'];
const LAN_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export function classifyAddress(adapter: string, address: string): AddressKind {
  if (VPN_ADAPTER.test(adapter)) return 'vpn';
  if (VIRTUAL_ADAPTER.test(adapter)) return 'other';
  if (VIRTUAL_RANGES.some((r) => inCidr(address, r))) return 'other';
  if (VPN_RANGES.some((r) => inCidr(address, r))) return 'vpn';
  if (LAN_RANGES.some((r) => inCidr(address, r))) return 'lan';
  return 'other';
}

/** Subset of os.NetworkInterfaceInfo the classification needs (Node ≥ 18 reports family as the string 'IPv4'). */
export interface IfaceInfo { address: string; family: string | number; internal: boolean }

export function listAddresses(
  interfaces: Record<string, IfaceInfo[] | undefined> = os.networkInterfaces() as Record<string, IfaceInfo[] | undefined>,
): Address[] {
  const out: Address[] = [];
  for (const [adapter, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const isV4 = info.family === 'IPv4' || info.family === 4;
      if (!isV4 || info.internal || ipv4ToInt(info.address) === null) continue;
      if (out.some((a) => a.address === info.address)) continue;
      out.push({ address: info.address, adapter, kind: classifyAddress(adapter, info.address) });
    }
  }
  // Stable sort: vpn first, then lan, then other; insertion order inside a kind.
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => KIND_ORDER[x.a.kind] - KIND_ORDER[y.a.kind] || x.i - y.i)
    .map(({ a }) => a);
}

/** The address the links default to: the saved preference if still present, else the first vpn, else the first lan, else the first of all. */
export function pickAddress(addresses: Address[], preferred: string | null): string | null {
  if (preferred && addresses.some((a) => a.address === preferred)) return preferred;
  return (
    addresses.find((a) => a.kind === 'vpn')?.address ??
    addresses.find((a) => a.kind === 'lan')?.address ??
    addresses[0]?.address ??
    null
  );
}
