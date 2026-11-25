import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { analyzeProject, executeRealTests } from '../engineering/engineerService.js';
import { eventBus } from '../events/eventBus.js';
import { logAudit } from '../logging/logger.js';
import { collectSystemTelemetry, shouldThrottleBackgroundWork } from '../monitoring/systemMonitor.js';

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  triggerType: 'interval' | 'event' | 'manual';
  intervalSeconds: number | null;
  eventName: string | null;
  actionType: string;
  actionPayload: Record<string, unknown>;
  enabled: boolean;
  requiresApproval: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  runCount: number;
  createdAt: string;
}

let schedulerTimer: NodeJS.Timeout | null = null;
const runningAutomations = new Set<string>();

export function seedDefaultAutomations(): void {
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) as c FROM automations').get() as { c: number };
  if (countRow.c > 0) return;

  const now = new Date().toISOString();
  const defaults = [
    {
      id: 'auto-health-check',
      name: 'System Resource & RAM Watchdog',
      description: 'Collects real CPU/RAM/Disk telemetry and raises alerts if 8GB thresholds are exceeded.',
      triggerType: 'interval',
      intervalSeconds: 300,
      actionType: 'system_health_report',
      actionPayload: {},
      enabled: 1,
    },
    {
      id: 'auto-project-guardian',
      name: 'Continuous Project Guardian Scan',
      description: 'Incrementally inspects authorized workspace projects for git/dependency health.',
      triggerType: 'interval',
      intervalSeconds: 900,
      actionType: 'project_guardian_scan',
      actionPayload: { subDir: '.' },
      enabled: 0,
    },
  ];

  for (const a of defaults) {
    db.prepare(
      `INSERT INTO automations (id, name, description, trigger_type, interval_seconds, action_type, action_payload_json, enabled, requires_approval, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      a.id,
      a.name,
      a.description,
      a.triggerType,
      a.intervalSeconds,
      a.actionType,
      JSON.stringify(a.actionPayload),
      a.enabled,
      new Date(Date.now() + a.intervalSeconds * 1000).toISOString(),
      now
    );
  }
}

export function listAutomations(): AutomationRule[] {
  seedDefaultAutomations();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    triggerType: r.trigger_type as AutomationRule['triggerType'],
    intervalSeconds: r.interval_seconds ? Number(r.interval_seconds) : null,
    eventName: r.event_name ? String(r.event_name) : null,
    actionType: String(r.action_type),
    actionPayload: JSON.parse(String(r.action_payload_json || '{}')),
    enabled: Boolean(r.enabled),
    requiresApproval: Boolean(r.requires_approval),
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    lastStatus: r.last_status ? String(r.last_status) : null,
    runCount: Number(r.run_count || 0),
    createdAt: String(r.created_at),
  }));
}

export function createAutomation(input: {
  name: string;
  description: string;
  triggerType: 'interval' | 'event' | 'manual';
  intervalSeconds?: number | null;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  enabled?: boolean;
}): AutomationRule {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const interval = input.triggerType === 'interval' ? Math.max(30, input.intervalSeconds || 300) : null;
  const nextRun = interval ? new Date(Date.now() + interval * 1000).toISOString() : null;

  db.prepare(
    `INSERT INTO automations (id, name, description, trigger_type, interval_seconds, action_type, action_payload_json, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.description,
    input.triggerType,
    interval,
    input.actionType,
    JSON.stringify(input.actionPayload || {}),
    input.enabled !== false ? 1 : 0,
    nextRun,
    now
  );

  return listAutomations().find((a) => a.id === id)!;
}

export function toggleAutomation(id: string, enabled: boolean): AutomationRule | null {
  const db = getDb();
  db.prepare('UPDATE automations SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return listAutomations().find((a) => a.id === id) || null;
}

export async function runAutomationNow(id: string): Promise<{
  status: 'completed' | 'skipped' | 'failed';
  summary: string;
}> {
  if (runningAutomations.has(id)) {
    return { status: 'skipped', summary: 'Prevented duplicate concurrent automation run.' };
  }

  const rule = listAutomations().find((a) => a.id === id);
  if (!rule) throw new Error('Automation not found');

  runningAutomations.add(id);
  const start = Date.now();
  const db = getDb();

  try {
    const telemetry = await collectSystemTelemetry(false);
    const gov = shouldThrottleBackgroundWork(telemetry);
    if (gov.throttle && rule.actionType !== 'system_health_report') {
      return { status: 'skipped', summary: gov.reason || 'Throttled due to resource pressure' };
    }

    let summary = '';
    if (rule.actionType === 'system_health_report') {
      summary = `RAM ${telemetry.memory.usagePercent}% (${telemetry.memory.pressure}), CPU ${telemetry.cpu.usagePercent}%, Disk ${telemetry.disk.usagePercent}%`;
    } else if (rule.actionType === 'project_guardian_scan') {
      const subDir = typeof rule.actionPayload.subDir === 'string' ? rule.actionPayload.subDir : '.';
      const analysis = await analyzeProject(subDir);
      summary = `Guardian scanned ${analysis.name} (${analysis.language}/${analysis.framework}): ${analysis.fileCount} files, branch ${analysis.gitBranch || 'n/a'}`;
    } else if (rule.actionType === 'typecheck_guardian') {
      const res = await executeRealTests({ suite: 'typecheck' });
      summary = `Typecheck ${res.status} (${res.durationMs}ms)`;
    } else {
      summary = `Executed action ${rule.actionType}`;
    }

    const now = new Date().toISOString();
    const nextRun =
      rule.triggerType === 'interval' && rule.intervalSeconds
        ? new Date(Date.now() + rule.intervalSeconds * 1000).toISOString()
        : null;

    db.prepare(
      'UPDATE automations SET last_run_at = ?, next_run_at = ?, last_status = ?, run_count = run_count + 1 WHERE id = ?'
    ).run(now, nextRun, 'completed', id);

    db.prepare(
      'INSERT INTO automation_runs (id, automation_id, status, summary, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), id, 'completed', summary, Date.now() - start, now);

    eventBus.emitEvent('automation_run', { id, name: rule.name, status: 'completed', summary });
    return { status: 'completed', summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Automation failed';
    const now = new Date().toISOString();
    db.prepare('UPDATE automations SET last_run_at = ?, last_status = ? WHERE id = ?').run(
      now,
      'failed',
      id
    );
    db.prepare(
      'INSERT INTO automation_runs (id, automation_id, status, summary, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), id, 'failed', msg, Date.now() - start, now);
    logAudit('error', 'automation', 'run_failed', { id, msg });
    return { status: 'failed', summary: msg };
  } finally {
    runningAutomations.delete(id);
  }
}

export function startAutomationScheduler(): void {
  if (schedulerTimer) return;
  seedDefaultAutomations();
  schedulerTimer = setInterval(() => {
    const now = new Date().toISOString();
    const rules = listAutomations().filter(
      (r) => r.enabled && r.triggerType === 'interval' && (!r.nextRunAt || r.nextRunAt <= now)
    );
    for (const rule of rules) {
      void runAutomationNow(rule.id);
    }
  }, 30_000);
}

export function stopAutomationScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
