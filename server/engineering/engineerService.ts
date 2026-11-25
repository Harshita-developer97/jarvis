import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import {
  createFileCheckpoint,
  restoreFileCheckpoint,
  searchWorkspaceFiles,
} from '../files/fileService.js';
import { logAudit } from '../logging/logger.js';
import { detectRuntimes } from '../monitoring/systemMonitor.js';
import { resolveSafeWorkspacePath } from '../security/guard.js';

const execFileAsync = promisify(execFile);

export interface ProjectAnalysis {
  id: string;
  name: string;
  rootPath: string;
  language: string;
  framework: string;
  packageManager: string;
  dependenciesCount: number;
  entryPoints: string[];
  gitBranch: string | null;
  gitDirty: boolean;
  fileCount: number;
  healthStatus: 'healthy' | 'warning' | 'critical' | 'unknown';
  analyzedAt: string;
}

export interface BugFinding {
  id: string;
  projectId: string | null;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  filePath: string | null;
  lineNumber: number | null;
  evidence: string;
  rootCause: string | null;
  status: 'discovered' | 'analyzed' | 'fixed' | 'verified' | 'dismissed';
  verified: boolean;
  createdAt: string;
}

export interface TestRunResult {
  id: string;
  projectId: string | null;
  suiteName: string;
  command: string;
  status: 'passed' | 'failed' | 'error';
  passed: number;
  failed: number;
  durationMs: number;
  regressionDetected?: boolean;
  regressionSummary?: string | null;
  output: string;
  createdAt: string;
}

export interface TestBaseline {
  suiteName: string;
  passed: number;
  failed: number;
  capturedAt: string;
}

function computeLineDiff(before: string, after: string, relPath: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < 80; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- L${i + 1}: ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ L${i + 1}: ${b[i]}`);
    }
  }
  return out.join('\n');
}

export async function applyMultiFileChanges(
  changes: Array<{ path: string; content: string }>,
  label: string,
  options?: { verifyTypecheck?: boolean; autoRollbackOnFail?: boolean; taskId?: string }
): Promise<{
  ok: boolean;
  checkpointId: string;
  rolledBack: boolean;
  diffs: string[];
  verificationStatus: 'passed' | 'failed' | 'skipped';
  verificationOutput: string;
}> {
  if (changes.length === 0) {
    throw new Error('No file changes supplied');
  }

  const paths = changes.map((c) => c.path);
  const checkpointId = createFileCheckpoint(paths, label, options?.taskId);
  const diffs: string[] = [];

  for (const ch of changes) {
    const resolved = resolveSafeWorkspacePath(ch.path);
    const rel = path.relative(config.workspaceRoot, resolved).replace(/\\/g, '/');
    const prev = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    diffs.push(computeLineDiff(prev, ch.content, rel));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, ch.content, 'utf8');
  }

  if (options?.verifyTypecheck === false) {
    return {
      ok: true,
      checkpointId,
      rolledBack: false,
      diffs,
      verificationStatus: 'skipped',
      verificationOutput: 'Typecheck skipped by caller',
    };
  }

  const check = await executeRealTests({ suite: 'typecheck' });
  if (check.status === 'passed') {
    logAudit('info', 'software_engineer', 'multi_file_edit_verified', {
      checkpointId,
      files: paths,
    });
    return {
      ok: true,
      checkpointId,
      rolledBack: false,
      diffs,
      verificationStatus: 'passed',
      verificationOutput: check.output,
    };
  }

  let rolledBack = false;
  if (options?.autoRollbackOnFail !== false) {
    restoreFileCheckpoint(checkpointId);
    rolledBack = true;
    logAudit('warn', 'software_engineer', 'multi_file_edit_rolled_back', {
      checkpointId,
      reason: 'Typecheck verification failed',
    });
  }

  return {
    ok: false,
    checkpointId,
    rolledBack,
    diffs,
    verificationStatus: 'failed',
    verificationOutput: check.output,
  };
}

export async function generateUnitTestsForFile(
  targetRelPath: string,
  runImmediately = false
): Promise<{
  targetPath: string;
  generatedTestPath: string;
  exportedSymbols: string[];
  testContent: string;
  runResult?: TestRunResult;
}> {
  const resolved = resolveSafeWorkspacePath(targetRelPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target file not found: ${targetRelPath}`);
  }
  const source = fs.readFileSync(resolved, 'utf8');
  const exportMatches = Array.from(
    source.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g)
  ).map((m) => m[1]);

  if (exportMatches.length === 0) {
    throw new Error(`No exported functions found in ${targetRelPath} to generate tests for`);
  }

  const baseName = path.basename(resolved, path.extname(resolved));
  const genRelPath = `tests/generated/${baseName}.generated.test.ts`;
  const genFull = resolveSafeWorkspacePath(genRelPath);
  const relImport = path
    .relative(path.dirname(genFull), resolved)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '.js');

  const assertions = exportMatches
    .map(
      (sym) => `  it('exports ${sym} as a callable function', () => {\n    expect(typeof target.${sym}).toBe('function');\n  });`
    )
    .join('\n\n');

  const testContent = `import { describe, expect, it } from 'vitest';\nimport * as target from '${relImport.startsWith('.') ? relImport : './' + relImport}';\n\ndescribe('Generated module verification: ${targetRelPath}', () => {\n${assertions}\n});\n`;

  fs.mkdirSync(path.dirname(genFull), { recursive: true });
  fs.writeFileSync(genFull, testContent, 'utf8');

  let runResult: TestRunResult | undefined;
  if (runImmediately) {
    runResult = await executeRealTests({ suite: 'vitest', specificFile: genRelPath });
  }

  logAudit('info', 'testing_lab', 'tests_generated', {
    targetRelPath,
    generatedTestPath: genRelPath,
    symbols: exportMatches.length,
  });

  return {
    targetPath: targetRelPath,
    generatedTestPath: genRelPath,
    exportedSymbols: exportMatches,
    testContent,
    runResult,
  };
}

