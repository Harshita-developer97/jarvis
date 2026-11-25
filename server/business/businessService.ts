import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';

export interface BusinessRecord {
  id: string;
  domain: 'sales' | 'marketing' | 'finance' | 'hr' | 'operations';
  recordType: string;
  title: string;
  status: string;
  amount: number | null;
  currency: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProductivityItem {
  id: string;
  itemType: 'task' | 'reminder' | 'event' | 'note' | 'goal';
  title: string;
  details: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'done';
  dueAt: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerAbsenceConfig {
  enabled: boolean;
  allowedActions: string[];
  restrictedActions: string[];
  spendingLimitUsd: number;
  maxDurationHours: number;
  activatedAt: string | null;
  emergencyStopped: boolean;
}

export function createBusinessRecord(input: {
  domain: BusinessRecord['domain'];
  recordType: string;
  title: string;
  status?: string;
  amount?: number | null;
  currency?: string;
  metadata?: Record<string, unknown>;
}): BusinessRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = input.status || 'active';
  const currency = input.currency || 'USD';
  const metadata = input.metadata || {};

  db.prepare(
    `INSERT INTO business_records (id, domain, record_type, title, status, amount, currency, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.domain,
    input.recordType,
    input.title,
    status,
    input.amount ?? null,
    currency,
    JSON.stringify(metadata),
    now,
    now
  );

  logAudit('info', 'business_manager', 'record_created', {
    id,
    domain: input.domain,
    title: input.title,
  });

  return {
    id,
    domain: input.domain,
    recordType: input.recordType,
    title: input.title,
    status,
    amount: input.amount ?? null,
    currency,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}

export function listBusinessRecords(domain?: string): BusinessRecord[] {
  const db = getDb();
  const rows =
    domain && domain !== 'all'
      ? (db
          .prepare('SELECT * FROM business_records WHERE domain = ? ORDER BY updated_at DESC LIMIT 200')
          .all(domain) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM business_records ORDER BY updated_at DESC LIMIT 200')
          .all() as Array<Record<string, unknown>>);

  return rows.map((r) => ({
    id: String(r.id),
    domain: r.domain as BusinessRecord['domain'],
    recordType: String(r.record_type),
    title: String(r.title),
    status: String(r.status),
    amount: r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
    currency: String(r.currency || 'USD'),
    metadata: JSON.parse(String(r.metadata_json || '{}')),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function getBusinessSummary(): {
  totalRecords: number;
  salesPipelineValue: number;
  activeLeads: number;
  recordedRevenue: number;
  recordedExpenses: number;
  netCashFlow: number;
  hrCandidates: number;
  campaignsCount: number;
} {
  const records = listBusinessRecords();
  let salesPipelineValue = 0;
  let activeLeads = 0;
  let recordedRevenue = 0;
  let recordedExpenses = 0;
  let hrCandidates = 0;
  let campaignsCount = 0;

  for (const r of records) {
    if (r.domain === 'sales') {
      if (r.status !== 'closed_lost') {
        activeLeads++;
        salesPipelineValue += r.amount || 0;
      }
    } else if (r.domain === 'finance') {
      if (r.recordType === 'revenue' || r.recordType === 'invoice_paid') {
        recordedRevenue += r.amount || 0;
      } else if (r.recordType === 'expense') {
        recordedExpenses += r.amount || 0;
      }
    } else if (r.domain === 'hr') {
      hrCandidates++;
    } else if (r.domain === 'marketing') {
      campaignsCount++;
    }
  }

  return {
    totalRecords: records.length,
    salesPipelineValue: Math.round(salesPipelineValue * 100) / 100,
    activeLeads,
    recordedRevenue: Math.round(recordedRevenue * 100) / 100,
    recordedExpenses: Math.round(recordedExpenses * 100) / 100,
    netCashFlow: Math.round((recordedRevenue - recordedExpenses) * 100) / 100,
    hrCandidates,
    campaignsCount,
  };
}

export function createProductivityItem(input: {
  itemType: ProductivityItem['itemType'];
  title: string;
  details?: string;
  priority?: ProductivityItem['priority'];
  dueAt?: string | null;
  projectId?: string | null;
}): ProductivityItem {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const priority = input.priority || 'medium';

  db.prepare(
    `INSERT INTO productivity_items (id, item_type, title, details, priority, status, due_at, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(
    id,
    input.itemType,
    input.title,
    input.details || null,
    priority,
    input.dueAt || null,
    input.projectId || null,
    now,
    now
  );

  return {
    id,
    itemType: input.itemType,
    title: input.title,
    details: input.details || null,
    priority,
    status: 'open',
    dueAt: input.dueAt || null,
    projectId: input.projectId || null,
    createdAt: now,
    updatedAt: now,
  };
}

export function listProductivityItems(itemType?: string): {
  items: ProductivityItem[];
  overdueCount: number;
  upcoming24hCount: number;
} {
  const db = getDb();
  const rows =
    itemType && itemType !== 'all'
      ? (db
          .prepare('SELECT * FROM productivity_items WHERE item_type = ? ORDER BY created_at DESC LIMIT 200')
          .all(itemType) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM productivity_items ORDER BY created_at DESC LIMIT 200')
          .all() as Array<Record<string, unknown>>);

  const nowMs = Date.now();
  let overdueCount = 0;
  let upcoming24hCount = 0;

  const items: ProductivityItem[] = rows.map((r) => {
    const dueAt = r.due_at ? String(r.due_at) : null;
    const status = r.status as ProductivityItem['status'];
    if (dueAt && status !== 'done') {
      const dueMs = Date.parse(dueAt);
      if (dueMs < nowMs) overdueCount++;
      else if (dueMs - nowMs <= 86_400_000) upcoming24hCount++;
    }
    return {
      id: String(r.id),
      itemType: r.item_type as ProductivityItem['itemType'],
      title: String(r.title),
      details: r.details ? String(r.details) : null,
      priority: r.priority as ProductivityItem['priority'],
      status,
      dueAt,
      projectId: r.project_id ? String(r.project_id) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  });

  return { items, overdueCount, upcoming24hCount };
}

export function updateProductivityItemStatus(
  id: string,
  status: ProductivityItem['status']
): boolean {
  const db = getDb();
  const res = db
    .prepare('UPDATE productivity_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return Number(res.changes) > 0;
}

const DEFAULT_OWNER_ABSENCE: OwnerAbsenceConfig = {
  enabled: false,
  allowedActions: ['monitor_projects', 'run_tests', 'research', 'draft_reports', 'organize_crm'],
  restrictedActions: ['payments', 'contracts', 'delete_files', 'send_external_email'],
  spendingLimitUsd: 0,
  maxDurationHours: 8,
  activatedAt: null,
  emergencyStopped: false,
};

export function getOwnerAbsenceConfig(): OwnerAbsenceConfig {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get('owner_absence_mode') as { value_json: string } | undefined;
  if (!row) return { ...DEFAULT_OWNER_ABSENCE };
  try {
    return { ...DEFAULT_OWNER_ABSENCE, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_OWNER_ABSENCE };
  }
}

export function updateOwnerAbsenceConfig(patch: Partial<OwnerAbsenceConfig>): OwnerAbsenceConfig {
  const current = getOwnerAbsenceConfig();
  const next: OwnerAbsenceConfig = {
    ...current,
    ...patch,
    activatedAt:
      patch.enabled === true && !current.enabled
        ? new Date().toISOString()
        : patch.enabled === false
        ? null
        : current.activatedAt,
  };
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run('owner_absence_mode', JSON.stringify(next), new Date().toISOString());
  logAudit('security', 'owner_absence', 'config_updated', next);
  return next;
}

export interface DecisionAlternative {
  name: string;
  cost: number;
  timeHours: number;
  riskScore: number; // 1-10 (lower better)
  benefitScore: number; // 1-10 (higher better)
  reversible: boolean;
}

export function evaluateDecisionMatrix(
  objective: string,
  alternatives: DecisionAlternative[]
): {
  objective: string;
  ranked: Array<DecisionAlternative & { weightedScore: number }>;
  recommended: string;
  fallback: string | null;
  reasoningSummary: string;
} {
  if (alternatives.length === 0) {
    throw new Error('At least one alternative is required');
  }
  const maxCost = Math.max(1, ...alternatives.map((a) => a.cost));
  const maxTime = Math.max(1, ...alternatives.map((a) => a.timeHours));

  const ranked = alternatives
    .map((alt) => {
      const normCost = 1 - alt.cost / maxCost;
      const normTime = 1 - alt.timeHours / maxTime;
      const normRisk = 1 - alt.riskScore / 10;
      const normBenefit = alt.benefitScore / 10;
      const revBonus = alt.reversible ? 0.1 : 0;
      const weightedScore =
        Math.round((normBenefit * 0.4 + normRisk * 0.25 + normCost * 0.15 + normTime * 0.1 + revBonus) * 1000) /
        10;
      return { ...alt, weightedScore };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore);

  const best = ranked[0];
  const fallback = ranked[1]?.name || null;

  return {
    objective,
    ranked,
    recommended: best.name,
    fallback,
    reasoningSummary: `"${best.name}" scored ${best.weightedScore}/100 based on numerical cost ($${best.cost}), time (${best.timeHours}h), risk (${best.riskScore}/10), benefit (${best.benefitScore}/10), and reversibility (${best.reversible ? 'yes' : 'no'}).`,
  };
}

export function runDigitalTwinSimulation(input: {
  domain: string;
  scenarioName: string;
  assumptions: Record<string, number>;
}): {
  id: string;
  domain: string;
  scenarioName: string;
  isPrediction: true;
  predictedOutcome: string;
  metrics: Record<string, number>;
  riskScore: number;
  createdAt: string;
} {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const baselineCost = Number(input.assumptions.monthlyCost || 1000);
  const expectedLiftPct = Number(input.assumptions.expectedLiftPercent || 15);
  const complexity = Number(input.assumptions.complexityFactor || 1.2);

  const projectedGain = Math.round(baselineCost * (expectedLiftPct / 100) * 100) / 100;
  const estimatedRamMb = Math.round(256 * complexity);
  const riskScore = Math.min(10, Math.round(complexity * 3 * 10) / 10);

  const metrics = {
    projectedDeltaValue: projectedGain,
    estimatedMemoryOverheadMb: estimatedRamMb,
    failureRiskOutOf10: riskScore,
  };

  const predictedOutcome = `[SIMULATION PREDICTION — NOT ACTUAL RESULT] For "${input.scenarioName}" (${input.domain}): projected delta ${projectedGain}, estimated RAM impact ${estimatedRamMb} MB, risk ${riskScore}/10.`;

  const db = getDb();
  db.prepare(
    `INSERT INTO simulations (id, domain, scenario_name, assumptions_json, predicted_outcome, metrics_json, risk_score, is_prediction, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    input.domain,
    input.scenarioName,
    JSON.stringify(input.assumptions),
    predictedOutcome,
    JSON.stringify(metrics),
    riskScore,
    createdAt
  );

  return {
    id,
    domain: input.domain,
    scenarioName: input.scenarioName,
    isPrediction: true,
    predictedOutcome,
    metrics,
    riskScore,
    createdAt,
  };
}
