import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import type { SystemTelemetry } from '../types.js';

const execFileAsync = promisify(execFile);

let prevCpuTimes: { idle: number; total: number } | null = null;
let cachedRuntimes: SystemTelemetry['runtimes'] | null = null;
let lastRuntimeCheck = 0;

function sampleCpuPercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle, total };
    const load1m = os.loadavg()[0] || 0;
    return Math.min(100, Math.round((load1m / Math.max(1, cpus.length)) * 100));
  }

  const idleDiff = idle - prevCpuTimes.idle;
  const totalDiff = total - prevCpuTimes.total;
  prevCpuTimes = { idle, total };

  if (totalDiff <= 0) return 0;
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
}

async function execVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 2500 });
    const out = (stdout || stderr || '').trim().split('\n')[0]?.trim();
    return out || 'detected';
  } catch {
    return null;
  }
}

async function checkBinaryExists(cmd: string): Promise<boolean> {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(checker, [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function checkJsonEndpoint(url: string, requiredKey: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return data !== null && typeof data === 'object' && requiredKey in data;
  } catch {
    return false;
  }
}

export async function detectRuntimes(force = false): Promise<SystemTelemetry['runtimes']> {
  const now = Date.now();
  if (!force && cachedRuntimes && now - lastRuntimeCheck < 30_000) {
    return cachedRuntimes;
  }

  const [
    python,
    git,
    rustc,
    cargo,
    ollamaReachable,
    llamacppReachable,
    whisperBin,
    fasterWhisper,
    piperBin,
    chromiumBin,
    googleChromeBin,
  ] = await Promise.all([
    execVersion('python3', ['--version']).then((v) => v || execVersion('python', ['--version'])),
    execVersion('git', ['--version']),
    execVersion('rustc', ['--version']),
    execVersion('cargo', ['--version']),
    checkJsonEndpoint(`${config.ollamaBaseUrl}/api/tags`, 'models'),
    checkJsonEndpoint(`${config.llamacppBaseUrl}/v1/models`, 'data'),
    checkBinaryExists('whisper'),
    checkBinaryExists('faster-whisper'),
    checkBinaryExists('piper'),
    checkBinaryExists('chromium'),
    checkBinaryExists('google-chrome'),
  ]);

  let sqliteVer = 'node:sqlite';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const mem = new DatabaseSync(':memory:');
    const row = mem.prepare('SELECT sqlite_version() as v').get() as { v: string };
    sqliteVer = row?.v || 'node:sqlite';
    mem.close();
  } catch {
    sqliteVer = 'unavailable';
  }

  cachedRuntimes = {
    node: process.version,
    python,
    git,
    rustc,
    cargo,
    sqlite: sqliteVer,
    ollama: ollamaReachable,
    llamacpp: llamacppReachable,
    whisper: whisperBin || fasterWhisper,
    piper: piperBin,
    chromium: chromiumBin || googleChromeBin,
  };
  lastRuntimeCheck = now;
  return cachedRuntimes;
}

async function getDiskStats(): Promise<SystemTelemetry['disk']> {
  try {
    const stat = fs.statfsSync(config.workspaceRoot);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent,
      mount: config.workspaceRoot,
    };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0, mount: config.workspaceRoot };
  }
}

async function getTopProcesses(): Promise<SystemTelemetry['processes']> {
  if (process.platform === 'win32') {
    return [
      {
        pid: process.pid,
        name: 'jarvis-server (node)',
        cpuPercent: 0,
        memPercent: Math.round((process.memoryUsage().rss / os.totalmem()) * 1000) / 10,
      },
    ];
  }

  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%mem'],
      { timeout: 2000 }
    );
    const lines = stdout.trim().split('\n').slice(1, 11);
    return lines
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        return {
          pid: Number(parts[0]) || 0,
          name: parts[1] || 'unknown',
          cpuPercent: Number(parts[2]) || 0,
          memPercent: Number(parts[3]) || 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  } catch {
    return [];
  }
}

async function detectGpu(): Promise<SystemTelemetry['gpu']> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000 }
    );
    const line = stdout.trim().split('\n')[0];
    if (line) {
      const [name, vram] = line.split(',').map((s) => s.trim());
      return {
        detected: true,
        name: name || 'NVIDIA GPU',
        vramMb: Number(vram) || null,
      };
    }
  } catch {
    // No nvidia-smi
  }
  return { detected: false, name: null, vramMb: null };
}

export async function collectSystemTelemetry(includeDeepProbes = false): Promise<SystemTelemetry> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const memPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

  let pressure: 'normal' | 'elevated' | 'critical' = 'normal';
  if (memPct >= config.resourceLimits.criticalRamPercent) pressure = 'critical';
  else if (memPct >= config.resourceLimits.elevatedRamPercent) pressure = 'elevated';

  const cpus = os.cpus();
  const load = os.loadavg();
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => (addrs || []).some((a) => !a.internal))
    .map(([name]) => name);

  const [disk, processes, runtimes, gpu] = await Promise.all([
    getDiskStats(),
    getTopProcesses(),
    detectRuntimes(includeDeepProbes),
    includeDeepProbes ? detectGpu() : Promise.resolve({ detected: false, name: null, vramMb: null }),
  ]);

  return {
    timestamp: new Date().toISOString(),
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      isWindows11: os.platform() === 'win32' && os.release().startsWith('10.0.2'),
    },
    cpu: {
      model: cpus[0]?.model || 'Unknown CPU',
      cores: cpus.length,
      loadAvg1m: Math.round((load[0] || 0) * 100) / 100,
      loadAvg5m: Math.round((load[1] || 0) * 100) / 100,
      usagePercent: sampleCpuPercent(),
    },
    memory: {
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent: memPct,
      pressure,
      processRssBytes: process.memoryUsage().rss,
    },
    disk,
    gpu,
    network: {
      online: interfaces.length > 0,
      interfaces,
    },
    processes,
    runtimes,
  };
}

export function shouldThrottleBackgroundWork(telemetry: SystemTelemetry): {
  throttle: boolean;
  reason: string | null;
} {
  if (telemetry.memory.pressure === 'critical') {
    return {
      throttle: true,
      reason: `Critical RAM usage (${telemetry.memory.usagePercent}%). Pausing non-critical background agents.`,
    };
  }
  if (telemetry.cpu.usagePercent > config.resourceLimits.elevatedCpuPercent) {
    return {
      throttle: true,
      reason: `High CPU utilization (${telemetry.cpu.usagePercent}%). Deferring background tasks.`,
    };
  }
  return { throttle: false, reason: null };
}