export async function detectTestEnvironment(): Promise<{
  node: string | null;
  vitestAvailable: boolean;
  typescriptAvailable: boolean;
  python: string | null;
  git: string | null;
  missingTools: string[];
}> {
  const runtimes = await detectRuntimes(true);
  const vitestAvailable = fs.existsSync(path.join(config.workspaceRoot, 'node_modules', '.bin', 'vitest')) ||
    fs.existsSync(path.join(config.workspaceRoot, 'node_modules', 'vitest'));
  const typescriptAvailable = fs.existsSync(path.join(config.workspaceRoot, 'node_modules', 'typescript'));

  const missingTools: string[] = [];
  if (!vitestAvailable) missingTools.push('vitest');
  if (!typescriptAvailable) missingTools.push('typescript');
  if (!runtimes.git) missingTools.push('git');

  return {
    node: runtimes.node,
    vitestAvailable,
    typescriptAvailable,
    python: runtimes.python,
    git: runtimes.git,
    missingTools,
  };
}

export function getTestBaseline(suiteName = 'vitest'): TestBaseline | null {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get(`test_baseline_${suiteName}`) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as TestBaseline;
  } catch {
    return null;
  }
}

export function saveTestBaseline(baseline: TestBaseline): TestBaseline {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(`test_baseline_${baseline.suiteName}`, JSON.stringify(baseline), new Date().toISOString());
  return baseline;
}

