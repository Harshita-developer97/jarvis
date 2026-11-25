import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { conductResearch, inspectWebPage } from '../browser/browserService.js';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import { executeDesktopAction } from '../desktop/windowsControl.js';
import {
  analyzeProject,
  applyMultiFileChanges,
  executeRealTests,
  generateUnitTestsForFile,
  runBugScan,
} from '../engineering/engineerService.js';
import { eventBus } from '../events/eventBus.js';
import {
  copyWorkspaceFile,
  deleteWorkspaceFile,
  moveWorkspaceFile,
  organizeWorkspaceDirectory,
  readAndParseWorkspaceFile,
  searchWorkspaceFiles,
  writeWorkspaceFileWithCheckpoint,
} from '../files/fileService.js';
import { logAudit } from '../logging/logger.js';
import {
  forgetMemoriesByQuery,
  searchMemories,
  storeMemory,
} from '../memory/memoryService.js';
import { collectSystemTelemetry } from '../monitoring/systemMonitor.js';
import { redactSecrets, validateSafeCommand } from '../security/guard.js';
import type { ApprovalRequest, RiskLevel, ToolDefinitionMeta } from '../types.js';

const execFileAsync = promisify(execFile);

export interface RegisteredTool<TInput = unknown> {
  meta: ToolDefinitionMeta;
  schema: z.ZodType<TInput>;
  execute: (input: TInput, ctx: { taskId?: string; signal?: AbortSignal }) => Promise<unknown>;
}

const toolsMap = new Map<string, RegisteredTool<unknown>>();

function registerTool<T>(tool: RegisteredTool<T>): void {
  toolsMap.set(tool.meta.id, tool as RegisteredTool<unknown>);
}

