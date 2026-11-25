import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/db.js';
import { eventBus } from '../events/eventBus.js';
import { logAudit } from '../logging/logger.js';
import { collectSystemTelemetry, shouldThrottleBackgroundWork } from '../monitoring/systemMonitor.js';
import { executeTool } from '../tools/registry.js';
import type { AgentRole, TaskStatus } from '../types.js';

export interface AgentDefinition {
  role: AgentRole;
  displayName: string;
  description: string;
  allowedTools: string[];
  status: string;
  currentTaskId: string | null;
  lastActiveAt: string | null;
  totalRuns: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: number;
  progress: number;
  projectId: string | null;
  conversationId: string | null;
  checkpointId: string | null;
  assignedAgents: AgentRole[];
  resultSummary: string | null;
  errorMessage: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  steps?: TaskStepRecord[];
}

export interface TaskStepRecord {
  id: string;
  taskId: string;
  stepOrder: number;
  title: string;
  agentRole: AgentRole;
  status: string;
  toolId: string | null;
  inputJson: string | null;
  outputJson: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

const DEFAULT_AGENTS: Array<{
  role: AgentRole;
  displayName: string;
  description: string;
  allowedTools: string[];
}> = [
  {
    role: 'planner',
    displayName: 'Planner',
    description: 'Breaks objectives into structured, dependency-aware execution plans.',
    allowedTools: ['memory_search', 'code_analyze'],
  },
  {
    role: 'researcher',
    displayName: 'Researcher',
    description: 'Searches online and local knowledge bases and verifies source citations.',
    allowedTools: ['web_research', 'browser_fetch', 'memory_search'],
  },
  {
    role: 'architect',
    displayName: 'Architect',
    description: 'Designs modular software architecture and database schemas.',
    allowedTools: ['code_analyze', 'file_search', 'file_read'],
  },
  {
    role: 'developer',
    displayName: 'Developer',
    description: 'Implements features and refactors code inside checkpointed workspaces.',
    allowedTools: ['file_search', 'file_read', 'file_write'],
  },
  {
    role: 'bug_hunter',
    displayName: 'Bug Hunter',
    description: 'Discovers static, type, runtime, and security defects with evidence.',
    allowedTools: ['bug_scan', 'file_read', 'code_analyze'],
  },
  {
    role: 'qa_engineer',
    displayName: 'QA Engineer',
    description: 'Executes real type checks, unit tests, and regression suites.',
    allowedTools: ['test_run', 'bug_scan'],
  },
  {
    role: 'security_reviewer',
    displayName: 'Security Reviewer',
    description: 'Audits paths, SSRF, permissions, and secret boundaries.',
    allowedTools: ['bug_scan', 'file_read'],
  },
  {
    role: 'performance_engineer',
    displayName: 'Performance Engineer',
    description: 'Analyzes CPU, RAM, disk, and process bottlenecks on 8GB hardware.',
    allowedTools: ['sys_diagnostics', 'code_analyze'],
  },
  {
    role: 'business_analyst',
    displayName: 'Business Analyst',
    description: 'Evaluates CRM, finance, sales, marketing, and operational metrics.',
    allowedTools: ['memory_search'],
  },
  {
    role: 'project_manager',
    displayName: 'Project Manager',
    description: 'Tracks deadlines, workload, milestones, and blockers.',
    allowedTools: ['code_analyze', 'memory_search'],
  },
  {
    role: 'operations_agent',
    displayName: 'Operations Agent',
    description: 'Monitors workflows, health checks, and recovery actions.',
    allowedTools: ['sys_diagnostics', 'computer_control'],
  },
  {
    role: 'personal_assistant',
    displayName: 'Personal Assistant',
    description: 'Coordinates reminders, schedules, notes, and follow-ups.',
    allowedTools: ['memory_store', 'memory_search'],
  },
  {
    role: 'independent_reviewer',
    displayName: 'Independent Reviewer',
    description: 'Critically verifies outputs against evidence before marking work complete.',
    allowedTools: ['test_run', 'file_read'],
  },
];

const activeAbortControllers = new Map<string, AbortController>();
let queueProcessing = false;

export function seedAgents(): void {
  const db = getDb();
  for (const agent of DEFAULT_AGENTS) {
    db.prepare(
      `INSERT INTO agents (role, display_name, description, allowed_tools_json, status)
       VALUES (?, ?, ?, ?, 'idle')
       ON CONFLICT(role) DO UPDATE SET
         display_name = excluded.display_name,
         description = excluded.description,
         allowed_tools_json = excluded.allowed_tools_json`
    ).run(agent.role, agent.displayName, agent.description, JSON.stringify(agent.allowedTools));
  }
}

export function listAgents(): AgentDefinition[] {
  seedAgents();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    role: r.role as AgentRole,
    displayName: String(r.display_name),
    description: String(r.description),
    allowedTools: JSON.parse(String(r.allowed_tools_json || '[]')),
    status: String(r.status),
    currentTaskId: r.current_task_id ? String(r.current_task_id) : null,
    lastActiveAt: r.last_active_at ? String(r.last_active_at) : null,
    totalRuns: Number(r.total_runs || 0),
  }));
}