export async function analyzeProject(subDir = '.'): Promise<ProjectAnalysis> {
  const root = resolveSafeWorkspacePath(subDir);
  const relRoot = path.relative(config.workspaceRoot, root) || '.';
  const files = searchWorkspaceFiles({ subDir: relRoot === '.' ? undefined : relRoot, maxResults: 400 });

  let name = path.basename(root);
  let language = 'Unknown';
  let framework = 'None detected';
  let packageManager = 'None';
  let dependenciesCount = 0;
  const entryPoints: string[] = [];

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      name = pkg.name || name;
      packageManager = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      dependenciesCount = Object.keys(deps).length;
      language =
        deps.typescript || fs.existsSync(path.join(root, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript';
      if (deps.next) framework = 'Next.js';
      else if (deps.react) framework = 'React + Vite';
      else if (deps.vue) framework = 'Vue';
      else if (deps.express) framework = 'Node.js / Express';
    } catch {
      // ignore parse error
    }
  } else if (
    fs.existsSync(path.join(root, 'requirements.txt')) ||
    fs.existsSync(path.join(root, 'pyproject.toml'))
  ) {
    language = 'Python';
    packageManager = 'pip';
  } else if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    language = 'Rust';
    packageManager = 'cargo';
  }

  for (const candidate of ['server.ts', 'src/main.tsx', 'src/App.tsx', 'index.ts', 'main.py']) {
    if (fs.existsSync(path.join(root, candidate))) {
      entryPoints.push(candidate);
    }
  }

  let gitBranch: string | null = null;
  let gitDirty = false;
  try {
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      timeout: 2000,
    });
    gitBranch = branchOut.trim();
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: root,
      timeout: 2000,
    });
    gitDirty = statusOut.trim().length > 0;
  } catch {
    // not a git repo or git unavailable
  }

  const now = new Date().toISOString();
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM projects WHERE root_path = ?')
    .get(relRoot) as { id: string } | undefined;
  const id = existing?.id || crypto.randomUUID();

  const metaJson = JSON.stringify({
    dependenciesCount,
    entryPoints,
    gitBranch,
    gitDirty,
    fileCount: files.length,
  });

  if (existing) {
    db.prepare(
      `UPDATE projects SET name = ?, language = ?, framework = ?, package_manager = ?,
       last_scan_at = ?, metadata_json = ?, updated_at = ? WHERE id = ?`
    ).run(name, language, framework, packageManager, now, metaJson, now, id);
  } else {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, language, framework, package_manager, guardian_enabled, last_scan_at, health_status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'healthy', ?, ?, ?)`
    ).run(id, name, relRoot, language, framework, packageManager, now, metaJson, now, now);
  }

  return {
    id,
    name,
    rootPath: relRoot,
    language,
    framework,
    packageManager,
    dependenciesCount,
    entryPoints,
    gitBranch,
    gitDirty,
    fileCount: files.length,
    healthStatus: 'healthy',
    analyzedAt: now,
  };
}

export async function runBugScan(projectId?: string): Promise<BugFinding[]> {
  const db = getDb();
  const findings: BugFinding[] = [];
  const now = new Date().toISOString();

  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: config.workspaceRoot,
      timeout: 25_000,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${execErr.stdout || ''}\n${execErr.stderr || ''}`.trim();
    const lines = output.split('\n').filter((l) => l.includes('error TS'));
    for (const line of lines.slice(0, 15)) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
      findings.push({
        id: crypto.randomUUID(),
        projectId: projectId || null,
        title: m ? `TypeScript ${m[4]}: ${m[5].slice(0, 90)}` : line.slice(0, 110),
        severity: 'high',
        category: 'type_error',
        filePath: m ? m[1] : null,
        lineNumber: m ? Number(m[2]) : null,
        evidence: line,
        rootCause: 'Static TypeScript compiler diagnostic',
        status: 'discovered',
        verified: true,
        createdAt: now,
      });
    }
  }

  const codeFiles = searchWorkspaceFiles({ maxResults: 200 }).filter(
    (f) =>
      !f.isDirectory &&
      (f.extension === '.ts' || f.extension === '.tsx') &&
      !f.relativePath.startsWith('tests/')
  );

  for (const f of codeFiles) {
    const full = resolveSafeWorkspacePath(f.relativePath);
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('eval(') || line.includes('new Function(')) {
        findings.push({
          id: crypto.randomUUID(),
          projectId: projectId || null,
          title: 'Dynamic code execution detected',
          severity: 'critical',
          category: 'security',
          filePath: f.relativePath,
          lineNumber: idx + 1,
          evidence: line.trim().slice(0, 200),
          rootCause: 'Use of eval/Function introduces code-injection risk',
          status: 'discovered',
          verified: true,
          createdAt: now,
        });
      }
      if (line.includes('dangerouslySetInnerHTML')) {
        findings.push({
          id: crypto.randomUUID(),
          projectId: projectId || null,
          title: 'Unsafe HTML injection sink (dangerouslySetInnerHTML)',
          severity: 'high',
          category: 'security',
          filePath: f.relativePath,
          lineNumber: idx + 1,
          evidence: line.trim().slice(0, 200),
          rootCause: 'Direct HTML rendering without framework escaping',
          status: 'discovered',
          verified: true,
          createdAt: now,
        });
      }
    });
  }

  for (const finding of findings) {
    db.prepare(
      `INSERT INTO bug_records (id, project_id, title, severity, category, file_path, line_number, evidence, root_cause, status, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      finding.id,
      finding.projectId,
      finding.title,
      finding.severity,
      finding.category,
      finding.filePath,
      finding.lineNumber,
      finding.evidence,
      finding.rootCause,
      finding.status,
      finding.verified ? 1 : 0,
      finding.createdAt,
      finding.createdAt
    );
  }

  logAudit('info', 'bug_hunter', 'scan_completed', {
    projectId: projectId || 'workspace',
    findingsCount: findings.length,
  });

  return findings;
}

export async function executeRealTests(options?: {
  suite?: 'all' | 'typecheck' | 'vitest';
  specificFile?: string;
  projectId?: string;
  signal?: AbortSignal;
}): Promise<TestRunResult> {
  const suite = options?.suite || 'typecheck';
  const start = Date.now();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  let cmd = 'npx tsc --noEmit';
  const bin = 'npx';
  let args = ['tsc', '--noEmit'];
  const reportDir = path.join(config.dataDir, 'tmp_reports');
  const jsonReportPath = path.join(reportDir, `${id}.json`);

  if (suite === 'vitest' || suite === 'all') {
    fs.mkdirSync(reportDir, { recursive: true });
    args = ['vitest', 'run', '--reporter=json', `--outputFile=${jsonReportPath}`];
    if (options?.specificFile) {
      const safeTarget = resolveSafeWorkspacePath(options.specificFile);
      const rel = path.relative(config.workspaceRoot, safeTarget).replace(/\\/g, '/');
      args.push(rel);
    }
    cmd = `npx ${args.join(' ')}`;
  }

  let status: TestRunResult['status'] = 'passed';
  let passed = 0;
  let failed = 0;
  let output = '';

  const readVitestReport = (): { numPassedTests?: number; numFailedTests?: number } | null => {
    if (fs.existsSync(jsonReportPath)) {
      try {
        return JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
      } catch {
        return null;
      }
    }
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  };

  try {
    const res = await execFileAsync(bin, args, {
      cwd: config.workspaceRoot,
      timeout: 45_000,
      signal: options?.signal,
    });
    output = (res.stdout || res.stderr || 'Completed cleanly').trim();
    if (suite === 'typecheck') {
      passed = 1;
    } else {
      const parsed = readVitestReport();
      if (parsed) {
        passed = Number(parsed.numPassedTests || 0);
        failed = Number(parsed.numFailedTests || 0);
        status = failed > 0 ? 'failed' : 'passed';
      } else {
        passed = 1;
      }
    }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    output = `${execErr.stdout || ''}\n${execErr.stderr || ''}\n${execErr.message || ''}`.trim();
    status = 'failed';
    if (suite === 'vitest' || suite === 'all') {
      const parsed = readVitestReport();
      if (parsed) {
        passed = Number(parsed.numPassedTests || 0);
        failed = Number(parsed.numFailedTests || 1);
      } else {
        failed = 1;
      }
    } else {
      failed = 1;
    }
  } finally {
    if (fs.existsSync(jsonReportPath)) {
      try {
        fs.unlinkSync(jsonReportPath);
      } catch {
        // ignore cleanup error
      }
    }
  }

  // Compare against baseline for regression detection
  const baseline = getTestBaseline(suite);
  let regressionDetected = false;
  let regressionSummary: string | null = null;
  if (baseline) {
    if (failed > baseline.failed || passed < baseline.passed) {
      regressionDetected = true;
      regressionSummary = `Regression vs baseline (${baseline.capturedAt}): passed ${passed} (baseline ${baseline.passed}), failed ${failed} (baseline ${baseline.failed}).`;
    }
  }

  const durationMs = Date.now() - start;
  const db = getDb();
  db.prepare(
    `INSERT INTO test_runs (id, project_id, suite_name, command, status, passed, failed, duration_ms, output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options?.projectId || null,
    suite,
    cmd,
    status,
    passed,
    failed,
    durationMs,
    output.slice(0, 12000),
    createdAt
  );

  logAudit('info', 'testing_lab', 'test_run', {
    suite,
    status,
    passed,
    failed,
    regressionDetected,
    durationMs,
  });

  return {
    id,
    projectId: options?.projectId || null,
    suiteName: suite,
    command: cmd,
    status,
    passed,
    failed,
    durationMs,
    regressionDetected,
    regressionSummary,
    output: output.slice(0, 12000),
    createdAt,
  };
}

export function listProjects(): Array<Record<string, unknown>> {
  const db = getDb();
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Array<
    Record<string, unknown>
  >;
}

export function listBugRecords(limit = 50): BugFinding[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM bug_records ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    projectId: r.project_id ? String(r.project_id) : null,
    title: String(r.title),
    severity: r.severity as BugFinding['severity'],
    category: String(r.category),
    filePath: r.file_path ? String(r.file_path) : null,
    lineNumber: r.line_number ? Number(r.line_number) : null,
    evidence: String(r.evidence),
    rootCause: r.root_cause ? String(r.root_cause) : null,
    status: r.status as BugFinding['status'],
    verified: Boolean(r.verified),
    createdAt: String(r.created_at),
  }));
}

