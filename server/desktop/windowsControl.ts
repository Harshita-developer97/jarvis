import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';
import { collectSystemTelemetry } from '../monitoring/systemMonitor.js';
import type { DesktopActionResult } from '../types.js';

const execFileAsync = promisify(execFile);

const AUTHORIZED_WINDOWS_APPS: Record<string, string> = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  calculator: 'calc.exe',
  explorer: 'explorer.exe',
  vscode: 'code',
  terminal: 'wt.exe',
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
};

async function runPowerShell(
  script: string,
  extraEnv?: Record<string, string>,
  timeoutMs = 8000
): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: timeoutMs,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }
  );
  return stdout.trim();
}

export async function getDesktopCapabilities(): Promise<{
  platform: string;
  isWindows11: boolean;
  nativeGuiAvailable: boolean;
  supportedActions: string[];
  blockedReason: string | null;
}> {
  const isWin = process.platform === 'win32';
  const hasX11 = Boolean(process.env.DISPLAY);
  return {
    platform: process.platform,
    isWindows11: isWin,
    nativeGuiAvailable: isWin || hasX11,
    supportedActions: isWin
      ? [
          'list_windows',
          'get_active_window',
          'focus_window',
          'launch_app',
          'close_app',
          'get_clipboard',
          'set_clipboard',
          'capture_screenshot',
          'windows_diagnostics',
          'list_processes',
        ]
      : ['list_processes', 'check_capabilities'],
    blockedReason: isWin
      ? null
      : `Current host is ${process.platform} without Windows GUI APIs; native window/clipboard/screenshot actions require Windows 11.`,
  };
}

export async function executeDesktopAction(input: {
  action:
    | 'check_capabilities'
    | 'list_processes'
    | 'list_windows'
    | 'get_active_window'
    | 'focus_window'
    | 'launch_app'
    | 'close_app'
    | 'get_clipboard'
    | 'set_clipboard'
    | 'capture_screenshot'
    | 'windows_diagnostics';
  target?: string;
  text?: string;
}): Promise<DesktopActionResult> {
  if (input.action === 'check_capabilities') {
    const caps = await getDesktopCapabilities();
    return {
      available: true,
      platform: process.platform,
      action: input.action,
      verified: true,
      data: caps,
    };
  }

  if (input.action === 'list_processes') {
    const telemetry = await collectSystemTelemetry(false);
    return {
      available: true,
      platform: process.platform,
      action: input.action,
      verified: true,
      data: { processes: telemetry.processes },
    };
  }

  if (process.platform !== 'win32') {
    return {
      available: false,
      platform: process.platform,
      action: input.action,
      verified: false,
      unavailableReason: `Action "${input.action}" requires Windows 11 host OS (current host: ${process.platform}).`,
    };
  }

  try {
    switch (input.action) {
      case 'list_windows': {
        const out = await runPowerShell(
          'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress'
        );
        const parsed = JSON.parse(out || '[]');
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: Array.isArray(parsed) ? parsed : [parsed],
        };
      }

      case 'get_active_window': {
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [WinApi]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][WinApi]::GetWindowText($h, $sb, $sb.Capacity)
$sb.ToString()`;
        const title = await runPowerShell(script);
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: { activeWindowTitle: title },
        };
      }

      case 'focus_window': {
        const target = (input.target || '').trim();
        if (!target) throw new Error('Target window/process name required');
        const script =
          'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
          '$p = Get-Process | Where-Object { $_.ProcessName -like "*$($env:JARVIS_TARGET)*" -or $_.MainWindowTitle -like "*$($env:JARVIS_TARGET)*" } | Select-Object -First 1; ' +
          'if ($p) { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id); $p.MainWindowTitle } else { throw "Window not found" }';
        const focusedTitle = await runPowerShell(script, { JARVIS_TARGET: target });
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: Boolean(focusedTitle),
          data: { focusedTitle },
        };
      }

      case 'launch_app': {
        const key = (input.target || '').toLowerCase().trim();
        const exe = AUTHORIZED_WINDOWS_APPS[key];
        if (!exe) {
          throw new Error(
            `Application "${input.target}" is not in the authorized app allowlist (${Object.keys(
              AUTHORIZED_WINDOWS_APPS
            ).join(', ')})`
          );
        }
        await runPowerShell('Start-Process -FilePath $env:JARVIS_APP_EXE', { JARVIS_APP_EXE: exe });
        logAudit('security', 'computer_control', 'app_launched', { app: exe });
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: { launched: exe },
        };
      }

      case 'close_app': {
        const key = (input.target || '').toLowerCase().trim();
        const exe = AUTHORIZED_WINDOWS_APPS[key];
        if (!exe) {
          throw new Error(`Application "${input.target}" is not in the authorized close allowlist`);
        }
        const procName = exe.replace(/\.exe$/i, '');
        await runPowerShell(
          'Stop-Process -Name $env:JARVIS_PROC -ErrorAction Stop',
          { JARVIS_PROC: procName }
        );
        logAudit('security', 'computer_control', 'app_closed', { procName });
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: { closed: procName },
        };
      }

      case 'get_clipboard': {
        const clip = await runPowerShell('Get-Clipboard -Raw');
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: { text: clip },
        };
      }

      case 'set_clipboard': {
        await runPowerShell('Set-Clipboard -Value $env:JARVIS_CLIP', {
          JARVIS_CLIP: input.text || '',
        });
        const verify = await runPowerShell('Get-Clipboard -Raw');
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: verify === (input.text || ''),
          data: { length: verify.length },
        };
      }

      case 'capture_screenshot': {
        const shotDir = path.join(config.dataDir, 'screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        const outFile = path.join(shotDir, `screen-${crypto.randomUUID().slice(0, 8)}.png`);
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($env:JARVIS_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`;
        await runPowerShell(script, { JARVIS_SHOT_PATH: outFile }, 12_000);
        const exists = fs.existsSync(outFile);
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: exists,
          data: { path: path.relative(config.workspaceRoot, outFile), exists },
        };
      }

      case 'windows_diagnostics': {
        const out = await runPowerShell(
          '$os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; ' +
            '@{ OsCaption=$os.Caption; FreeRamMB=[math]::Round($os.FreePhysicalMemory/1024,1); CpuLoad=$cpu.LoadPercentage } | ConvertTo-Json -Compress'
        );
        return {
          available: true,
          platform: 'win32',
          action: input.action,
          verified: true,
          data: JSON.parse(out || '{}'),
        };
      }
    }
  } catch (err) {
    return {
      available: true,
      platform: process.platform,
      action: input.action,
      verified: false,
      unavailableReason: err instanceof Error ? err.message : 'Desktop control error',
    };
  }
}

