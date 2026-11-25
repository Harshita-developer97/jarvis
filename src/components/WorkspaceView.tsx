import {
  AlertTriangle,
  Check,
  Mic,
  MicOff,
  Paperclip,
  Send,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { jarvisApi } from '../lib/api';
import type { AudioDeviceSummary } from '../hooks/useVoiceAssistant';
import type {
  AIEngineStatus,
  ApprovalItem,
  ChatMessage,
  InferenceMode,
  LanguageMode,
  TaskItem,
  VoiceConfig,
} from '../types/jarvis';

interface WorkspaceViewProps {
  messages: ChatMessage[];
  sending: boolean;
  chatError: string | null;
  aiStatus: AIEngineStatus | null;
  tasks: TaskItem[];
  approvals: ApprovalItem[];
  voiceConfig: VoiceConfig;
  voiceState: {
    sttSupported: boolean;
    ttsSupported: boolean;
    listening: boolean;
    speaking: boolean;
    micLevel: number;
    voiceActive: boolean;
    interimText: string;
    voiceError: string | null;
    inputDevices: AudioDeviceSummary[];
    outputDevices: AudioDeviceSummary[];
    startListening: (continuousOverride?: boolean) => void;
    stopListening: () => void;
    stopSpeaking: () => void;
    speak: (text: string) => void | Promise<void>;
  };
  onSendMessage: (text: string, attachments: string[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onUpdateVoiceConfig: (patch: Partial<VoiceConfig>) => Promise<void>;
  onSwitchInferenceMode: (mode: InferenceMode) => Promise<void>;
  onResolveApproval: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  onOpenSetup: () => void;
}

const QUICK_PROMPTS = [
  'Jarvis, mera laptop slow kyu chal raha hai?',
  'Analyze this project and scan for TypeScript or security bugs.',
  'Run real Vitest test suite and report results.',
  'Remind me to review weekly sales pipeline tomorrow.',
];

export function WorkspaceView({
  messages,
  sending,
  chatError,
  aiStatus,
  tasks,
  approvals,
  voiceConfig,
  voiceState,
  onSendMessage,
  onInterrupt,
  onUpdateVoiceConfig,
  onSwitchInferenceMode,
  onResolveApproval,
  onOpenSetup,
}: WorkspaceViewProps) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const activeTasks = tasks.filter(
    (t) => t.status === 'running' || t.status === 'queued' || t.status === 'waiting_approval'
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    const files = [...attachments];
    setAttachments([]);
    await onSendMessage(text, files);
  };

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).map((f) => f.name);
    if (files.length > 0) {
      setAttachments((prev) => Array.from(new Set([...prev, ...files])));
    }
    e.target.value = '';
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Main Conversation Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* AI Engine Connected or Honest Unavailable Banner */}
        {aiStatus?.available ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-6 py-2 text-xs text-slate-600">
            <span>
              Local AI Connected:{' '}
              <strong className="font-mono font-semibold text-[#1F2937]">
                {aiStatus.activeProvider} · {aiStatus.activeModel}
              </strong>{' '}
              ({aiStatus.inferenceMode === 'local_only' ? 'Strict Local-Only' : 'Cloud Assisted'})
            </span>
            <span className="font-mono text-[11px] text-slate-500">
              {aiStatus.ollamaReachable ? aiStatus.ollamaUrl : aiStatus.llamacppUrl}
            </span>
          </div>
        ) : aiStatus ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50/70 px-6 py-3 text-xs text-amber-950">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                {aiStatus.reasonIfUnavailable ||
                  'Local-Only Mode is active and Ollama at 127.0.0.1:11434 is unreachable from this server.'}{' '}
                In cloud browser preview, click <strong>Switch to Cloud Mode</strong> to chat now,
                or run <code>start-jarvis.bat</code> locally on Windows 11 to connect to your laptop&apos;s Ollama.
              </span>
            </div>
            <div className="flex items-center gap-2">
              {aiStatus.inferenceMode === 'local_only' && aiStatus.geminiConfigured && (
                <button
                  type="button"
                  onClick={() => void onSwitchInferenceMode('cloud_assisted')}
                  className="rounded-md bg-[#FF7A00] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e56d00] whitespace-nowrap"
                >
                  Switch to Cloud Mode
                </button>
              )}
              <button
                type="button"
                onClick={onOpenSetup}
                className="rounded-md bg-[#1F2937] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap"
              >
                Open Setup Wizard
              </button>
            </div>
          </div>
        ) : null}

        {chatError && (
          <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">
            AI Inference Notice: {chatError}
          </div>
        )}

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-2xl py-10">
              <h2 className="font-display text-2xl font-semibold text-[#1F2937]">
                Ready for command, diagnostics, coding, or research.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Speak via push-to-talk or wake word ({voiceConfig.wakeWord}), or enter a request
                below in English, Hindi, or Hinglish. All system telemetry, files, tasks, and tests
                execute directly on the backend.
              </p>

              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void onSendMessage(prompt, [])}
                    className="rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 text-left text-xs font-medium text-[#1F2937] transition-colors hover:border-[#FF7A00] hover:bg-white"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-medium text-[#1F2937]">
                        {isUser ? 'Owner' : 'JARVIS'}
                      </span>
                      {msg.intent && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{msg.intent}</span>
                        </>
                      )}
                      {msg.modelUsed && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-[11px]">{msg.modelUsed}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {new Date(msg.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>

                    <div
                      className={`max-w-[90%] rounded-lg px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                        isUser
                          ? 'bg-[#1F2937] text-white'
                          : 'border border-slate-200 bg-slate-50/60 text-[#1F2937]'
                      }`}
                    >
                      {msg.content}
                    </div>

                    {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                        {msg.toolCalls.map((tc, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <Wrench className="h-3.5 w-3.5 text-[#FF7A00]" />
                            <span className="font-mono text-[#1F2937]">{tc.toolId}</span>
                            <span aria-hidden="true">·</span>
                            <span>{tc.status}</span>
                            <span aria-hidden="true">·</span>
                            <span>{tc.summary}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {!isUser && voiceState.ttsSupported && (
                      <button
                        type="button"
                        onClick={() => voiceState.speak(msg.content)}
                        className="mt-1.5 flex items-center gap-1 text-xs text-slate-500 hover:text-[#FF7A00]"
                      >
                        <Volume2 className="h-3.5 w-3.5" />
                        <span>Speak reply</span>
                      </button>
                    )}
                  </div>
                );
              })}
              {sending && (
                <div className="text-xs text-slate-500">
                  JARVIS is reasoning and verifying tools...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Voice Status + Composer Bar */}
        <div className="border-t border-slate-200 bg-white px-6 py-4">
          <div className="mx-auto max-w-3xl space-y-3">
            {/* Voice Control Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    voiceState.listening ? voiceState.stopListening() : void voiceState.startListening()
                  }
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                    voiceState.listening
                      ? 'bg-[#FF7A00] text-white'
                      : 'border border-slate-200 bg-slate-50 text-[#1F2937] hover:border-slate-300'
                  }`}
                >
                  {voiceState.listening ? (
                    <>
                      <Mic className="h-3.5 w-3.5" />
                      <span>
                        {voiceConfig.continuousListening ? 'Wake Listening' : 'Listening'} (
                        {voiceState.micLevel}%)
                        {voiceState.voiceActive ? ' · VAD' : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <MicOff className="h-3.5 w-3.5 text-slate-500" />
                      <span>
                        {voiceConfig.continuousListening ? 'Start Wake Listener' : 'Push to Talk'}
                      </span>
                    </>
                  )}
                </button>

                <label className="flex items-center gap-1.5 text-slate-600 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={voiceConfig.continuousListening}
                    onChange={(e) => {
                      const next = e.target.checked;
                      void onUpdateVoiceConfig({ continuousListening: next });
                      if (next) {
                        void voiceState.startListening(true);
                      } else if (voiceState.listening) {
                        voiceState.stopListening();
                      }
                    }}
                    className="rounded border-slate-300 accent-[#FF7A00]"
                  />
                  <span>Wake word ({voiceConfig.wakeWord})</span>
                </label>

                <label className="flex items-center gap-1.5 text-slate-600 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={voiceConfig.enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      if (!enabled) voiceState.stopSpeaking();
                      void onUpdateVoiceConfig({ enabled });
                    }}
                    className="rounded border-slate-300 accent-[#FF7A00]"
                  />
                  <span>Auto-speak</span>
                </label>

                <select
                  aria-label="Conversation language"
                  value={voiceConfig.language}
                  onChange={(e) =>
                    void onUpdateVoiceConfig({ language: e.target.value as LanguageMode })
                  }
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-[#1F2937]"
                >
                  <option value="auto">Auto (EN / HI / Hinglish)</option>
                  <option value="en">English</option>
                  <option value="hinglish">Hinglish</option>
                  <option value="hi">Hindi</option>
                </select>

                {voiceState.inputDevices.length > 0 && (
                  <select
                    aria-label="Microphone device"
                    value={voiceConfig.inputDeviceId || 'default'}
                    onChange={(e) =>
                      void onUpdateVoiceConfig({ inputDeviceId: e.target.value })
                    }
                    className="max-w-[160px] truncate rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-[#1F2937]"
                  >
                    <option value="default">Default Microphone</option>
                    {voiceState.inputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2">
                {voiceState.speaking && (
                  <button
                    type="button"
                    onClick={voiceState.stopSpeaking}
                    className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-[#1F2937] hover:bg-slate-100"
                  >
                    <VolumeX className="h-3.5 w-3.5 text-[#FF7A00]" />
                    <span>Stop Speech</span>
                  </button>
                )}
                {sending && (
                  <button
                    type="button"
                    onClick={() => void onInterrupt()}
                    className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                  >
                    <Square className="h-3 w-3" />
                    <span>Interrupt</span>
                  </button>
                )}
              </div>
            </div>

            {voiceState.interimText && (
              <div className="text-xs italic text-slate-500">
                Heard: &ldquo;{voiceState.interimText}&rdquo;
              </div>
            )}
            {voiceState.voiceError && (
              <div className="text-xs text-red-600">{voiceState.voiceError}</div>
            )}

            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                {attachments.map((name) => (
                  <div key={name} className="flex items-center gap-1">
                    <Paperclip className="h-3.5 w-3.5 text-slate-400" />
                    <span>{name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x !== name))}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileAttach}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg border border-slate-200 p-2.5 text-slate-500 hover:bg-slate-50 hover:text-[#1F2937]"
                title="Attach file context"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit(e);
                  }
                }}
                placeholder="Ask JARVIS, issue a command, or request an engineering audit..."
                className="flex-1 resize-none rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-[#1F2937] placeholder:text-slate-400 focus:border-[#FF7A00] focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-[#FF7A00] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#e56d00] disabled:opacity-40 whitespace-nowrap"
              >
                <Send className="h-4 w-4" />
                <span>Send</span>
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Right Context Rail: Active Tasks & Security Approvals */}
      <aside className="w-full shrink-0 border-t border-slate-200 bg-slate-50/50 p-5 lg:w-80 lg:border-t-0 lg:border-l overflow-y-auto">
        <div className="space-y-6">
          <div>
            <h3 className="font-display text-sm font-semibold text-[#1F2937]">
              Pending Approvals ({pendingApprovals.length})
            </h3>
            {pendingApprovals.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">
                No high-risk actions awaiting owner authorization.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {pendingApprovals.map((app) => (
                  <div
                    key={app.id}
                    className="rounded-lg border border-amber-200 bg-white p-3 text-xs"
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      <span>{app.riskLevel} Risk · {app.toolId}</span>
                    </div>
                    <p className="mt-1.5 text-slate-600">{app.actionSummary}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void onResolveApproval(app.id, 'approved')}
                        className="flex items-center gap-1 rounded bg-[#1F2937] px-2.5 py-1 font-medium text-white hover:bg-slate-800"
                      >
                        <Check className="h-3 w-3" />
                        <span>Approve</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void onResolveApproval(app.id, 'rejected')}
                        className="rounded border border-slate-200 px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-100"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h3 className="font-display text-sm font-semibold text-[#1F2937]">
              Active Task Queue ({activeTasks.length})
            </h3>
            {activeTasks.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">
                All autonomous tasks idle.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {activeTasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
                    <div className="font-medium text-[#1F2937]">{t.title}</div>
                    <div className="mt-1 flex items-center justify-between text-slate-500 tabular-nums">
                      <span>{t.status}</span>
                      <span>{t.progress}%</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full bg-[#FF7A00] transition-all"
                        style={{ width: `${t.progress}%` }}
                      />
                    </div>
                    <div className="mt-2.5 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void jarvisApi.controlTask(t.id, 'cancel')}
                        className="text-xs font-medium text-red-600 hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
