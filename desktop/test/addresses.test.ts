import { describe, expect, it } from 'vitest';
import { classifyAddress, inCidr, ipv4ToInt, listAddresses, pickAddress } from '../src/main/addresses';

describe('ipv4 helpers', () => {
  it('parses dotted quads and rejects anything else', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('192.168.1.10')).toBe(192 * 2 ** 24 + 168 * 2 ** 16 + 256 + 10);
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
    expect(ipv4ToInt('fe80::1')).toBeNull();
    expect(ipv4ToInt('1.2.3')).toBeNull();
  });

  it('matches CIDR ranges', () => {
    expect(inCidr('100.64.0.1', '100.64.0.0/10')).toBe(true);
    expect(inCidr('100.127.255.254', '100.64.0.0/10')).toBe(true);
    expect(inCidr('100.128.0.1', '100.64.0.0/10')).toBe(false);
    expect(inCidr('172.16.0.1', '172.16.0.0/12')).toBe(true);
    expect(inCidr('172.31.255.1', '172.16.0.0/12')).toBe(true);
    expect(inCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(inCidr('bogus', '10.0.0.0/8')).toBe(false);
  });
});

describe('classifyAddress', () => {
  it('recognises VPN adapters by name whatever the address', () => {
    for (const name of ['Hamachi', 'LogMeIn Hamachi', 'NetBird', 'wt0', 'tailscale0', 'Tailscale', 'ZeroTier One [abc]', 'wg0 wireguard', 'tun0']) {
      expect(classifyAddress(name, '192.168.5.5'), name).toBe('vpn');
    }
  });

  it('recognises VPN addresses by range (Hamachi 25/8 and 5/8, CGNAT 100.64/10)', () => {
    expect(classifyAddress('Ethernet', '25.12.34.56')).toBe('vpn');
    expect(classifyAddress('Ethernet', '5.1.2.3')).toBe('vpn');
    expect(classifyAddress('Ethernet', '100.100.1.2')).toBe('vpn');
  });

  it('classifies private ranges as lan and everything else as other', () => {
    expect(classifyAddress('Ethernet', '10.0.0.7')).toBe('lan');
    expect(classifyAddress('Wi-Fi', '172.20.3.4')).toBe('lan');
    expect(classifyAddress('Wi-Fi', '192.168.0.12')).toBe('lan');
    expect(classifyAddress('Ethernet', '172.32.0.1')).toBe('other');
    expect(classifyAddress('Ethernet', '203.0.113.9')).toBe('other');
  });

  it('classifies virtual-machine and container adapters as other even in private ranges', () => {
    for (const [name, address] of [
      ['vEthernet (WSL (Hyper-V firewall))', '172.26.80.1'],
      ['vEthernet (Default Switch)', '172.20.144.1'],
      ['VirtualBox Host-Only Network', '192.168.56.1'],
      ['VMware Network Adapter VMnet8', '192.168.137.1'],
      ['vmnet1', '172.16.5.1'],
      ['docker0', '172.17.0.1'],
      ['br-fccb4b9262d5', '172.18.0.1'],
      ['veth1a2b3c', '10.0.3.1'],
      ['Npcap Loopback Adapter', '169.254.1.1'],
      ['Bluetooth Network Connection', '192.168.44.1'],
    ] as const) {
      expect(classifyAddress(name, address), name).toBe('other');
    }
    // VirtualBox's host-only range is virtual whatever the adapter is called.
    expect(classifyAddress('Ethernet 2', '192.168.56.1')).toBe('other');
    // A VPN adapter wins over the virtual rule; a real NIC in a neighbouring 192.168 range stays lan.
    expect(classifyAddress('vEthernet (tailscale)', '100.100.1.2')).toBe('vpn');
    expect(classifyAddress('Wi-Fi', '192.168.57.1')).toBe('lan');
  });
});

describe('listAddresses', () => {
  const ifaces = {
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    Ethernet: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1234', family: 'IPv6', internal: false },
      { address: '2001:db8::5', family: 'IPv6', internal: false },
    ],
    'vEthernet (WSL)': [{ address: '172.28.0.1', family: 'IPv4', internal: false }],
    Hamachi: [{ address: '25.34.56.78', family: 'IPv4', internal: false }],
    Public: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    wt0: [{ address: '100.90.1.2', family: 4, internal: false }],
    Missing: undefined,
  };

  it('lists only non-internal IPv4 addresses, with adapter name and kind, ordered vpn → lan → other', () => {
    const list = listAddresses(ifaces);
    expect(list).toEqual([
      { address: '25.34.56.78', adapter: 'Hamachi', kind: 'vpn' },
      { address: '100.90.1.2', adapter: 'wt0', kind: 'vpn' },
      { address: '192.168.1.20', adapter: 'Ethernet', kind: 'lan' },
      // The WSL adapter is virtual: `other`, after the lan address, in enumeration order among the others.
      { address: '172.28.0.1', adapter: 'vEthernet (WSL)', kind: 'other' },
      { address: '203.0.113.9', adapter: 'Public', kind: 'other' },
    ]);
    expect(list.some((a) => a.address.includes(':'))).toBe(false);
    expect(list.some((a) => a.address === '127.0.0.1')).toBe(false);
  });

  it('deduplicates an address reported twice', () => {
    const list = listAddresses({
      a: [{ address: '10.1.1.1', family: 'IPv4', internal: false }],
      b: [{ address: '10.1.1.1', family: 'IPv4', internal: false }],
    });
    expect(list).toHaveLength(1);
  });

  it('returns an empty list when nothing is connected', () => {
    expect(listAddresses({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toEqual([]);
  });
});

describe('pickAddress', () => {
  const list = listAddresses({
    Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    Hamachi: [{ address: '25.34.56.78', family: 'IPv4', internal: false }],
    Public: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
  });

  it('prefers the saved address when it is still present', () => {
    expect(pickAddress(list, '192.168.1.20')).toBe('192.168.1.20');
  });

  it('falls back to the first vpn, then the first lan, then anything', () => {
    expect(pickAddress(list, '10.9.9.9')).toBe('25.34.56.78');
    expect(pickAddress(list, null)).toBe('25.34.56.78');
    expect(pickAddress(list.filter((a) => a.kind !== 'vpn'), null)).toBe('192.168.1.20');
    expect(pickAddress(list.filter((a) => a.kind === 'other'), null)).toBe('203.0.113.9');
    expect(pickAddress([], null)).toBeNull();
  });

  it('never defaults to a virtual adapter enumerated before the real NIC', () => {
    const windowsHost = listAddresses({
      'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.26.80.1', family: 'IPv4', internal: false }],
      'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    });
    expect(windowsHost.map((a) => a.address)).toEqual(['192.168.1.20', '172.26.80.1']);
    expect(pickAddress(windowsHost, null)).toBe('192.168.1.20');
    // ...but the host may still pick it on purpose.
    expect(pickAddress(windowsHost, '172.26.80.1')).toBe('172.26.80.1');
  });
});