export async function getAutostartStatus(): Promise<{
  supported: boolean;
  enabled: boolean;
  reason?: string;
}> {
  const db = getDb();
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('autostart_enabled') as
    | { value_json: string }
    | undefined;
  const saved = row ? Boolean(JSON.parse(row.value_json)) : false;

  if (process.platform !== 'win32') {
    return {
      supported: false,
      enabled: saved,
      reason: 'Windows startup registry integration activates when running on Windows 11.',
    };
  }
  return { supported: true, enabled: saved };
}

export async function setAutostartEnabled(enabled: boolean): Promise<{
  ok: boolean;
  enabled: boolean;
  appliedToOs: boolean;
  message: string;
}> {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('autostart_enabled', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(enabled), new Date().toISOString());

  if (process.platform !== 'win32') {
    return {
      ok: true,
      enabled,
      appliedToOs: false,
      message: 'Preference saved in SQLite. Windows startup shortcut applies when run on Windows 11.',
    };
  }

  try {
    const launcher = path.join(config.workspaceRoot, 'scripts', 'windows', 'start-jarvis.bat');
    if (enabled) {
      await runPowerShell(
        'Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "JARVIS" -Value $env:JARVIS_CMD',
        { JARVIS_CMD: `"${launcher}"` }
      );
    } else {
      await runPowerShell(
        'Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "JARVIS" -ErrorAction SilentlyContinue'
      );
    }
    logAudit('info', 'desktop', 'autostart_updated', { enabled });
    return {
      ok: true,
      enabled,
      appliedToOs: true,
      message: enabled ? 'JARVIS added to Windows 11 startup.' : 'JARVIS removed from Windows 11 startup.',
    };
  } catch (err) {
    return {
      ok: false,
      enabled,
      appliedToOs: false,
      message: err instanceof Error ? err.message : 'Failed to update Windows startup key',
    };
  }
}
