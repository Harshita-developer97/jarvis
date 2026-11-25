import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config/index.js';
import type { RiskLevel } from '../types.js';

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /sk-[0-9A-Za-z_-]{20,}/g,
  /ghp_[0-9A-Za-z]{20,}/g,
  /github_pat_[0-9A-Za-z_]{20,}/g,
  /xox[baprs]-[0-9A-Za-z-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /(password|passwd|secret|api_key|apikey|token|private_key)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith('bearer ')) {
        return 'Bearer [REDACTED]';
      }
      const eqIdx = match.search(/[:=]/);
      if (eqIdx !== -1) {
        return `${match.slice(0, eqIdx + 1)} [REDACTED]`;
      }
      return '[REDACTED_SECRET]';
    });
  }
  return output;
}

export function containsSensitiveCredential(input: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(input);
  });
}

export function resolveSafeWorkspacePath(
  targetPath: string,
  baseDir: string = config.workspaceRoot
): string {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Invalid file path');
  }
  if (targetPath.includes('\0')) {
    throw new Error('Null byte in path is forbidden');
  }
  const normalizedBase = path.resolve(baseDir);
  const resolved = path.resolve(normalizedBase, targetPath);

  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Access denied: path "${targetPath}" escapes authorized workspace`);
  }

  // Prevent reading/writing sensitive internal DB or env secrets arbitrarily via generic tools
  const rel = path.relative(normalizedBase, resolved).replace(/\\/g, '/');
  if (rel === '.env' || rel.startsWith('.env.')) {
    throw new Error('Access denied: .env files are protected');
  }
  return resolved;
}

function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateOrLoopbackIPv4(v4);
  }
  return false;
}

export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol "${parsed.protocol}" — only http/https allowed`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error(`Blocked restricted host "${hostname}"`);
  }

  const ipType = net.isIP(hostname);
  if (ipType === 4 && isPrivateOrLoopbackIPv4(hostname)) {
    throw new Error(`Blocked private/loopback IPv4 address "${hostname}"`);
  }
  if (ipType === 6 && isPrivateOrLoopbackIPv6(hostname)) {
    throw new Error(`Blocked private/loopback IPv6 address "${hostname}"`);
  }

  return parsed;
}

const ALLOWED_COMMAND_BINARIES = new Set([
  'node',
  'npm',
  'npx',
  'git',
  'python3',
  'python',
  'vitest',
  'tsc',
  'df',
  'ps',
  'uname',
  'sqlite3',
]);

const FORBIDDEN_CMD_ARGS = [
  '--force',
  'rm',
  'mkfs',
  'dd',
  'shutdown',
  'reboot',
  'format',
  'del',
];

export function validateSafeCommand(
  binary: string,
  args: string[]
): { binary: string; args: string[]; risk: RiskLevel } {
  const baseBin = path.basename(binary);
  if (!ALLOWED_COMMAND_BINARIES.has(baseBin)) {
    throw new Error(
      `Command "${baseBin}" is not in the authorized safe command allowlist`
    );
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.includes('&&') || arg.includes('||') || arg.includes(';') || arg.includes('`')) {
      throw new Error(`Unsafe shell metacharacter in argument "${arg}"`);
    }
    if (FORBIDDEN_CMD_ARGS.includes(arg.toLowerCase())) {
      throw new Error(`Restricted destructive argument "${arg}" blocked`);
    }
  }

  // Classify risk
  let risk: RiskLevel = 'LOW';
  if (baseBin === 'npm' || baseBin === 'npx' || baseBin === 'vitest') {
    risk = args[0] === 'install' ? 'HIGH' : 'MEDIUM';
  } else if (baseBin === 'git') {
    const sub = args[0] || '';
    if (['status', 'log', 'diff', 'branch', 'show'].includes(sub)) {
      risk = 'LOW';
    } else if (['add', 'commit', 'checkout', 'stash'].includes(sub)) {
      risk = 'MEDIUM';
    } else {
      risk = 'HIGH';
    }
  } else if (baseBin === 'node' || baseBin === 'python3' || baseBin === 'python') {
    risk = 'HIGH';
  }

  return { binary: baseBin, args, risk };
}

export function hashSecret(secret: string, salt?: string): string {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, actualSalt, 64).toString('hex');
  return `${actualSalt}:${derived}`;
}

export function verifySecret(secret: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(secret, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function generateSecureToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}