export function listTestRuns(limit = 25): TestRunResult[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM test_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    projectId: r.project_id ? String(r.project_id) : null,
    suiteName: String(r.suite_name),
    command: String(r.command),
    status: r.status as TestRunResult['status'],
    passed: Number(r.passed),
    failed: Number(r.failed),
    durationMs: Number(r.duration_ms),
    output: String(r.output),
    createdAt: String(r.created_at),
  }));
}

export interface RepairIterationStep {
  iteration: number;
  phase: 'analyze' | 'edit' | 'test' | 'diagnose' | 'repair' | 'verify';
  status: 'passed' | 'failed' | 'applied';
  summary: string;
}

export async function runIterativeRepairLoop(options?: {
  label?: string;
  suite?: 'typecheck' | 'vitest';
  specificFile?: string;
  maxIterations?: number;
  candidateFixes?: Array<Array<{ path: string; content: string }>>;
  autoRollbackOnFail?: boolean;
}): Promise<{
  ok: boolean;
  verified: boolean;
  stoppedReason: 'verified_clean' | 'max_iterations_reached' | 'no_remaining_fixes';
  iterationsRun: number;
  maxIterations: number;
  checkpointId: string | null;
  rolledBack: boolean;
  trace: RepairIterationStep[];
  finalTestRun: TestRunResult;
}> {
  const suite = options?.suite || 'typecheck';
  const maxIterations = Math.min(Math.max(1, options?.maxIterations ?? 3), 5);
  const candidateFixes = options?.candidateFixes || [];
  const allAffectedPaths = Array.from(
    new Set(candidateFixes.flatMap((batch) => batch.map((f) => f.path)))
  );

  const checkpointId =
    allAffectedPaths.length > 0
      ? createFileCheckpoint(
          allAffectedPaths,
          options?.label || 'Autonomous iterative repair checkpoint'
        )
      : null;

  const trace: RepairIterationStep[] = [];

  // Phase 1: Analyze & initial verification test
  const analysis = await analyzeProject('.');
  trace.push({
    iteration: 0,
    phase: 'analyze',
    status: 'passed',
    summary: `Analyzed ${analysis.name} (${analysis.language}, ${analysis.fileCount} files)`,
  });

  let currentRun = await executeRealTests({
    suite,
    specificFile: options?.specificFile,
  });
  trace.push({
    iteration: 0,
    phase: 'test',
    status: currentRun.status === 'passed' ? 'passed' : 'failed',
    summary: `Initial ${suite} run: ${currentRun.status} (${currentRun.passed} passed, ${currentRun.failed} failed)`,
  });

  if (currentRun.status === 'passed') {
    return {
      ok: true,
      verified: true,
      stoppedReason: 'verified_clean',
      iterationsRun: 0,
      maxIterations,
      checkpointId,
      rolledBack: false,
      trace,
      finalTestRun: currentRun,
    };
  }

  let iterationsRun = 0;
  for (let i = 0; i < maxIterations; i++) {
    const batch = candidateFixes[i];
    if (!batch || batch.length === 0) {
      trace.push({
        iteration: i + 1,
        phase: 'diagnose',
        status: 'failed',
        summary: `No remaining candidate repair patch for iteration ${i + 1}; stopping safely.`,
      });
      break;
    }

    iterationsRun++;
    for (const fileEdit of batch) {
      const abs = resolveSafeWorkspacePath(fileEdit.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fileEdit.content, 'utf8');
    }
    trace.push({
      iteration: i + 1,
      phase: 'repair',
      status: 'applied',
      summary: `Applied repair batch (${batch.map((b) => b.path).join(', ')})`,
    });

    currentRun = await executeRealTests({
      suite,
      specificFile: options?.specificFile,
    });
    trace.push({
      iteration: i + 1,
      phase: 'verify',
      status: currentRun.status === 'passed' ? 'passed' : 'failed',
      summary: `Retest ${suite}: ${currentRun.status} (${currentRun.passed} passed, ${currentRun.failed} failed)`,
    });

    if (currentRun.status === 'passed') {
      logAudit('info', 'software_engineer', 'iterative_repair_verified', {
        iterationsRun,
        suite,
      });
      return {
        ok: true,
        verified: true,
        stoppedReason: 'verified_clean',
        iterationsRun,
        maxIterations,
        checkpointId,
        rolledBack: false,
        trace,
        finalTestRun: currentRun,
      };
    }
  }

  let rolledBack = false;
  if (checkpointId && options?.autoRollbackOnFail !== false) {
    restoreFileCheckpoint(checkpointId);
    rolledBack = true;
    logAudit('warn', 'software_engineer', 'iterative_repair_rolled_back', {
      checkpointId,
      iterationsRun,
    });
  }

  return {
    ok: false,
    verified: false,
    stoppedReason:
      iterationsRun >= maxIterations ? 'max_iterations_reached' : 'no_remaining_fixes',
    iterationsRun,
    maxIterations,
    checkpointId,
    rolledBack,
    trace,
    finalTestRun: currentRun,
  };
}
