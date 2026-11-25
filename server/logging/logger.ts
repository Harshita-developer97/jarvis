import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { redactSecrets } from '../security/guard.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'security';

export interface AuditEntry {
  id: string;
  level: LogLevel;
  subsystem: string;
  action: string;
  details: string;
  createdAt: string;
}

export function logAudit(
  level: LogLevel,
  subsystem: string,
  action: string,
  details: unknown
): AuditEntry {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const rawDetails =
    typeof details === 'string' ? details : JSON.stringify(details ?? {});
  const safeDetails = redactSecrets(rawDetails).slice(0, 4000);

  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO audit_logs (id, level, subsystem, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, level, subsystem, action, safeDetails, createdAt);
  } catch {
    // Fallback to stderr if DB is unavailable during early boot
    console.error(`[${createdAt}] [${level}] [${subsystem}] ${action}: ${safeDetails}`);
  }

  return { id, level, subsystem, action, details: safeDetails, createdAt };
}

export function getAuditLogs(limit = 100, level?: string): AuditEntry[] {
  const db = getDb();
  const capped = Math.min(Math.max(1, limit), 500);
  if (level && ['info', 'warn', 'error', 'security'].includes(level)) {
    return db
      .prepare(
        'SELECT id, level, subsystem, action, details, created_at as createdAt FROM audit_logs WHERE level = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(level, capped) as unknown as AuditEntry[];
  }
  return db
    .prepare(
      'SELECT id, level, subsystem, action, details, created_at as createdAt FROM audit_logs ORDER BY created_at DESC LIMIT ?'
    )
    .all(capped) as unknown as AuditEntry[];
}
