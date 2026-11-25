import {
  BookmarkCheck,
  Bug,
  FileCode2,
  FlaskConical,
  FolderGit2,
  Play,
  Save,
  Search,
  ShieldCheck,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { jarvisApi } from '../lib/api';

interface EngineeringViewProps {
  mode: 'projects' | 'engineer';
}

export function EngineeringView({ mode }: EngineeringViewProps) {
  const [projects, setProjects] = useState<any[]>([]);
  const [bugs, setBugs] = useState<any[]>([]);
  const [testRuns, setTestRuns] = useState<any[]>([]);
  const [testEnv, setTestEnv] = useState<any | null>(null);
  const [baseline, setBaseline] = useState<any | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [fileQuery, setFileQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [diffPreview, setDiffPreview] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = async () => {
    const [p, b, t, f, env, base] = await Promise.all([
      jarvisApi.listProjects(),
      jarvisApi.listBugs(),
      jarvisApi.listTests(),
      jarvisApi.listFiles(fileQuery),
      jarvisApi.getEngineeringEnv(),
      jarvisApi.getBaseline('vitest'),
    ]);
    setProjects(p.projects || []);
    setBugs(b.bugs || []);
    setTestRuns(t.runs || []);
    setFiles(f.files || []);
    setTestEnv(env);
    setBaseline(base.baseline || null);
  };

  useEffect(() => {
    void loadAll();
  }, [mode]);

  const handleAnalyzeWorkspace = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await jarvisApi.analyzeProject('.');
      setStatusMsg(`Analyzed ${res.name} (${res.language} / ${res.framework}, ${res.fileCount} files)`);
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const handleBugScan = async () => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await jarvisApi.scanBugs();
      setStatusMsg(`Bug scan finished: ${res.findings?.length || 0} finding(s) recorded.`);
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const handleRunTests = async (suite: 'typecheck' | 'vitest') => {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await jarvisApi.runTests(suite);
      const regNote = res.regressionDetected ? ` — REGRESSION: ${res.regressionSummary}` : '';
      setStatusMsg(
        `Suite "${suite}" ${res.status} (${res.passed} passed, ${res.failed} failed in ${res.durationMs}ms)${regNote}`
      );
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateTests = async () => {
    const target = selectedFile?.endsWith('.ts') ? selectedFile : 'server/ai/engine.ts';
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await jarvisApi.generateTests(target, true);
      setStatusMsg(
        `Generated ${res.generatedTestPath} (${res.exportedSymbols?.length || 0} exported function checks). Run status: ${res.runResult?.status || 'created'} (${res.runResult?.passed ?? 0} passed).`
      );
      await loadAll();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Unable to generate tests');
    } finally {
      setBusy(false);
    }
  };

  const handleCaptureBaseline = async () => {
    const lastVitest = testRuns.find((r) => r.suiteName === 'vitest');
    if (!lastVitest) {
      setStatusMsg('Run Vitest Suite once before capturing a regression baseline.');
      return;
    }
    const saved = await jarvisApi.saveBaseline({
      suiteName: 'vitest',
      passed: lastVitest.passed,
      failed: lastVitest.failed,
    });
    setBaseline(saved);
    setStatusMsg(
      `Captured Vitest baseline: ${saved.passed} passed, ${saved.failed} failed at ${saved.capturedAt}`
    );
  };

  const handleOpenFile = async (relPath: string) => {
    const res = await jarvisApi.readFile(relPath);
    setSelectedFile(relPath);
    setFileContent(res.content || '');
    setDiffPreview(null);
  };

  const handleSaveFile = async () => {
    if (!selectedFile) return;
    const res = await jarvisApi.writeFile(selectedFile, fileContent);
    setStatusMsg(
      `Saved ${res.relativePath} (${res.bytesWritten} bytes) with checkpoint ${res.checkpointId.slice(0, 8)}`
    );
  };

  const handleAtomicVerifiedSave = async () => {
    if (!selectedFile) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await jarvisApi.multiEdit({
        label: `Verified edit ${selectedFile}`,
        changes: [{ path: selectedFile, content: fileContent }],
        verifyTypecheck: true,
        autoRollbackOnFail: true,
      });
      setDiffPreview((res.diffs || []).join('\n\n'));
      if (res.ok) {
        setStatusMsg(`Atomic edit verified cleanly via TypeScript (checkpoint ${res.checkpointId.slice(0, 8)}).`);
      } else {
        setStatusMsg(
          `TypeScript verification failed and automatically rolled back ${selectedFile} (checkpoint ${res.checkpointId.slice(0, 8)}).`
        );
        const reloaded = await jarvisApi.readFile(selectedFile);
        setFileContent(reloaded.content || '');
      }
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'projects') {
    return (
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#1F2937]">
              Projects &amp; Continuous Guardian
            </h2>
            <p className="text-xs text-slate-500">
              Incremental workspace inspection, git monitoring, and verified test history.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAnalyzeWorkspace()}
            className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40 whitespace-nowrap"
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            <span>{busy ? 'Scanning...' : 'Scan Current Workspace'}</span>
          </button>
        </div>

        {statusMsg && (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-[#1F2937]">
            {statusMsg}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {projects.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
              No projects indexed yet. Click &ldquo;Scan Current Workspace&rdquo; to detect language, framework, and dependencies.
            </div>
          ) : (
            projects.map((p) => {
              const meta = JSON.parse(p.metadata_json || '{}');
              return (
                <div key={p.id} className="rounded-lg border border-slate-200 bg-white p-5">
                  <div className="flex items-center justify-between">
                    <div className="font-display text-base font-semibold text-[#1F2937]">
                      {p.name}
                    </div>
                    <span className="text-xs font-medium text-[#16A34A]">{p.health_status}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {p.language} · {p.framework} · {p.package_manager}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs tabular-nums">
                    <div>
                      <div className="text-slate-400">Files</div>
                      <div className="font-mono font-medium text-[#1F2937]">{meta.fileCount || 0}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Dependencies</div>
                      <div className="font-mono font-medium text-[#1F2937]">
                        {meta.dependenciesCount || 0}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Git Branch</div>
                      <div className="font-mono font-medium text-[#1F2937]">
                        {meta.gitBranch || 'none'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#1F2937]">
            Software Engineer, Bug Hunter &amp; Testing Lab
          </h2>
          <p className="text-xs text-slate-500">
            Workspace-confined multi-file editor with automatic TypeScript verification &amp; rollback checkpoints, unit test generation, and regression baselines.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleBugScan()}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#1F2937] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            <Bug className="h-3.5 w-3.5 text-[#FF7A00]" />
            <span>Bug Scan</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleGenerateTests()}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#1F2937] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            <FlaskConical className="h-3.5 w-3.5 text-[#FF7A00]" />
            <span>Generate Tests</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleCaptureBaseline()}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#1F2937] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            <BookmarkCheck className="h-3.5 w-3.5" />
            <span>Save Baseline</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRunTests('typecheck')}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#1F2937] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            <Play className="h-3.5 w-3.5" />
            <span>Typecheck</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRunTests('vitest')}
            className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40 whitespace-nowrap"
          >
            <Play className="h-3.5 w-3.5" />
            <span>Run Vitest Suite</span>
          </button>
        </div>
      </div>

      {/* Test Environment & Baseline Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600 tabular-nums">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Node: <strong className="font-mono text-[#1F2937]">{testEnv?.node || '—'}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Vitest: <strong className="text-[#1F2937]">{testEnv?.vitestAvailable ? 'Ready' : 'Missing'}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            TypeScript: <strong className="text-[#1F2937]">{testEnv?.typescriptAvailable ? 'Ready' : 'Missing'}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Missing Tools: <strong className="text-[#1F2937]">{testEnv?.missingTools?.length ? testEnv.missingTools.join(', ') : 'None'}</strong>
          </span>
        </div>
        <div>
          Regression Baseline:{' '}
          <strong className="font-mono text-[#1F2937]">
            {baseline ? `${baseline.passed} passed / ${baseline.failed} failed` : 'Not captured yet'}
          </strong>
        </div>
      </div>

      {statusMsg && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-[#1F2937]">
          {statusMsg}
        </div>
      )}

      {/* Workspace File Explorer & Checkpointed Editor */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={fileQuery}
              onChange={(e) => {
                setFileQuery(e.target.value);
                void jarvisApi.listFiles(e.target.value).then((r) => setFiles(r.files || []));
              }}
              placeholder="Filter workspace files..."
              className="w-full rounded-md border border-slate-200 py-1.5 pr-3 pl-8 text-xs focus:border-[#FF7A00] focus:outline-none"
            />
          </div>
          <div className="mt-3 max-h-72 space-y-0.5 overflow-y-auto">
            {files
              .filter((f) => !f.isDirectory)
              .slice(0, 60)
              .map((f) => (
                <button
                  key={f.relativePath}
                  type="button"
                  onClick={() => void handleOpenFile(f.relativePath)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${
                    selectedFile === f.relativePath
                      ? 'bg-slate-100 font-medium text-[#1F2937]'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate font-mono text-[11px]">{f.relativePath}</span>
                  </span>
                </button>
              ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
            <span className="font-mono text-xs text-[#1F2937]">
              {selectedFile || 'Select a file to inspect or edit'}
            </span>
            {selectedFile && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveFile()}
                  className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-[#1F2937] hover:bg-slate-50"
                >
                  <Save className="h-3 w-3" />
                  <span>Save Checkpoint</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAtomicVerifiedSave()}
                  className="flex items-center gap-1 rounded bg-[#1F2937] px-3 py-1 text-xs font-medium text-white hover:bg-slate-800"
                >
                  <ShieldCheck className="h-3 w-3 text-[#FF7A00]" />
                  <span>Verify Typecheck &amp; Save</span>
                </button>
              </div>
            )}
          </div>
          <textarea
            rows={13}
            value={fileContent}
            onChange={(e) => setFileContent(e.target.value)}
            readOnly={!selectedFile}
            className="mt-3 w-full resize-none rounded border border-slate-200 bg-slate-50/50 p-3 font-mono text-xs text-[#1F2937] focus:border-[#FF7A00] focus:outline-none"
          />
          {diffPreview && (
            <pre className="mt-3 max-h-40 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
              {diffPreview}
            </pre>
          )}
        </div>
      </div>

      {/* Real Test Runs & Discovered Bugs */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="font-display text-sm font-semibold text-[#1F2937]">
            Real Test Execution History ({testRuns.length})
          </h3>
          <div className="mt-3 space-y-2.5">
            {testRuns.length === 0 ? (
              <p className="text-xs text-slate-500">No test suites executed yet.</p>
            ) : (
              testRuns.slice(0, 6).map((tr) => (
                <div key={tr.id} className="border-b border-slate-100 pb-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-medium text-[#1F2937]">{tr.command}</span>
                    <span
                      className={`font-medium ${
                        tr.status === 'passed' ? 'text-[#16A34A]' : 'text-red-600'
                      }`}
                    >
                      {tr.status}
                    </span>
                  </div>
                  <div className="mt-1 text-slate-500 tabular-nums">
                    Passed: {tr.passed} · Failed: {tr.failed} · Duration: {tr.durationMs}ms
                    {tr.regressionDetected ? ' · REGRESSION DETECTED' : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="font-display text-sm font-semibold text-[#1F2937]">
            Bug Hunter Evidence Log ({bugs.length})
          </h3>
          <div className="mt-3 space-y-2.5">
            {bugs.length === 0 ? (
              <p className="text-xs text-slate-500">
                No verified defects logged. Run a Bug Scan to verify TypeScript and security hygiene.
              </p>
            ) : (
              bugs.slice(0, 6).map((b) => (
                <div key={b.id} className="border-b border-slate-100 pb-2.5 text-xs">
                  <div className="font-medium text-[#1F2937]">{b.title}</div>
                  <div className="mt-0.5 text-slate-500">
                    {b.severity} · {b.category} · {b.filePath || 'workspace'}
                    {b.lineNumber ? `:${b.lineNumber}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
