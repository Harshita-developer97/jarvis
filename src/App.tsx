import { Menu } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BusinessView } from './components/BusinessView';
import { EngineeringView } from './components/EngineeringView';
import { MemoryResearchView } from './components/MemoryResearchView';
import { OperationsView } from './components/OperationsView';
import { SetupWizardModal } from './components/SetupWizardModal';
import { Sidebar } from './components/Sidebar';
import { TasksAgentsView } from './components/TasksAgentsView';
import { WorkspaceView } from './components/WorkspaceView';
import { useVoiceAssistant, type BackendVoiceCapabilities } from './hooks/useVoiceAssistant';
import { jarvisApi } from './lib/api';
import type {
  AIEngineStatus,
  AgentItem,
  ApprovalItem,
  ChatMessage,
  Conversation,
  InferenceMode,
  LanguageMode,
  NavSection,
  SystemTelemetry,
  TaskItem,
  VoiceConfig,
} from './types/jarvis';

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: true,
  wakeWord: 'Hey Jarvis',
  wakePhrases: ['Hey Jarvis', 'Jarvis', 'Hello Jarvis'],
  continuousListening: false,
  language: 'auto',
  speechRate: 1.0,
  speechPitch: 1.0,
  speechVolume: 1.0,
  shortVoiceResponses: false,
  voiceName: 'default',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  vadThreshold: 12,
  interruptible: true,
  silenceTimeoutMs: 1800,
  quietHoursEnabled: false,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
};