export function initializeToolRegistry(): void {
  if (toolsMap.size > 0) return;

  registerTool({
    meta: {
      id: 'sys_diagnostics',
      name: 'System Diagnostics',
      description: 'Inspect real CPU, RAM, disk, top processes, and runtime dependencies.',
      category: 'system',
      riskLevel: 'LOW',
      timeoutMs: 8000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ deep: z.boolean().optional() }),
    execute: async (input) => collectSystemTelemetry(Boolean(input.deep)),
  });

  registerTool({
    meta: {
      id: 'file_search',
      name: 'Workspace File Search',
      description: 'Search files inside the authorized workspace directory.',
      category: 'files',
      riskLevel: 'LOW',
      timeoutMs: 8000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      query: z.string().optional(),
      subDir: z.string().optional(),
      maxResults: z.number().int().min(1).max(300).optional(),
    }),
    execute: async (input) => searchWorkspaceFiles(input),
  });

  registerTool({
    meta: {
      id: 'file_read',
      name: 'File Reader & Parser',
      description: 'Read and parse workspace files (code, JSON, CSV, Markdown, SQL, YAML).',
      category: 'files',
      riskLevel: 'LOW',
      timeoutMs: 8000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ path: z.string().min(1) }),
    execute: async (input) => readAndParseWorkspaceFile(input.path),
  });

  registerTool({
    meta: {
      id: 'file_write',
      name: 'Checkpointed File Writer',
      description: 'Create or update a file inside the authorized workspace after creating a rollback checkpoint.',
      category: 'files',
      riskLevel: 'MEDIUM',
      timeoutMs: 10_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async (input, ctx) =>
      writeWorkspaceFileWithCheckpoint(input.path, input.content, ctx.taskId),
  });

  registerTool({
    meta: {
      id: 'file_copy',
      name: 'Workspace File Copier',
      description: 'Copy a file safely inside the authorized workspace directory.',
      category: 'files',
      riskLevel: 'LOW',
      timeoutMs: 8000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    execute: async (input) => copyWorkspaceFile(input.from, input.to),
  });

  registerTool({
    meta: {
      id: 'file_move',
      name: 'Checkpointed File Mover',
      description: 'Move or rename a file safely inside the authorized workspace after creating a checkpoint.',
      category: 'files',
      riskLevel: 'MEDIUM',
      timeoutMs: 8000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    execute: async (input, ctx) => moveWorkspaceFile(input.from, input.to, ctx.taskId),
  });

  registerTool({
    meta: {
      id: 'file_delete',
      name: 'Checkpointed File Deleter',
      description: 'Delete a workspace file safely with rollback checkpoint (requires owner approval).',
      category: 'files',
      riskLevel: 'HIGH',
      timeoutMs: 8000,
      requiresApproval: true,
      available: true,
    },
    schema: z.object({ path: z.string().min(1) }),
    execute: async (input, ctx) => deleteWorkspaceFile(input.path, ctx.taskId),
  });

  registerTool({
    meta: {
      id: 'file_organize',
      name: 'Checkpointed Folder Organizer',
      description: 'Organize loose files inside a workspace subfolder into categorized subfolders with checkpointing.',
      category: 'files',
      riskLevel: 'HIGH',
      timeoutMs: 12_000,
      requiresApproval: true,
      available: true,
    },
    schema: z.object({ subDir: z.string().min(1), dryRun: z.boolean().optional() }),
    execute: async (input, ctx) =>
      organizeWorkspaceDirectory(input.subDir, { dryRun: input.dryRun, taskId: ctx.taskId }),
  });

  registerTool({
    meta: {
      id: 'terminal_exec',
      name: 'Sandboxed Command Runner',
      description: 'Execute allowlisted CLI tools (git, npm, tsc, vitest, node, python3) without shell interpolation.',
      category: 'system',
      riskLevel: 'HIGH',
      timeoutMs: 30_000,
      requiresApproval: true,
      available: true,
    },
    schema: z.object({
      binary: z.string().min(1),
      args: z.array(z.string()).default([]),
    }),
    execute: async (input, ctx) => {
      const checked = validateSafeCommand(input.binary, input.args);
      const { stdout, stderr } = await execFileAsync(checked.binary, checked.args, {
        cwd: config.workspaceRoot,
        timeout: 25_000,
        signal: ctx.signal,
      });
      return {
        binary: checked.binary,
        args: checked.args,
        stdout: redactSecrets(stdout).slice(0, 8000),
        stderr: redactSecrets(stderr).slice(0, 4000),
      };
    },
  });

  registerTool({
    meta: {
      id: 'browser_fetch',
      name: 'Browser Page Inspector',
      description: 'SSRF-protected web page inspection, DOM extraction, links, and CAPTCHA/MFA detection.',
      category: 'browser',
      riskLevel: 'LOW',
      timeoutMs: 15_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ url: z.string().url() }),
    execute: async (input) => inspectWebPage(input.url),
  });

  registerTool({
    meta: {
      id: 'web_research',
      name: 'Research Synthesizer',
      description: 'Multi-source online/offline research with source reliability and citations.',
      category: 'research',
      riskLevel: 'LOW',
      timeoutMs: 20_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      query: z.string().min(2),
      urls: z.array(z.string().url()).optional(),
      onlineAllowed: z.boolean().optional(),
    }),
    execute: async (input) => conductResearch(input.query, input),
  });

  registerTool({
    meta: {
      id: 'code_analyze',
      name: 'Project Analyzer',
      description: 'Detect project language, framework, package manager, entry points, and git status.',
      category: 'engineering',
      riskLevel: 'LOW',
      timeoutMs: 12_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ subDir: z.string().optional() }),
    execute: async (input) => analyzeProject(input.subDir || '.'),
  });

  registerTool({
    meta: {
      id: 'bug_scan',
      name: 'Bug Hunter Scanner',
      description: 'Run TypeScript compiler checks and static security/reliability scans.',
      category: 'engineering',
      riskLevel: 'LOW',
      timeoutMs: 30_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ projectId: z.string().optional() }),
    execute: async (input) => runBugScan(input.projectId),
  });

  registerTool({
    meta: {
      id: 'test_run',
      name: 'Testing Lab Runner',
      description: 'Execute real TypeScript typecheck or Vitest test suites and persist results.',
      category: 'testing',
      riskLevel: 'MEDIUM',
      timeoutMs: 45_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      suite: z.enum(['typecheck', 'vitest', 'all']).default('typecheck'),
      projectId: z.string().optional(),
    }),
    execute: async (input) => executeRealTests(input),
  });

  registerTool({
    meta: {
      id: 'memory_store',
      name: 'Memory Writer',
      description: 'Persist structured knowledge or user preference to SQLite memory.',
      category: 'memory',
      riskLevel: 'LOW',
      timeoutMs: 5000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      category: z.enum([
        'preference',
        'instruction',
        'project',
        'goal',
        'conversation',
        'decision',
        'task',
        'fact',
        'technical',
        'business',
        'correction',
        'lesson',
        'workflow_success',
        'workflow_failure',
      ]),
      title: z.string().min(2),
      content: z.string().min(4),
      importance: z.number().min(0).max(1).optional(),
    }),
    execute: async (input) =>
      storeMemory({ ...input, source: 'tool:memory_store' }),
  });

  registerTool({
    meta: {
      id: 'memory_search',
      name: 'Memory Search',
      description: 'Search persistent FTS5 + semantic memory brain.',
      category: 'memory',
      riskLevel: 'LOW',
      timeoutMs: 5000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
    execute: async (input) => searchMemories(input.query, input.limit || 6),
  });

  registerTool({
    meta: {
      id: 'memory_forget',
      name: 'Memory Forget',
      description: 'Forget matching memories from the persistent memory brain.',
      category: 'memory',
      riskLevel: 'MEDIUM',
      timeoutMs: 5000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({ query: z.string().min(1) }),
    execute: async (input) => forgetMemoriesByQuery(input.query),
  });

  registerTool({
    meta: {
      id: 'multi_file_edit',
      name: 'Atomic Multi-File Editor',
      description: 'Apply multi-file workspace edits with unified diff, checkpointing, typecheck verification, and automatic rollback on failure.',
      category: 'engineering',
      riskLevel: 'MEDIUM',
      timeoutMs: 35_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      label: z.string().min(2),
      changes: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
      verifyTypecheck: z.boolean().optional(),
      autoRollbackOnFail: z.boolean().optional(),
    }),
    execute: async (input, ctx) =>
      applyMultiFileChanges(input.changes, input.label, {
        verifyTypecheck: input.verifyTypecheck,
        autoRollbackOnFail: input.autoRollbackOnFail,
        taskId: ctx.taskId,
      }),
  });

  registerTool({
    meta: {
      id: 'generate_tests',
      name: 'Automated Test Generator',
      description: 'Inspect exported functions in a module and generate runnable Vitest tests.',
      category: 'testing',
      riskLevel: 'MEDIUM',
      timeoutMs: 35_000,
      requiresApproval: false,
      available: true,
    },
    schema: z.object({
      targetPath: z.string().min(1),
      runImmediately: z.boolean().optional(),
    }),
    execute: async (input) =>
      generateUnitTestsForFile(input.targetPath, Boolean(input.runImmediately)),
  });

  registerTool({
    meta: {
      id: 'computer_control',
      name: 'Authorized Desktop Control',
      description: 'Inspect windows, active window, clipboard, screenshots, processes, and authorized Windows applications.',
      category: 'desktop',
      riskLevel: 'HIGH',
      timeoutMs: 12_000,
      requiresApproval: true,
      available: true,
    },
    schema: z.object({
      action: z.enum([
        'check_capabilities',
        'list_processes',
        'list_windows',
        'get_active_window',
        'focus_window',
        'launch_app',
        'close_app',
        'open_url',
        'type_text',
        'scroll',
        'click_at',
        'get_clipboard',
        'set_clipboard',
        'capture_screenshot',
        'windows_diagnostics',
      ]),
      target: z.string().optional(),
      text: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      delta: z.number().optional(),
    }),
    execute: async (input) => executeDesktopAction(input),
  });
}

