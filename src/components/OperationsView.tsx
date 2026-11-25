import { Database, Download, Monitor, Play, Plus, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { AudioDeviceSummary } from '../hooks/useVoiceAssistant';
import { jarvisApi } from '../lib/api';
import type { AIEngineStatus, InferenceMode, SystemTelemetry, VoiceConfig } from '../types/jarvis';

interface OperationsViewProps {
  mode: 'automations' | 'devices' | 'health' | 'settings';
  telemetry: SystemTelemetry | null;
  aiStatus: AIEngineStatus | null;
  voiceConfig: VoiceConfig;
  voiceDevices: {
    inputDevices: AudioDeviceSummary[];
    outputDevices: AudioDeviceSummary[];
  };
  onUpdateVoiceConfig: (patch: Partial<VoiceConfig>) => Promise<void>;
  onSwitchInferenceMode: (mode: InferenceMode) => Promise<void>;
  onRefreshAI: () => Promise<void>;
}

export function OperationsView({
  mode,
  telemetry,
  aiStatus,
  voiceConfig,
  voiceDevices,
  onUpdateVoiceConfig,
  onSwitchInferenceMode,
  onRefreshAI,
}: OperationsViewProps) {
  const [automations, setAutomations] = useState<any[]>([]);
  const [autoRuns, setAutoRuns] = useState<any[]>([]);
  const [autoName, setAutoName] = useState('');

  const [devices, setDevices] = useState<any[]>([]);
  const [devName, setDevName] = useState('');
  const [devPlatform, setDevPlatform] = useState<'android' | 'windows' | 'linux'>('android');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const [toolsData, setToolsData] = useState<{ tools: any[]; executions: any[] }>({ tools: [], executions: [] });
  const [dbStatus, setDbStatus] = useState<any | null>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [ollamaUrl, setOllamaUrl] = useState(aiStatus?.ollamaUrl || 'http://127.0.0.1:11434');
  const [pullModelName, setPullModelName] = useState('qwen2.5:3b');
  const [pullingModel, setPullingModel] = useState(false);
  const [desktopCaps, setDesktopCaps] = useState<any | null>(null);
  const [autostart, setAutostart] = useState<any | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadData = async () => {
    if (mode === 'automations') {
      const res = await jarvisApi.getAutomations();
      setAutomations(res.automations || []);
      setAutoRuns(res.runs || []);
    } else if (mode === 'devices') {
      const res = await jarvisApi.listDevices();
      setDevices(res.devices || []);
    } else if (mode === 'settings') {
      const [caps, auto] = await Promise.all([
        jarvisApi.getDesktopCapabilities(),
        jarvisApi.getAutostart(),
      ]);
      setDesktopCaps(caps);
      setAutostart(auto);
    } else if (mode === 'health') {
      const [tools, db, audit] = await Promise.all([
        jarvisApi.getTools(),
        jarvisApi.getDatabaseStatus(),
        jarvisApi.getAuditLogs(60),
      ]);
      setToolsData(tools);
      setDbStatus(db);
      setAuditLogs(audit.logs || []);
    }
  };

  useEffect(() => {
    void loadData();
  }, [mode]);

  if (mode === 'automations') {
    return (
      <div className="space-y-6 p-6">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!autoName.trim()) return;
            await jarvisApi.createAutomation({
              name: autoName.trim(),
              description: 'Scheduled typecheck guardian',
              triggerType: 'interval',
              intervalSeconds: 600,
              actionType: 'typecheck_guardian',
            });
            setAutoName('');
            await loadData();
          }}
          className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-4"
        >
          <input
            value={autoName}
            onChange={(e) => setAutoName(e.target.value)}
            placeholder="New automation workflow name..."
            className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
          />
          <button
            type="submit"
            className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create Interval Rule</span>
          </button>
        </form>

        <div className="grid gap-4 md:grid-cols-2">
          {automations.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-[#1F2937]">{a.name}</span>
                <button
                  type="button"
                  onClick={() => void jarvisApi.toggleAutomation(a.id, !a.enabled).then(loadData)}
                  className={`rounded px-2.5 py-1 font-medium ${
                    a.enabled ? 'bg-[#1F2937] text-white' : 'border border-slate-200 text-slate-600'
                  }`}
                >
                  {a.enabled ? 'Enabled' : 'Paused'}
                </button>
              </div>
              <p className="mt-1.5 text-slate-600">{a.description}</p>
              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-slate-500 tabular-nums">
                <span>
                  {a.triggerType} ({a.intervalSeconds || 0}s) · Runs: {a.runCount}
                </span>
                <button
                  type="button"
                  onClick={() => void jarvisApi.runAutomationNow(a.id).then(loadData)}
                  className="flex items-center gap-1 font-medium text-[#FF7A00] hover:underline"
                >
                  <Play className="h-3 w-3" /> Run Now
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="font-display text-sm font-semibold text-[#1F2937]">
            Recent Automation Runs ({autoRuns.length})
          </h3>
          <div className="mt-3 space-y-2 text-xs">
            {autoRuns.slice(0, 10).map((r) => (
              <div key={r.id} className="flex justify-between border-b border-slate-100 pb-1.5">
                <span className="text-[#1F2937]">{r.summary}</span>
                <span className="font-mono text-slate-500 tabular-nums">{r.duration_ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'devices') {
    return (
      <div className="space-y-6 p-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="font-display text-base font-semibold text-[#1F2937]">
            Multi-Device Architecture &amp; Android Companion Pairing
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Issues scrypt-hashed bearer tokens for paired Windows, Linux, or Android companion clients over local LAN/VPN.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!devName.trim()) return;
              const res = await jarvisApi.pairDevice({
                name: devName.trim(),
                platform: devPlatform,
                deviceType: devPlatform === 'android' ? 'mobile' : 'desktop',
                capabilities: ['chat', 'voice', 'notifications', 'tasks'],
              });
              setIssuedToken(res.pairingToken);
              setDevName('');
              await loadData();
            }}
            className="mt-4 flex flex-wrap gap-2"
          >
            <input
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="Device name (e.g., Pixel 8 Companion)"
              className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <select
              value={devPlatform}
              onChange={(e) => setDevPlatform(e.target.value as any)}
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
            >
              <option value="android">Android</option>
              <option value="windows">Windows 11</option>
              <option value="linux">Linux</option>
            </select>
            <button
              type="submit"
              className="rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] whitespace-nowrap"
            >
              Pair Device
            </button>
          </form>

          {issuedToken && (
            <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
              One-time Pairing Token (copy now, stored only as scrypt hash on server):{' '}
              <span className="font-mono font-semibold">{issuedToken}</span>
            </div>
          )}
        </div>

        <div className="space-y-2.5">
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 text-xs"
            >
              <div className="flex items-center gap-3">
                <Smartphone className="h-4 w-4 text-[#FF7A00]" />
                <div>
                  <div className="font-semibold text-[#1F2937]">{d.name}</div>
                  <div className="text-slate-500">
                    {d.platform} · {d.deviceType} · {d.status} · Capabilities:{' '}
                    {d.capabilities.join(', ')}
                  </div>
                </div>
              </div>
              {d.status !== 'revoked' && (
                <button
                  type="button"
                  onClick={() => void jarvisApi.revokeDevice(d.id).then(loadData)}
                  className="flex items-center gap-1 text-red-600 hover:underline"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (mode === 'settings') {
    const inferenceMode = aiStatus?.inferenceMode || 'local_only';
    return (
      <div className="space-y-6 p-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-[#1F2937]">
              AI Engine, Local Models &amp; Privacy Switch
            </h2>
            <button
              type="button"
              onClick={() => void onRefreshAI()}
              className="flex items-center gap-1 text-xs font-medium text-[#1F2937] hover:text-[#FF7A00]"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh Engines
            </button>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 text-xs">
            <div>
              <label className="block font-medium text-slate-600">Inference Mode Switch</label>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => void onSwitchInferenceMode('local_only')}
                  className={`flex-1 rounded-md px-3 py-2 font-medium ${
                    inferenceMode === 'local_only'
                      ? 'bg-[#1F2937] text-white'
                      : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Local Only (Strict Offline)
                </button>
                <button
                  type="button"
                  onClick={() => void onSwitchInferenceMode('cloud_assisted')}
                  className={`flex-1 rounded-md px-3 py-2 font-medium ${
                    inferenceMode === 'cloud_assisted'
                      ? 'bg-[#FF7A00] text-white'
                      : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Cloud Assisted (Gemini)
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Local-Only Mode strictly blocks silent cloud fallback and only uses local Ollama or llama.cpp models.
              </p>
            </div>

            <div>
              <label className="block font-medium text-slate-600">Ollama Endpoint</label>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  className="flex-1 rounded-md border border-slate-200 px-3 py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() =>
                    void jarvisApi.saveAISettings({ ollamaUrl }).then(() => {
                      setActionMsg('Saved Ollama URL');
                      return onRefreshAI();
                    })
                  }
                  className="rounded-md bg-[#1F2937] px-3 py-1.5 font-medium text-white"
                >
                  Save
                </button>
              </div>

              <label className="mt-3 block font-medium text-slate-600">
                Pull Quantized Ollama Model (8 GB RAM)
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  value={pullModelName}
                  onChange={(e) => setPullModelName(e.target.value)}
                  placeholder="qwen2.5:3b"
                  className="flex-1 rounded-md border border-slate-200 px-3 py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  disabled={pullingModel}
                  onClick={async () => {
                    setPullingModel(true);
                    setActionMsg(null);
                    try {
                      const res = await jarvisApi.pullModel(pullModelName.trim());
                      setActionMsg(res.message);
                      await onRefreshAI();
                    } catch (err) {
                      setActionMsg(err instanceof Error ? err.message : 'Model pull failed');
                    } finally {
                      setPullingModel(false);
                    }
                  }}
                  className="flex items-center gap-1 rounded-md bg-[#FF7A00] px-3 py-1.5 font-medium text-white disabled:opacity-40 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>{pullingModel ? 'Pulling...' : 'Pull Model'}</span>
                </button>
              </div>
            </div>
          </div>

          {actionMsg && <div className="mt-3 text-xs text-[#1F2937]">{actionMsg}</div>}

          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="text-xs font-semibold text-[#1F2937]">
              Detected Models ({aiStatus?.models.length || 0})
            </div>
            {aiStatus && aiStatus.models.length > 0 ? (
              <div className="mt-2.5 space-y-2">
                {aiStatus.models.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-mono font-medium text-[#1F2937]">{m.name}</span>
                      <span className="ml-2 text-slate-500">
                        {m.provider} · {m.tier} · ~{m.ramEstimateGb} GB RAM ·{' '}
                        {m.loaded ? 'Loaded' : 'Idle'}
                      </span>
                    </div>
                    {m.provider === 'ollama' && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void jarvisApi.loadModel(m.name).then((r) => {
                              setActionMsg(r.message);
                              return onRefreshAI();
                            })
                          }
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50"
                        >
                          Load
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void jarvisApi.unloadModel(m.name).then((r) => {
                              setActionMsg(r.message);
                              return onRefreshAI();
                            })
                          }
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50"
                        >
                          Unload
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                {aiStatus?.reasonIfUnavailable || 'No models discovered.'}
              </p>
            )}
          </div>
        </div>

        {/* Voice, Audio Devices & VAD Preferences */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-xs">
          <h2 className="font-display text-base font-semibold text-[#1F2937]">
            Offline Voice, Audio Devices &amp; VAD Controls
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block font-medium text-slate-600">Wake Word</label>
              <input
                value={voiceConfig.wakeWord}
                onChange={(e) => void onUpdateVoiceConfig({ wakeWord: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-1.5"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600">
                Microphone Input Device
              </label>
              <select
                value={voiceConfig.inputDeviceId || 'default'}
                onChange={(e) => void onUpdateVoiceConfig({ inputDeviceId: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
              >
                <option value="default">System Default Microphone</option>
                {voiceDevices.inputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-600">
                Speaker Output Device
              </label>
              <select
                value={voiceConfig.outputDeviceId || 'default'}
                onChange={(e) => void onUpdateVoiceConfig({ outputDeviceId: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
              >
                <option value="default">System Default Speaker</option>
                {voiceDevices.outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-600">
                Speech Speed ({voiceConfig.speechRate}x)
              </label>
              <input
                type="range"
                min="0.6"
                max="1.6"
                step="0.1"
                value={voiceConfig.speechRate}
                onChange={(e) =>
                  void onUpdateVoiceConfig({ speechRate: Number(e.target.value) })
                }
                className="mt-2 w-full accent-[#FF7A00]"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-600">
                VAD Threshold ({voiceConfig.vadThreshold}%)
              </label>
              <input
                type="range"
                min="4"
                max="40"
                step="2"
                value={voiceConfig.vadThreshold}
                onChange={(e) =>
                  void onUpdateVoiceConfig({ vadThreshold: Number(e.target.value) })
                }
                className="mt-2 w-full accent-[#FF7A00]"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={voiceConfig.quietHoursEnabled}
                  onChange={(e) =>
                    void onUpdateVoiceConfig({ quietHoursEnabled: e.target.checked })
                  }
                  className="accent-[#FF7A00]"
                />
                <span>Quiet hours ({voiceConfig.quietHoursStart}–{voiceConfig.quietHoursEnd})</span>
              </label>
            </div>
          </div>
        </div>

        {/* Native Windows 11 Desktop & Startup Control */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-[#FF7A00]" />
              <h2 className="font-display text-base font-semibold text-[#1F2937]">
                Windows 11 Desktop Control &amp; Startup
              </h2>
            </div>
            <button
              type="button"
              onClick={async () => {
                const probe = await jarvisApi.runDesktopAction({ action: 'windows_diagnostics' });
                setActionMsg(
                  probe?.output?.available || probe?.available
                    ? `Desktop probe: ${JSON.stringify(probe.output || probe)}`
                    : probe?.output?.unavailableReason || probe?.unavailableReason || 'Probe unavailable on current OS'
                );
              }}
              className="rounded border border-slate-200 px-3 py-1.5 font-medium text-[#1F2937] hover:bg-slate-50 whitespace-nowrap"
            >
              Probe Desktop Control
            </button>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 text-slate-600">
              <div>
                Host OS: <strong className="font-mono text-[#1F2937]">{desktopCaps?.platform || telemetry?.os.platform}</strong>
              </div>
              <div>
                Native GUI Control: <strong className="text-[#1F2937]">{desktopCaps?.isWindows11 ? 'Active (Win32 + PowerShell + Tauri v2 Tray)' : 'Unavailable on Linux host'}</strong>
              </div>
              {desktopCaps?.blockedReason && (
                <div className="text-amber-700">{desktopCaps.blockedReason}</div>
              )}
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(autostart?.enabled)}
                  onChange={async (e) => {
                    const res = await jarvisApi.setAutostart(e.target.checked);
                    setAutostart({ ...autostart, enabled: res.enabled });
                    setActionMsg(res.message);
                  }}
                  className="accent-[#FF7A00]"
                />
                <span>Start JARVIS automatically on Windows 11 login</span>
              </label>
              {autostart?.reason && (
                <div className="text-[11px] text-slate-500">{autostart.reason}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // System Health, Tool Registry, SQLite Backups & Audit Logs
  return (
    <div className="space-y-6 p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
          <div className="text-slate-500">Host OS &amp; Node</div>
          <div className="mt-1 font-mono text-sm font-semibold text-[#1F2937]">
            {telemetry?.os.platform} ({telemetry?.os.arch})
          </div>
          <div className="mt-1 text-slate-500">Node {telemetry?.runtimes.node}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
          <div className="text-slate-500">CPU Utilization</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#1F2937] tabular-nums">
            {telemetry?.cpu.usagePercent ?? 0}%
          </div>
          <div className="mt-1 text-slate-500">{telemetry?.cpu.cores} cores</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
          <div className="text-slate-500">System RAM</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#1F2937] tabular-nums">
            {telemetry ? `${(telemetry.memory.usedBytes / 1024 ** 3).toFixed(2)} GB` : '—'}
          </div>
          <div className="mt-1 text-slate-500 tabular-nums">
            {telemetry?.memory.usagePercent}% used · {telemetry?.memory.pressure}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs">
          <div className="text-slate-500">SQLite Integrity</div>
          <div className="mt-1 font-mono text-sm font-semibold text-[#16A34A]">
            {dbStatus?.integrity?.ok ? 'OK' : 'Checking'} (v{dbStatus?.integrity?.schemaVersion ?? 1})
          </div>
          <button
            type="button"
            onClick={() => void jarvisApi.createBackup().then(loadData)}
            className="mt-2 flex items-center gap-1 font-medium text-[#FF7A00] hover:underline"
          >
            <Database className="h-3.5 w-3.5" /> Create Backup ({dbStatus?.backups?.length || 0})
          </button>
        </div>
      </div>

      {/* Tool Registry Table */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 font-display text-sm font-semibold text-[#1F2937]">
          Registered Tools ({toolsData.tools.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Tool ID</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Risk</th>
                <th className="px-4 py-2 font-medium">Approval Gate</th>
                <th className="px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {toolsData.tools.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-2 font-mono text-[#1F2937]">{t.id}</td>
                  <td className="px-4 py-2 text-slate-600">{t.category}</td>
                  <td className="px-4 py-2 font-medium text-slate-700">{t.riskLevel}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {t.requiresApproval ? 'Owner Required' : 'Auto-allowed'}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audit Logs */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="font-display text-sm font-semibold text-[#1F2937]">
          Security &amp; System Audit Log
        </h3>
        <div className="mt-3 max-h-60 space-y-1.5 overflow-y-auto font-mono text-[11px]">
          {auditLogs.map((log) => (
            <div key={log.id} className="border-b border-slate-100 pb-1 text-slate-600">
              <span className="text-slate-400">{log.createdAt}</span> ·{' '}
              <span className="font-semibold text-[#1F2937]">[{log.subsystem}]</span> {log.action} ·{' '}
              {log.details}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
