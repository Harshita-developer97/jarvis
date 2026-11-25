import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureRuntimeDirectories } from '../config/index.js';

let dbInstance: DatabaseSync | null = null;

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_core_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'auto',
          summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          intent TEXT,
          model_used TEXT,
          tool_calls_json TEXT,
          attachments_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          context TEXT,
          importance REAL NOT NULL DEFAULT 0.5,
          confidence REAL NOT NULL DEFAULT 0.8,
          tags_json TEXT NOT NULL DEFAULT '[]',
          contradicts_id TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category, updated_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          title,
          content,
          context,
          category
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          language TEXT,
          framework TEXT,
          package_manager TEXT,
          guardian_enabled INTEGER NOT NULL DEFAULT 0,
          last_scan_at TEXT,
          health_status TEXT NOT NULL DEFAULT 'unknown',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 2,
          progress INTEGER NOT NULL DEFAULT 0,
          project_id TEXT,
          conversation_id TEXT,
          checkpoint_id TEXT,
          assigned_agents_json TEXT NOT NULL DEFAULT '[]',
          result_summary TEXT,
          error_message TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 2,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);

        CREATE TABLE IF NOT EXISTS task_steps (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          step_order INTEGER NOT NULL,
          title TEXT NOT NULL,
          agent_role TEXT NOT NULL,
          status TEXT NOT NULL,
          tool_id TEXT,
          input_json TEXT,
          output_json TEXT,
          error_message TEXT,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, step_order);

        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          label TEXT NOT NULL,
          files_snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          restored_at TEXT
        );

        CREATE TABLE IF NOT EXISTS agents (
          role TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          allowed_tools_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          current_task_id TEXT,
          last_active_at TEXT,
          total_runs INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          agent_role TEXT NOT NULL,
          task_id TEXT,
          input_summary TEXT NOT NULL,
          output_summary TEXT,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tool_executions (
          id TEXT PRIMARY KEY,
          tool_id TEXT NOT NULL,
          task_id TEXT,
          risk_level TEXT NOT NULL,
          status TEXT NOT NULL,
          input_json TEXT NOT NULL,
          output_json TEXT,
          error_message TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tool_exec_created ON tool_executions(created_at DESC);

        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          tool_id TEXT NOT NULL,
          action_summary TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          trigger_type TEXT NOT NULL CHECK(trigger_type IN ('interval', 'event', 'manual')),
          interval_seconds INTEGER,
          event_name TEXT,
          action_type TEXT NOT NULL,
          action_payload_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          requires_approval INTEGER NOT NULL DEFAULT 0,
          last_run_at TEXT,
          next_run_at TEXT,
          last_status TEXT,
          run_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          duration_ms INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS research_reports (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          mode TEXT NOT NULL,
          summary TEXT NOT NULL,
          sources_json TEXT NOT NULL,
          contradictions_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS test_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          suite_name TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL,
          passed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          output TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bug_records (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          title TEXT NOT NULL,
          severity TEXT NOT NULL,
          category TEXT NOT NULL,
          file_path TEXT,
          line_number INTEGER,
          evidence TEXT NOT NULL,
          root_cause TEXT,
          fix_patch TEXT,
          status TEXT NOT NULL DEFAULT 'discovered',
          verified INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS business_records (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL CHECK(domain IN ('sales', 'marketing', 'finance', 'hr', 'operations')),
          record_type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          amount REAL,
          currency TEXT DEFAULT 'USD',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_business_domain ON business_records(domain, status);

        CREATE TABLE IF NOT EXISTS productivity_items (
          id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL CHECK(item_type IN ('task', 'reminder', 'event', 'note', 'goal')),
          title TEXT NOT NULL,
          details TEXT,
          priority TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT 'open',
          due_at TEXT,
          project_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prod_type_status ON productivity_items(item_type, status, due_at);

        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          device_type TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'paired',
          token_hash TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS simulations (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          scenario_name TEXT NOT NULL,
          assumptions_json TEXT NOT NULL,
          predicted_outcome TEXT NOT NULL,
          metrics_json TEXT NOT NULL,
          risk_score REAL NOT NULL,
          is_prediction INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS capability_gaps (
          id TEXT PRIMARY KEY,
          capability_name TEXT NOT NULL,
          description TEXT NOT NULL,
          hardware_feasible INTEGER NOT NULL,
          proposed_solution TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'identified',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          subsystem TEXT NOT NULL,
          action TEXT NOT NULL,
          details TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
      `);
    },
  },
];

export function getDb(customPath?: string): DatabaseSync {
  if (dbInstance && !customPath) return dbInstance;

  ensureRuntimeDirectories();
  const targetPath = customPath || config.dbPath;
  const db = new DatabaseSync(targetPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  runMigrations(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        ).run(migration.version, migration.name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function checkDatabaseIntegrity(db: DatabaseSync = getDb()): {
  ok: boolean;
  result: string;
  schemaVersion: number;
} {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  const ver = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };
  return {
    ok: row?.integrity_check === 'ok',
    result: row?.integrity_check || 'unknown',
    schemaVersion: ver?.version || 0,
  };
}

export function createDatabaseBackup(db: DatabaseSync = getDb()): {
  path: string;
  sizeBytes: number;
  createdAt: string;
} {
  ensureRuntimeDirectories();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(config.backupsDir, `jarvis-backup-${stamp}.db`);
  const escaped = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const stat = fs.statSync(backupPath);
  return {
    path: backupPath,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
  };
}

export function listDatabaseBackups(): Array<{
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}> {
  ensureRuntimeDirectories();
  const entries = fs.readdirSync(config.backupsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db'))
    .map((e) => {
      const fullPath = path.join(config.backupsDir, e.name);
      const stat = fs.statSync(fullPath);
      return {
        name: e.name,
        path: fullPath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