const SECTION_TITLES: Record<NavSection, string> = {
  workspace: 'Workspace',
  projects: 'Projects & Guardian',
  tasks: 'Tasks & Planner',
  agents: 'Multi-Agent Roster',
  memory: 'Memory Brain',
  research: 'Research & Browser',
  engineer: 'Software Engineer',
  business: 'Business Manager',
  automations: 'Automations',
  devices: 'Devices & Companion',
  health: 'System Health',
  settings: 'Settings',
};

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('workspace');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [aiStatus, setAiStatus] = useState<AIEngineStatus | null>(null);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [backendVoiceCaps, setBackendVoiceCaps] = useState<BackendVoiceCapabilities | undefined>(
    undefined
  );
  const speakRef = useRef<(text: string, langOverride?: LanguageMode) => void | Promise<void>>(
    () => {}
  );

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);

  const refreshCore = useCallback(async () => {
    const [health, convRes, tasksRes, agentsRes, toolsRes, voiceRes] = await Promise.all([
      jarvisApi.getHealth(),
      jarvisApi.listConversations(),
      jarvisApi.listTasks(),
      jarvisApi.listAgents(),
      jarvisApi.getTools(),
      jarvisApi.getVoiceStatus(),
    ]);
    setTelemetry(health.telemetry);
    setAiStatus(health.ai);
    setConversations(convRes.conversations || []);
    setTasks(tasksRes.tasks || []);
    setAgents(agentsRes.agents || []);
    setApprovals(toolsRes.approvals || []);
    if (voiceRes?.config) setVoiceConfig({ ...DEFAULT_VOICE_CONFIG, ...voiceRes.config });
    if (voiceRes?.backendCapabilities) setBackendVoiceCaps(voiceRes.backendCapabilities);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    const res = await jarvisApi.getMessages(id);
    setMessages(res.messages || []);
  }, []);

  useEffect(() => {
    void refreshCore().then(async () => {
      const setup = await jarvisApi.inspectSetup();
      if (!setup.setupCompleted) {
        setSetupOpen(true);
      }
    });

    const es = new EventSource('/api/events');
    es.addEventListener('telemetry', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        if (parsed.payload) setTelemetry(parsed.payload);
      } catch {
        // ignore parse error
      }
    });
    es.addEventListener('task_updated', () => {
      void jarvisApi.listTasks().then((r) => setTasks(r.tasks || []));
    });
    es.addEventListener('agent_updated', () => {
      void jarvisApi.listAgents().then((r) => setAgents(r.agents || []));
    });
    es.addEventListener('approval_requested', () => {
      void jarvisApi.getTools().then((r) => setApprovals(r.approvals || []));
    });

    return () => es.close();
  }, [refreshCore]);

  const handleSendMessage = useCallback(
    async (text: string, attachments: string[]) => {
      setSending(true);
      setChatError(null);
      try {
        const res = await jarvisApi.sendChat({
          conversationId: activeConversationId || undefined,
          content: text,
          language: voiceConfig.language,
          attachmentNames: attachments,
        });
        setActiveConversationId(res.conversation.id);
        setMessages((prev) => [...prev, res.userMessage, res.assistantMessage]);
        if (voiceConfig.enabled && res.assistantMessage?.content) {
          void speakRef.current(res.assistantMessage.content, voiceConfig.language);
        }
        if (res.inferenceError) {
          setChatError(res.inferenceError);
        }
        await refreshCore();
      } catch (err) {
        setChatError(err instanceof Error ? err.message : 'Unable to reach JARVIS backend');
      } finally {
        setSending(false);
      }
    },
    [activeConversationId, voiceConfig.language, voiceConfig.enabled, refreshCore]
  );

  const voiceState = useVoiceAssistant(
    voiceConfig,
    (spokenText) => {
      void handleSendMessage(spokenText, []);
    },
    backendVoiceCaps,
    {
      isProcessing: sending,
      onInterruptRequest: () => {
        void jarvisApi.interruptChat().catch(() => {});
        setSending(false);
      },
    }
  );

  useEffect(() => {
    speakRef.current = voiceState.speak;
  }, [voiceState.speak]);

  const handleUpdateVoiceConfig = async (patch: Partial<VoiceConfig>) => {
    const updated = await jarvisApi.updateVoiceConfig(patch);
    setVoiceConfig({ ...DEFAULT_VOICE_CONFIG, ...updated });
  };

  const handleSwitchInferenceMode = async (inferenceMode: InferenceMode) => {
    await jarvisApi.saveAISettings({ inferenceMode });
    await refreshCore();
  };

  const handleNewConversation = () => {
    setActiveConversationId(null);
    setMessages([]);
    setChatError(null);
  };

  const handleResolveApproval = async (id: string, decision: 'approved' | 'rejected') => {
    await jarvisApi.resolveApproval(id, decision);
    await refreshCore();
  };

  const activeTaskCount = tasks.filter(
    (t) => t.status === 'running' || t.status === 'queued'
  ).length;
  const ramGb = telemetry ? (telemetry.memory.usedBytes / 1024 ** 3).toFixed(1) : '—';
  const totalRamGb = telemetry ? (telemetry.memory.totalBytes / 1024 ** 3).toFixed(1) : '—';
  const inferenceMode = aiStatus?.inferenceMode || 'local_only';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-[#1F2937]">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={(id) => void loadConversation(id)}
        onNewConversation={handleNewConversation}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Clean 3-Zone Top Bar */}
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="font-display text-base font-semibold tracking-tight text-[#1F2937] truncate">
              {SECTION_TITLES[activeSection]}
            </h1>
          </div>

          <div className="hidden md:flex items-center gap-4 text-xs text-slate-500 tabular-nums whitespace-nowrap">
            <span>
              AI:{' '}
              <strong className="font-medium text-[#1F2937]">
                {aiStatus?.available
                  ? `${aiStatus.activeProvider} · ${aiStatus.activeModel}`
                  : `Offline (${aiStatus?.settings?.preferredModel || 'qwen2.5:3b'})`}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              RAM: <strong className="font-mono font-medium text-[#1F2937]">{ramGb}/{totalRamGb} GB</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              CPU:{' '}
              <strong className="font-mono font-medium text-[#1F2937]">
                {telemetry ? `${telemetry.cpu.usagePercent}%` : '—'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Tasks: <strong className="font-mono font-medium text-[#1F2937]">{activeTaskCount}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              role="group"
              aria-label="Inference mode"
              className="hidden sm:flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs"
            >
              <button
                type="button"
                onClick={() => void handleSwitchInferenceMode('local_only')}
                className={`rounded px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
                  inferenceMode === 'local_only'
                    ? 'bg-[#1F2937] text-white'
                    : 'text-slate-600 hover:text-[#1F2937]'
                }`}
              >
                Local Only
              </button>
              <button
                type="button"
                onClick={() => void handleSwitchInferenceMode('cloud_assisted')}
                className={`rounded px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
                  inferenceMode === 'cloud_assisted'
                    ? 'bg-[#FF7A00] text-white'
                    : 'text-slate-600 hover:text-[#1F2937]'
                }`}
              >
                Cloud Assisted
              </button>
            </div>

            <button
              type="button"
              onClick={() => setSetupOpen(true)}
              className="rounded-md border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-[#1F2937] transition-colors hover:border-[#FF7A00] hover:text-[#FF7A00] whitespace-nowrap"
            >
              Setup Wizard
            </button>
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40">
          {activeSection === 'workspace' && (
            <WorkspaceView
              messages={messages}
              sending={sending}
              chatError={chatError}
              aiStatus={aiStatus}
              tasks={tasks}
              approvals={approvals}
              voiceConfig={voiceConfig}
              voiceState={voiceState}
              onSendMessage={handleSendMessage}
              onInterrupt={async () => {
                voiceState.stopSpeaking();
                await jarvisApi.interruptChat();
                setSending(false);
              }}
              onUpdateVoiceConfig={handleUpdateVoiceConfig}
              onSwitchInferenceMode={handleSwitchInferenceMode}
              onResolveApproval={handleResolveApproval}
              onOpenSetup={() => setSetupOpen(true)}
            />
          )}

          {(activeSection === 'tasks' || activeSection === 'agents') && (
            <TasksAgentsView
              mode={activeSection}
              tasks={tasks}
              agents={agents}
              onRefresh={refreshCore}
            />
          )}

          {(activeSection === 'memory' || activeSection === 'research') && (
            <MemoryResearchView mode={activeSection} />
          )}

          {(activeSection === 'projects' || activeSection === 'engineer') && (
            <EngineeringView mode={activeSection} />
          )}

          {activeSection === 'business' && <BusinessView />}

          {(activeSection === 'automations' ||
            activeSection === 'devices' ||
            activeSection === 'health' ||
            activeSection === 'settings') && (
            <OperationsView
              mode={activeSection}
              telemetry={telemetry}
              aiStatus={aiStatus}
              voiceConfig={voiceConfig}
              voiceDevices={{
                inputDevices: voiceState.inputDevices,
                outputDevices: voiceState.outputDevices,
              }}
              voiceVoices={voiceState.availableVoices}
              hindiVoiceAvailable={voiceState.hindiVoiceAvailable}
              onUpdateVoiceConfig={handleUpdateVoiceConfig}
              onSwitchInferenceMode={handleSwitchInferenceMode}
              onRefreshAI={refreshCore}
            />
          )}
        </main>
      </div>

      <SetupWizardModal
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onCompleted={refreshCore}
      />
    </div>
  );
}
