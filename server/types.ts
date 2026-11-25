export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRole =
  | 'planner'
  | 'researcher'
  | 'architect'
  | 'developer'
  | 'bug_hunter'
  | 'qa_engineer'
  | 'security_reviewer'
  | 'performance_engineer'
  | 'business_analyst'
  | 'project_manager'
  | 'operations_agent'
  | 'personal_assistant'
  | 'independent_reviewer';

export type MemoryCategory =
  | 'preference'
  | 'instruction'
  | 'project'
  | 'goal'
  | 'conversation'
  | 'decision'
  | 'task'
  | 'fact'
  | 'technical'
  | 'business'
  | 'correction'
  | 'lesson'
  | 'workflow_success'
  | 'workflow_failure';

export type LanguageMode = 'en' | 'hi' | 'hinglish' | 'auto';

export interface SystemTelemetry {
  timestamp: string;
  os: {
    platform: string;
    release: string;
    arch: string;
    hostname: string;
    uptimeSeconds: number;
    isWindows11: boolean;
  };
  cpu: {
    model: string;
    cores: number;
    loadAvg1m: number;
    loadAvg5m: number;
    usagePercent: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
    pressure: 'normal' | 'elevated' | 'critical';
    processRssBytes: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
    mount: string;
  };
  gpu: {
    detected: boolean;
    name: string | null;
    vramMb: number | null;
  };
  network: {
    online: boolean;
    interfaces: string[];
  };
  processes: Array<{
    pid: number;
    name: string;
    cpuPercent: number;
    memPercent: number;
  }>;
  runtimes: {
    node: string | null;
    python: string | null;
    git: string | null;
    rustc: string | null;
    cargo: string | null;
    sqlite: string;
    ollama: boolean;
    llamacpp: boolean;
    whisper: boolean;
    piper: boolean;
    chromium: boolean;
  };
}

export interface AIModelInfo {
  id: string;
  name: string;
  provider: 'ollama' | 'llamacpp' | 'gemini';
  sizeBytes?: number;
  quantization?: string;
  tier: 'lightweight' | 'medium' | 'strong';
  loaded: boolean;
  ramEstimateGb: number;
}

export type InferenceMode = 'local_only' | 'cloud_assisted';

export interface AIEngineStatus {
  available: boolean;
  inferenceMode: InferenceMode;
  activeProvider: 'ollama' | 'llamacpp' | 'gemini' | 'none';
  activeModel: string | null;
  ollamaReachable: boolean;
  ollamaUrl: string;
  llamacppReachable: boolean;
  llamacppUrl: string;
  geminiConfigured: boolean;
  models: AIModelInfo[];
  reasonIfUnavailable: string | null;
  setupInstructions: string[];
}

export type VoiceLifecycleState =
  | 'disabled'
  | 'initializing'
  | 'wake_listening'
  | 'wake_detected'
  | 'recording_command'
  | 'processing'
  | 'speaking'
  | 'interrupted'
  | 'recovering'
  | 'error';

export interface VoiceDeviceInfo {
  id: string;
  name: string;
  kind: 'audioinput' | 'audiooutput';
  source: 'os' | 'browser';
}

export interface DesktopActionResult {
  available: boolean;
  platform: string;
  action: string;
  verified: boolean;
  data?: unknown;
  unavailableReason?: string;
}

export interface ToolDefinitionMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  riskLevel: RiskLevel;
  timeoutMs: number;
  requiresApproval: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string | null;
  toolId: string;
  actionSummary: string;
  riskLevel: RiskLevel;
  payloadJson: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
}

export interface JarvisEvent {
  type:
    | 'telemetry'
    | 'task_updated'
    | 'agent_updated'
    | 'tool_executed'
    | 'approval_requested'
    | 'notification'
    | 'automation_run'
    | 'system_alert';
  payload: unknown;
  timestamp: string;
}
