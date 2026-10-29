import { describe, expect, it } from 'vitest';
import { EXIT_CANCELLED, FIREWALL_RULE_NAME, allowFirewall, interpretExit, netshArguments, powershellCommand } from '../src/main/firewall';

describe('netshArguments', () => {
  it('builds the inbound TCP rule for the port and refuses invalid ports', () => {
    expect(netshArguments(80)).toBe(`advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=80`);
    for (const bad of [0, 65536, 1.5, NaN]) expect(() => netshArguments(bad), String(bad)).toThrow('invalid port');
  });
});

describe('powershellCommand', () => {
  const cmd = powershellCommand(8080);

  it('starts netsh elevated and waits for it', () => {
    expect(cmd).toContain("Start-Process -FilePath netsh -ArgumentList 'advfirewall firewall add rule");
    expect(cmd).toContain('localport=8080');
    expect(cmd).toContain('-Verb RunAs -Wait -PassThru');
    expect(cmd).toContain('exit $p.ExitCode');
  });

  it('turns a declined UAC prompt into a non-zero exit instead of falling through to exit 0', () => {
    // Start-Process throws a non-terminating error when the prompt is declined; the script must stop there.
    expect(cmd).toMatch(/^\$ErrorActionPreference = 'Stop'; try \{ \$p = Start-Process /);
    expect(cmd).toContain(`if ($null -eq $p) { exit ${EXIT_CANCELLED} }`);
    expect(cmd).toContain(`} catch { exit ${EXIT_CANCELLED} }`);
  });
});

describe('interpretExit', () => {
  it('reports success only for exit code 0', () => {
    expect(interpretExit(0, '', 80)).toEqual({ ok: true, message: `Rule "${FIREWALL_RULE_NAME}" added: inbound TCP port 80 is allowed.` });
  });

  it('recognises a declined prompt by exit code 1223 or by the cancel message', () => {
    expect(interpretExit(EXIT_CANCELLED, '', 80)).toMatchObject({ ok: false, message: expect.stringContaining('declined') });
    expect(interpretExit(1, 'This command cannot be run due to the error: The operation was canceled by the user.', 80)).toMatchObject({
      ok: false,
      message: expect.stringContaining('declined'),
    });
  });

  it('shows the exit code and the first stderr line otherwise', () => {
    expect(interpretExit(1, 'The requested operation requires elevation.\r\nmore', 80)).toEqual({
      ok: false,
      message: 'netsh exited with code 1: The requested operation requires elevation.',
    });
    expect(interpretExit(null, '', 80)).toEqual({ ok: false, message: 'netsh exited with code ?' });
  });
});

describe('allowFirewall', () => {
  it('is Windows only', async () => {
    expect(await allowFirewall(80, 'linux')).toEqual({ ok: false, message: 'Only available on Windows.' });
  });
});
