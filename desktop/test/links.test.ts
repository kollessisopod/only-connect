import { describe, expect, it } from 'vitest';
import { baseUrl, buildLinks, invitation } from '../src/shared/links';
import { listAddresses } from '../src/main/addresses';

describe('link building', () => {
  it('omits the port when it is 80', () => {
    expect(baseUrl('25.1.2.3', 80)).toBe('http://25.1.2.3');
    expect(buildLinks('25.1.2.3', 80)).toEqual({
      admin: 'http://25.1.2.3/admin',
      monitor: 'http://25.1.2.3/monitor',
      wall: 'http://25.1.2.3/wall',
      button: 'http://25.1.2.3/button',
    });
  });

  it('includes any other port', () => {
    expect(buildLinks('192.168.1.20', 8080).admin).toBe('http://192.168.1.20:8080/admin');
    expect(buildLinks('localhost', 8089).button).toBe('http://localhost:8089/button');
  });

  it('builds the one-line invitation around the buzzer link', () => {
    expect(invitation(buildLinks('25.1.2.3', 80).button)).toBe('Join the quiz: http://25.1.2.3/button');
  });

  it('never builds links from IPv6 addresses (they are not listed)', () => {
    const list = listAddresses({
      Ethernet: [
        { address: 'fe80::abcd', family: 'IPv6', internal: false },
        { address: '2001:db8::1', family: 'IPv6', internal: false },
      ],
    });
    expect(list).toEqual([]);
  });
});