function buildStepsForGoal(goal: string): Array<{
  title: string;
  agentRole: AgentRole;
  toolId: string | null;
  input: Record<string, unknown>;
}> {
  const lower = goal.toLowerCase();

  if (lower.includes('feature') || lower.includes('develop') || lower.includes('build') || lower.includes('engineer')) {
    return [
      { title: 'Planner: Retrieve memory & decompose engineering objective', agentRole: 'planner', toolId: 'memory_search', input: { query: goal, limit: 5 } },
      { title: 'Researcher: Gather technical context & references', agentRole: 'researcher', toolId: 'web_research', input: { query: goal, onlineAllowed: false } },
      { title: 'Architect: Inspect codebase structure & dependencies', agentRole: 'architect', toolId: 'code_analyze', input: { subDir: '.' } },
      { title: 'Bug Hunter: Verify current baseline for defects', agentRole: 'bug_hunter', toolId: 'bug_scan', input: {} },
      { title: 'QA Engineer: Run typecheck & test baseline', agentRole: 'qa_engineer', toolId: 'test_run', input: { suite: 'typecheck' } },
      { title: 'Independent Reviewer: Verify system readiness & evidence', agentRole: 'independent_reviewer', toolId: 'sys_diagnostics', input: { deep: false } },
    ];
  }

  if (lower.includes('audit') || lower.includes('bug') || lower.includes('fix') || lower.includes('repair')) {
    return [
      { title: 'Analyze project architecture & git state', agentRole: 'architect', toolId: 'code_analyze', input: { subDir: '.' } },
      { title: 'Scan codebase for TypeScript & security defects', agentRole: 'bug_hunter', toolId: 'bug_scan', input: {} },
      { title: 'Run verification & typecheck suite', agentRole: 'qa_engineer', toolId: 'test_run', input: { suite: 'typecheck' } },
      { title: 'Verify findings and compile audit report', agentRole: 'independent_reviewer', toolId: 'sys_diagnostics', input: { deep: false } },
    ];
  }

  if (lower.includes('research') || lower.includes('search') || lower.includes('compare')) {
    return [
      { title: 'Search local knowledge & memory context', agentRole: 'planner', toolId: 'memory_search', input: { query: goal, limit: 5 } },
      { title: 'Conduct grounded web & knowledge research', agentRole: 'researcher', toolId: 'web_research', input: { query: goal } },
    ];
  }

  if (lower.includes('slow') || lower.includes('cpu') || lower.includes('ram') || lower.includes('health') || lower.includes('diagnostic')) {
    return [
      { title: 'Inspect real-time CPU, RAM, disk & processes', agentRole: 'performance_engineer', toolId: 'sys_diagnostics', input: { deep: true } },
      { title: 'Verify system baseline & log recommendations', agentRole: 'operations_agent', toolId: 'memory_store', input: { category: 'lesson', title: 'System diagnostics run', content: `Diagnostic executed for goal: ${goal}`, importance: 0.5 } },
    ];
  }

  if (lower.includes('test') || lower.includes('vitest')) {
    return [
      { title: 'Analyze project test environment', agentRole: 'architect', toolId: 'code_analyze', input: { subDir: '.' } },
      { title: 'Execute real Vitest test suite', agentRole: 'qa_engineer', toolId: 'test_run', input: { suite: 'vitest' } },
    ];
  }

  return [
    { title: 'Retrieve relevant context from persistent memory', agentRole: 'planner', toolId: 'memory_search', input: { query: goal, limit: 5 } },
    { title: 'Inspect workspace structure', agentRole: 'architect', toolId: 'file_search', input: { maxResults: 30 } },
    { title: 'Check system readiness & health', agentRole: 'operations_agent', toolId: 'sys_diagnostics', input: { deep: false } },
  ];
}

