import { Download, Globe, Plus, Search, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { jarvisApi } from '../lib/api';
import type { MemoryItem } from '../types/jarvis';

interface MemoryResearchViewProps {
  mode: 'memory' | 'research';
}

export function MemoryResearchView({ mode }: MemoryResearchViewProps) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [category, setCategory] = useState('all');
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState('fact');
  const [memError, setMemError] = useState<string | null>(null);

  const [researchQuery, setResearchQuery] = useState('');
  const [researchUrl, setResearchUrl] = useState('');
  const [reports, setReports] = useState<any[]>([]);
  const [browserResult, setBrowserResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMemories = async (q = searchQ, cat = category) => {
    const res = await jarvisApi.listMemory(q, cat);
    setMemories(res.items || []);
  };

  const loadResearch = async () => {
    const res = await jarvisApi.listResearch();
    setReports(res.reports || []);
  };

  useEffect(() => {
    if (mode === 'memory') void loadMemories();
    else void loadResearch();
  }, [mode]);

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    setMemError(null);
    try {
      await jarvisApi.createMemory({
        category: newCategory,
        title: newTitle.trim(),
        content: newContent.trim(),
        source: 'owner_manual',
      });
      setNewTitle('');
      setNewContent('');
      await loadMemories();
    } catch (err) {
      setMemError(err instanceof Error ? err.message : 'Unable to save memory');
    }
  };

  const handleExportMemories = () => {
    const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jarvis-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRunResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!researchQuery.trim()) return;
    setBusy(true);
    try {
      const urls = researchUrl.trim() ? [researchUrl.trim()] : undefined;
      await jarvisApi.runResearch(researchQuery.trim(), urls);
      setResearchQuery('');
      await loadResearch();
    } finally {
      setBusy(false);
    }
  };

  const handleInspectUrl = async () => {
    if (!researchUrl.trim()) return;
    setBusy(true);
    try {
      const page = await jarvisApi.inspectUrl(researchUrl.trim());
      setBrowserResult(page);
    } catch (err) {
      setBrowserResult({ error: err instanceof Error ? err.message : 'Blocked or unreachable' });
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'research') {
    return (
      <div className="space-y-6 p-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="font-display text-base font-semibold text-[#1F2937]">
            Research &amp; SSRF-Protected Browser Agent
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Combines local SQLite memory with authorized HTTP/DOM inspection and source citations.
          </p>
          <form onSubmit={handleRunResearch} className="mt-4 space-y-3">
            <input
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="Research topic or question..."
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <div className="flex flex-wrap gap-2">
              <input
                value={researchUrl}
                onChange={(e) => setResearchUrl(e.target.value)}
                placeholder="Optional public https:// URL to inspect..."
                className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !researchUrl.trim()}
                onClick={() => void handleInspectUrl()}
                className="rounded-md border border-slate-200 px-3.5 py-2 text-xs font-medium text-[#1F2937] hover:bg-slate-50 disabled:opacity-40"
              >
                Inspect DOM
              </button>
              <button
                type="submit"
                disabled={busy || !researchQuery.trim()}
                className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40"
              >
                <Globe className="h-3.5 w-3.5" />
                <span>{busy ? 'Researching...' : 'Run Research'}</span>
              </button>
            </div>
          </form>
        </div>

        {browserResult && (
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
            {browserResult.error ? (
              <div className="text-red-600">{browserResult.error}</div>
            ) : (
              <div className="space-y-2">
                <div className="font-semibold text-[#1F2937]">
                  {browserResult.title} · HTTP {browserResult.status}
                </div>
                <div className="text-slate-500">
                  Links: {browserResult.links?.length || 0} · Forms: {browserResult.formsCount} ·
                  CAPTCHA: {browserResult.captchaDetected ? 'Detected (Owner Required)' : 'None'}
                </div>
                <p className="leading-relaxed text-slate-600">{browserResult.textExcerpt}</p>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          <h3 className="font-display text-base font-semibold text-[#1F2937]">
            Saved Research Reports ({reports.length})
          </h3>
          {reports.map((rep) => (
            <div key={rep.id} className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-[#1F2937]">
                  {rep.query}
                </span>
                <span className="text-slate-500 tabular-nums">
                  {rep.mode} · {new Date(rep.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 leading-relaxed text-slate-600">{rep.summary}</p>
              {rep.sources && rep.sources.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">
                  {rep.sources.map((s: any, idx: number) => (
                    <div key={idx} className="text-slate-500">
                      {s.title} — <span className="font-mono">{s.url}</span> ({s.reliability})
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          onSubmit={handleAddMemory}
          className="rounded-lg border border-slate-200 bg-white p-5"
        >
          <h2 className="font-display text-base font-semibold text-[#1F2937]">
            Store Persistent Memory
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Indexed with SQLite FTS5 + semantic ranking. Credentials and secrets are automatically blocked.
          </p>
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs"
              >
                <option value="fact">Fact</option>
                <option value="preference">Preference</option>
                <option value="instruction">Instruction</option>
                <option value="project">Project</option>
                <option value="technical">Technical</option>
                <option value="business">Business</option>
                <option value="decision">Decision</option>
                <option value="lesson">Lesson</option>
              </select>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Memory title..."
                className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
              />
            </div>
            <textarea
              rows={2}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Knowledge, preference, or verified lesson..."
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            {memError && <div className="text-xs text-red-600">{memError}</div>}
            <button
              type="submit"
              disabled={!newTitle.trim() || !newContent.trim()}
              className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Save Memory</span>
            </button>
          </div>
        </form>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-[#1F2937]">
              Search &amp; Export Knowledge Brain
            </h2>
            <button
              type="button"
              onClick={handleExportMemories}
              className="flex items-center gap-1 text-xs font-medium text-[#1F2937] hover:text-[#FF7A00]"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export JSON</span>
            </button>
          </div>
          <div className="mt-4 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
              <input
                value={searchQ}
                onChange={(e) => {
                  setSearchQ(e.target.value);
                  void loadMemories(e.target.value, category);
                }}
                placeholder="FTS5 + semantic search..."
                className="w-full rounded-md border border-slate-200 py-2 pr-3 pl-9 text-sm focus:border-[#FF7A00] focus:outline-none"
              />
            </div>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                void loadMemories(searchQ, e.target.value);
              }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs"
            >
              <option value="all">All Categories</option>
              <option value="preference">Preference</option>
              <option value="instruction">Instruction</option>
              <option value="project">Project</option>
              <option value="technical">Technical</option>
              <option value="business">Business</option>
              <option value="fact">Fact</option>
              <option value="lesson">Lesson</option>
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {memories.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
            No matching memories stored yet.
          </div>
        ) : (
          memories.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="min-w-0">
                <div className="text-xs text-slate-500">
                  {m.category} · importance {Math.round(m.importance * 100)}% · {m.source}
                  {m.contradictsId ? ' · Contradicts prior entry' : ''}
                </div>
                <div className="mt-1 font-display text-sm font-semibold text-[#1F2937]">
                  {m.title}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">{m.content}</p>
              </div>
              <button
                type="button"
                onClick={() => void jarvisApi.deleteMemory(m.id).then(() => loadMemories())}
                className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                title="Delete memory"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
