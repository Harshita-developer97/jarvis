import { CheckCircle2, Cpu, Download, HardDrive, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { jarvisApi } from '../lib/api';
import type { InferenceMode } from '../types/jarvis';

interface SetupWizardModalProps {
  open: boolean;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}

export function SetupWizardModal({ open, onClose, onCompleted }: SetupWizardModalProps) {
  const [inspection, setInspection] = useState<any | null>(null);
  const [language, setLanguage] = useState<'auto' | 'en' | 'hi' | 'hinglish'>('auto');
  const [wakeWord, setWakeWord] = useState('Hey Jarvis');
  const [ollamaUrl, setOllamaUrl] = useState('http://127.0.0.1:11434');
  const [inferenceMode, setInferenceMode] = useState<InferenceMode>('local_only');
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPullStatus(null);
    setActionError(null);
    void Promise.all([jarvisApi.inspectSetup(), jarvisApi.getAutostart()])
      .then(([data, auto]) => {
        setInspection(data);
        if (data.voice?.config?.language) setLanguage(data.voice.config.language);
        if (data.voice?.config?.wakeWord) setWakeWord(data.voice.config.wakeWord);
        if (data.ai?.ollamaUrl) setOllamaUrl(data.ai.ollamaUrl);
        if (data.ai?.inferenceMode) setInferenceMode(data.ai.inferenceMode);
        if (typeof auto?.enabled === 'boolean') setAutostartEnabled(auto.enabled);
      })
      .catch((err) => {
        setActionError(err instanceof Error ? err.message : 'Unable to probe setup status');
      });
  }, [open]);

  if (!open) return null;

  const handlePullRecommended = async () => {
    setPulling(true);
    setPullStatus(null);
    try {
      const res = await jarvisApi.pullModel('qwen2.5:3b');
      setPullStatus(res.message || 'Model pulled cleanly.');
      const refreshed = await jarvisApi.inspectSetup();
      setInspection(refreshed);
    } catch (err) {
      setPullStatus(err instanceof Error ? err.message : 'Unable to pull model from Ollama');
    } finally {
      setPulling(false);
    }
  };

  const handleFinish = async () => {
    setSaving(true);
    setActionError(null);
    try {
      await jarvisApi.completeSetup({
        language,
        wakeWord,
        ollamaUrl,
        inferenceMode,
        allowCloudFallback: inferenceMode === 'cloud_assisted',
      });
      await jarvisApi.setAutostart(autostartEnabled);
      await onCompleted();
      onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save setup configuration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#1F2937]">
              JARVIS Hardware &amp; Local Setup Wizard
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Live hardware probe, 8 GB RAM local model setup, and Windows 11 startup configuration.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-[#1F2937]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!inspection ? (
          <div className="py-10 text-center text-sm text-slate-500">
            Probing CPU, RAM, GPU, SQLite, voice binaries, and AI engines...
          </div>
        ) : (
          <div className="mt-5 space-y-5 text-xs">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-3.5">
                <div className="flex items-center gap-1.5 font-semibold text-[#1F2937]">
                  <Cpu className="h-4 w-4 text-[#FF7A00]" />
                  <span>Compute &amp; Memory Profile</span>
                </div>
                <div className="mt-2 space-y-1 text-slate-600 tabular-nums">
                  <div>
                    OS: {inspection.telemetry.os.platform} {inspection.telemetry.os.arch}
                  </div>
                  <div>
                    CPU: {inspection.telemetry.cpu.cores} cores · {inspection.telemetry.cpu.model}
                  </div>
                  <div>
                    RAM:{' '}
                    {(inspection.telemetry.memory.totalBytes / 1024 ** 3).toFixed(1)} GB total ·{' '}
                    {inspection.targetProfile}
                  </div>
                  <div>Recommended Model: {inspection.recommendedModel}</div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 p-3.5">
                <div className="flex items-center gap-1.5 font-semibold text-[#1F2937]">
                  <HardDrive className="h-4 w-4 text-[#FF7A00]" />
                  <span>Detected Engines &amp; Tools</span>
                </div>
                <div className="mt-2 space-y-1 text-slate-600">
                  <div>
                    Ollama: {inspection.ai.ollamaReachable ? 'Connected' : 'Not detected'}
                  </div>
                  <div>
                    llama.cpp: {inspection.ai.llamacppReachable ? 'Connected' : 'Not detected'}
                  </div>
                  <div>
                    Gemini Key:{' '}
                    {inspection.ai.geminiConfigured ? 'Configured on server' : 'Not set'}
                  </div>
                  <div>
                    SQLite: {inspection.telemetry.runtimes.sqlite} · Git:{' '}
                    {inspection.telemetry.runtimes.git ? 'Ready' : 'Missing'}
                  </div>
                </div>
              </div>
            </div>

            {inspection.missingDependencies.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3.5 text-amber-950">
                <div className="font-semibold">Missing / Optional Native Dependencies</div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4">
                  {inspection.missingDependencies.map((dep: string) => (
                    <li key={dep}>{dep}</li>
                  ))}
                </ul>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={pulling}
                    onClick={() => void handlePullRecommended()}
                    className="flex items-center gap-1.5 rounded bg-[#1F2937] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{pulling ? 'Pulling qwen2.5:3b...' : 'Pull qwen2.5:3b via Ollama'}</span>
                  </button>
                  <span className="text-[11px] text-amber-900">
                    Windows 11 Guided Installer: <code className="font-mono">scripts\windows\install-jarvis.ps1</code>
                  </span>
                </div>
                {pullStatus && <div className="mt-2 font-mono text-[11px]">{pullStatus}</div>}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block font-medium text-slate-600">Language Mode</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as any)}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2"
                >
                  <option value="auto">Auto (EN / HI / Hinglish)</option>
                  <option value="en">English</option>
                  <option value="hinglish">Hinglish</option>
                  <option value="hi">Hindi</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-600">Wake Word</label>
                <input
                  value={wakeWord}
                  onChange={(e) => setWakeWord(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-2"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600">Ollama URL</label>
                <input
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-2 font-mono"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="font-medium text-[#1F2937]">Inference Privacy Mode</div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setInferenceMode('local_only')}
                    className={`flex-1 rounded px-2.5 py-1.5 font-medium ${
                      inferenceMode === 'local_only'
                        ? 'bg-[#1F2937] text-white'
                        : 'border border-slate-200 text-slate-600'
                    }`}
                  >
                    Local Only (Default)
                  </button>
                  <button
                    type="button"
                    onClick={() => setInferenceMode('cloud_assisted')}
                    className={`flex-1 rounded px-2.5 py-1.5 font-medium ${
                      inferenceMode === 'cloud_assisted'
                        ? 'bg-[#FF7A00] text-white'
                        : 'border border-slate-200 text-slate-600'
                    }`}
                  >
                    Cloud Assisted
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 p-3 text-slate-700">
                <input
                  type="checkbox"
                  checked={autostartEnabled}
                  onChange={(e) => setAutostartEnabled(e.target.checked)}
                  className="accent-[#FF7A00]"
                />
                <span>Launch JARVIS automatically on Windows 11 sign-in</span>
              </label>
            </div>

            {actionError && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {actionError}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-200 px-4 py-2 font-medium text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleFinish()}
                className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 font-semibold text-white hover:bg-[#e56d00]"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>{saving ? 'Saving...' : 'Save Configuration'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