export function createTask(input: {
  title: string;
  goal: string;
  priority?: number;
  projectId?: string;
  conversationId?: string;
  autoStart?: boolean;
}): TaskRecord {
  seedAgents();
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const planSteps = buildStepsForGoal(input.goal);
  const assignedAgents = Array.from(new Set(planSteps.map((s) => s.agentRole)));

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, title, goal, status, priority, progress, project_id, conversation_id, assigned_agents_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.title.slice(0, 140),
      input.goal,
      input.priority ?? 2,
      input.projectId || null,
      input.conversationId || null,
      JSON.stringify(assignedAgents),
      now,
      now
    );

    planSteps.forEach((step, idx) => {
      db.prepare(
        `INSERT INTO task_steps (id, task_id, step_order, title, agent_role, status, tool_id, input_json)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        crypto.randomUUID(),
        id,
        idx + 1,
        step.title,
        step.agentRole,
        step.toolId,
        JSON.stringify(step.input)
      );
    });
  });

  const task = getTaskById(id)!;
  eventBus.emitEvent('task_updated', task);
  logAudit('info', 'orchestrator', 'task_created', { taskId: id, title: task.title });

  if (input.autoStart !== false) {
    void processTaskQueue();
  }

  return task;
}

export function getTaskById(id: string): TaskRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const steps = db
    .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_order ASC')
    .all(id) as Array<Record<string, unknown>>;

  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    status: row.status as TaskStatus,
    priority: Number(row.priority),
    progress: Number(row.progress),
    projectId: row.project_id ? String(row.project_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    checkpointId: row.checkpoint_id ? String(row.checkpoint_id) : null,
    assignedAgents: JSON.parse(String(row.assigned_agents_json || '[]')),
    resultSummary: row.result_summary ? String(row.result_summary) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    retryCount: Number(row.retry_count || 0),
    maxRetries: Number(row.max_retries || 2),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    steps: steps.map((s) => ({
      id: String(s.id),
      taskId: String(s.task_id),
      stepOrder: Number(s.step_order),
      title: String(s.title),
      agentRole: s.agent_role as AgentRole,
      status: String(s.status),
      toolId: s.tool_id ? String(s.tool_id) : null,
      inputJson: s.input_json ? String(s.input_json) : null,
      outputJson: s.output_json ? String(s.output_json) : null,
      errorMessage: s.error_message ? String(s.error_message) : null,
      startedAt: s.started_at ? String(s.started_at) : null,
      completedAt: s.completed_at ? String(s.completed_at) : null,
    })),
  };
}

export function listTasks(limit = 50): TaskRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<{ id: string }>;
  return rows.map((r) => getTaskById(r.id)).filter((t): t is TaskRecord => t !== null);
}

export function controlTask(
  taskId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry'
): TaskRecord | null {
  const db = getDb();
  const task = getTaskById(taskId);
  if (!task) return null;

  const now = new Date().toISOString();
  if (action === 'cancel') {
    activeAbortControllers.get(taskId)?.abort();
    db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?').run(
      'cancelled',
      now,
      now,
      taskId
    );
  } else if (action === 'pause') {
    activeAbortControllers.get(taskId)?.abort();
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('paused', now, taskId);
  } else if (action === 'resume' || action === 'retry') {
    db.prepare('UPDATE tasks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?').run(
      'queued',
      now,
      taskId
    );
    void processTaskQueue();
  }

  const updated = getTaskById(taskId);
  if (updated) eventBus.emitEvent('task_updated', updated);
  return updated;
}

export async function processTaskQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;

  try {
    while (true) {
      const db = getDb();
      const nextRow = db
        .prepare(
          `SELECT id FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1`
        )
        .get() as { id: string } | undefined;

      if (!nextRow) break;

      const telemetry = await collectSystemTelemetry(false);
      const gov = shouldThrottleBackgroundWork(telemetry);
      if (gov.throttle) {
        logAudit('warn', 'resource_governor', 'queue_throttled', gov);
        eventBus.emitEvent('system_alert', { message: gov.reason });
        break;
      }

      await runSingleTask(nextRow.id);
    }
  } finally {
    queueProcessing = false;
  }
}

async function runSingleTask(taskId: string): Promise<void> {
  const db = getDb();
  const task = getTaskById(taskId);
  if (!task || task.status !== 'queued') return;

  const controller = new AbortController();
  activeAbortControllers.set(taskId, controller);
  const now = new Date().toISOString();

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('running', now, taskId);
  eventBus.emitEvent('task_updated', getTaskById(taskId));

  const steps = task.steps || [];
  let completedCount = steps.filter((s) => s.status === 'completed').length;
  const summaries: string[] = [];

  try {
    for (const step of steps) {
      const current = getTaskById(taskId);
      if (!current || current.status === 'cancelled' || current.status === 'paused' || controller.signal.aborted) {
        return;
      }
      if (step.status === 'completed') continue;

      const stepStart = Date.now();
      const startedAt = new Date().toISOString();

      db.prepare('UPDATE task_steps SET status = ?, started_at = ? WHERE id = ?').run(
        'running',
        startedAt,
        step.id
      );
      db.prepare(
        'UPDATE agents SET status = ?, current_task_id = ?, last_active_at = ? WHERE role = ?'
      ).run('active', taskId, startedAt, step.agentRole);
      eventBus.emitEvent('agent_updated', { role: step.agentRole, status: 'active', taskId });

      let outputSummary = '';
      if (step.toolId) {
        const inputObj = step.inputJson ? JSON.parse(step.inputJson) : {};
        const execRes = await executeTool(step.toolId, inputObj, {
          taskId,
          signal: controller.signal,
        });

        const stepEnd = new Date().toISOString();
        const dur = Date.now() - stepStart;

        db.prepare(
          'INSERT INTO agent_runs (id, agent_role, task_id, input_summary, output_summary, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          step.agentRole,
          taskId,
          step.title,
          execRes.ok ? 'completed' : execRes.error || execRes.status,
          execRes.ok ? 'completed' : execRes.status,
          dur,
          stepEnd
        );

        db.prepare(
          'UPDATE agents SET status = ?, current_task_id = NULL, total_runs = total_runs + 1 WHERE role = ?'
        ).run('idle', step.agentRole);

        if (execRes.status === 'waiting_approval') {
          db.prepare('UPDATE task_steps SET status = ? WHERE id = ?').run('waiting_approval', step.id);
          db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
            'waiting_approval',
            stepEnd,
            taskId
          );
          eventBus.emitEvent('task_updated', getTaskById(taskId));
          return;
        }

        if (!execRes.ok) {
          throw new Error(execRes.error || `Step "${step.title}" failed`);
        }

        outputSummary = JSON.stringify(execRes.output ?? {}).slice(0, 600);
        summaries.push(`${step.agentRole}: ${step.title} -> OK`);

        db.prepare('UPDATE task_steps SET status = ?, output_json = ?, completed_at = ? WHERE id = ?').run(
          'completed',
          JSON.stringify(execRes.output ?? {}).slice(0, 8000),
          stepEnd,
          step.id
        );
      } else {
        const stepEnd = new Date().toISOString();
        db.prepare('UPDATE task_steps SET status = ?, completed_at = ? WHERE id = ?').run(
          'completed',
          stepEnd,
          step.id
        );
        db.prepare(
          'UPDATE agents SET status = ?, current_task_id = NULL, total_runs = total_runs + 1 WHERE role = ?'
        ).run('idle', step.agentRole);
      }

      completedCount++;
      const pct = Math.round((completedCount / Math.max(1, steps.length)) * 100);
      db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(
        pct,
        new Date().toISOString(),
        taskId
      );
      eventBus.emitEvent('task_updated', getTaskById(taskId));
    }

    const doneAt = new Date().toISOString();
    const finalSummary = summaries.join(' | ') || 'Task completed successfully.';
    db.prepare(
      'UPDATE tasks SET status = ?, progress = 100, result_summary = ?, updated_at = ?, completed_at = ? WHERE id = ?'
    ).run('completed', finalSummary, doneAt, doneAt, taskId);
    eventBus.emitEvent('task_updated', getTaskById(taskId));
    eventBus.emitEvent('notification', {
      title: `Task completed: ${task.title}`,
      summary: finalSummary,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Task execution error';
    const failAt = new Date().toISOString();
    const nextRetry = task.retryCount + 1;
    if (nextRetry <= task.maxRetries && !controller.signal.aborted) {
      db.prepare(
        'UPDATE tasks SET status = ?, retry_count = ?, error_message = ?, updated_at = ? WHERE id = ?'
      ).run('queued', nextRetry, errMsg, failAt, taskId);
    } else {
      db.prepare(
        'UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?'
      ).run('failed', errMsg, failAt, failAt, taskId);
    }
    eventBus.emitEvent('task_updated', getTaskById(taskId));
    logAudit('error', 'orchestrator', 'task_failed', { taskId, errMsg });
  } finally {
    activeAbortControllers.delete(taskId);
  }
}

export function recoverInterruptedTasks(): number {
  const db = getDb();
  const res = db
    .prepare(`UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running'`)
    .run(new Date().toISOString());
  const count = Number(res.changes || 0);
  if (count > 0) {
    logAudit('info', 'recovery', 'requeued_interrupted_tasks', { count });
    void processTaskQueue();
  }
  return count;
}