export function listRegisteredTools(): ToolDefinitionMeta[] {
  initializeToolRegistry();
  return Array.from(toolsMap.values()).map((t) => t.meta);
}

export function listPendingApprovals(): ApprovalRequest[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50')
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    taskId: r.task_id ? String(r.task_id) : null,
    toolId: String(r.tool_id),
    actionSummary: String(r.action_summary),
    riskLevel: r.risk_level as RiskLevel,
    payloadJson: String(r.payload_json),
    status: r.status as ApprovalRequest['status'],
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  }));
}

export async function executeTool(
  toolId: string,
  rawInput: unknown,
  options?: { taskId?: string; approvedByOwner?: boolean; signal?: AbortSignal }
): Promise<{
  ok: boolean;
  status: 'completed' | 'waiting_approval' | 'failed';
  approvalId?: string;
  output?: unknown;
  error?: string;
  durationMs: number;
}> {
  initializeToolRegistry();
  const start = Date.now();
  const tool = toolsMap.get(toolId);

  if (!tool) {
    return {
      ok: false,
      status: 'failed',
      error: `Unknown tool "${toolId}". Models cannot invent unregistered tools.`,
      durationMs: 0,
    };
  }

  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      status: 'failed',
      error: `Invalid input for ${toolId}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      durationMs: Date.now() - start,
    };
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Enforce approval gate for HIGH / CRITICAL tools unless explicitly approved by owner
  if ((tool.meta.riskLevel === 'HIGH' || tool.meta.riskLevel === 'CRITICAL') && !options?.approvedByOwner) {
    const approvalId = crypto.randomUUID();
    const safePayload = redactSecrets(JSON.stringify(parsed.data));
    const summary = `Run ${tool.meta.name} (${toolId}) with ${safePayload.slice(0, 140)}`;
    db.prepare(
      `INSERT INTO approvals (id, task_id, tool_id, action_summary, risk_level, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      approvalId,
      options?.taskId || null,
      toolId,
      summary,
      tool.meta.riskLevel,
      safePayload,
      now
    );

    eventBus.emitEvent('approval_requested', {
      id: approvalId,
      toolId,
      riskLevel: tool.meta.riskLevel,
      actionSummary: summary,
    });
    logAudit('security', 'tool_registry', 'approval_required', { approvalId, toolId, risk: tool.meta.riskLevel });

    return {
      ok: false,
      status: 'waiting_approval',
      approvalId,
      durationMs: Date.now() - start,
    };
  }

  const execId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tool.meta.timeoutMs);

  if (options?.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const output = await tool.execute(parsed.data, {
      taskId: options?.taskId,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const serialized = redactSecrets(JSON.stringify(output ?? {})).slice(0, 16000);

    db.prepare(
      `INSERT INTO tool_executions (id, tool_id, task_id, risk_level, status, input_json, output_json, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`
    ).run(
      execId,
      toolId,
      options?.taskId || null,
      tool.meta.riskLevel,
      redactSecrets(JSON.stringify(parsed.data)),
      serialized,
      durationMs,
      now
    );

    eventBus.emitEvent('tool_executed', { execId, toolId, status: 'completed', durationMs });
    return { ok: true, status: 'completed', output, durationMs };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : 'Tool execution error';
    db.prepare(
      `INSERT INTO tool_executions (id, tool_id, task_id, risk_level, status, input_json, error_message, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?)`
    ).run(
      execId,
      toolId,
      options?.taskId || null,
      tool.meta.riskLevel,
      redactSecrets(JSON.stringify(parsed.data)),
      redactSecrets(msg),
      durationMs,
      now
    );
    logAudit('error', 'tool_registry', 'tool_failed', { toolId, error: msg });
    return { ok: false, status: 'failed', error: msg, durationMs };
  }
}

export async function resolveApprovalRequest(
  approvalId: string,
  decision: 'approved' | 'rejected'
): Promise<{ approval: ApprovalRequest; execution?: unknown }> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error('Approval request not found');
  if (row.status !== 'pending') {
    throw new Error(`Approval already ${row.status}`);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(
    decision,
    now,
    approvalId
  );

  const updated: ApprovalRequest = {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : null,
    toolId: String(row.tool_id),
    actionSummary: String(row.action_summary),
    riskLevel: row.risk_level as RiskLevel,
    payloadJson: String(row.payload_json),
    status: decision,
    createdAt: String(row.created_at),
    resolvedAt: now,
  };

  logAudit('security', 'tool_registry', `approval_${decision}`, {
    approvalId,
    toolId: updated.toolId,
  });

  if (decision === 'approved') {
    const payload = JSON.parse(updated.payloadJson);
    const execution = await executeTool(updated.toolId, payload, {
      taskId: updated.taskId || undefined,
      approvedByOwner: true,
    });
    return { approval: updated, execution };
  }

  return { approval: updated };
}

export function listToolExecutions(limit = 50): Array<Record<string, unknown>> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
}
