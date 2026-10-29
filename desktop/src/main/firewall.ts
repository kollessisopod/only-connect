/**
 * "Allow through Windows Firewall" (docs/DESKTOP.md §6.3 item 5): an inbound TCP rule for the server port,
 * added by netsh started elevated through PowerShell (one UAC prompt). Windows only.
 */
import { spawn } from 'node:child_process';

export const FIREWALL_RULE_NAME = 'Only Connect';

/** The netsh arguments (no user input besides the validated port). */
export function netshArguments(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return `advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${port}`;
}

/** Win32 ERROR_CANCELLED: the UAC prompt was declined (Start-Process then throws "The operation was canceled by the user"). */
export const EXIT_CANCELLED = 1223;

/**
 * The PowerShell command that runs netsh elevated and exits with its exit code. A declined UAC prompt makes
 * Start-Process throw; without `$ErrorActionPreference = 'Stop'` + try/catch the script would carry on with
 * `$p` unset and `exit $null` would report success (exit code 0), so the failure is made terminating and
 * mapped to EXIT_CANCELLED, as is a missing process object.
 */
export function powershellCommand(port: number): string {
  const start = `Start-Process -FilePath netsh -ArgumentList '${netshArguments(port)}' -Verb RunAs -Wait -PassThru`;
  return `$ErrorActionPreference = 'Stop'; try { $p = ${start}; if ($null -eq $p) { exit ${EXIT_CANCELLED} }; exit $p.ExitCode } catch { exit ${EXIT_CANCELLED} }`;
}

/** Turns PowerShell's exit code and stderr into the message shown in the window. */
export function interpretExit(code: number | null, stderr: string, port: number): { ok: boolean; message: string } {
  if (code === 0) return { ok: true, message: `Rule "${FIREWALL_RULE_NAME}" added: inbound TCP port ${port} is allowed.` };
  if (code === EXIT_CANCELLED || /cancel/i.test(stderr)) return { ok: false, message: 'The administrator prompt was declined; no rule was added.' };
  const detail = stderr.trim().split(/\r?\n/)[0] ?? '';
  return { ok: false, message: `netsh exited with code ${code ?? '?'}${detail ? `: ${detail}` : ''}` };
}

export async function allowFirewall(port: number, platform: NodeJS.Platform = process.platform): Promise<{ ok: boolean; message: string }> {
  if (platform !== 'win32') return { ok: false, message: 'Only available on Windows.' };
  let command: string;
  try {
    command = powershellCommand(port);
  } catch {
    return { ok: false, message: 'The port is not valid.' };
  }
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      done({ ok: false, message: `Could not start PowerShell: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => done({ ok: false, message: `Could not start PowerShell: ${err.message}` }));
    child.on('close', (code) => done(interpretExit(code, stderr, port)));
    setTimeout(() => done({ ok: false, message: 'Timed out waiting for the administrator prompt.' }), 120_000).unref();
  });
}
