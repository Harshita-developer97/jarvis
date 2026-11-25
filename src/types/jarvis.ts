export type NavSection =
  | 'workspace'
  | 'projects'
  | 'tasks'
  | 'agents'
  | 'memory'
  | 'research'
  | 'engineer'
  | 'business'
  | 'automations'
  | 'devices'
  | 'health'
  | 'settings';

export type LanguageMode = 'auto' | 'en' | 'hi' | 'hinglish';

export type InferenceMode = 'local_only' | 'cloud_assisted';

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
  models: Array<{
    id: string;
    name: string;
    provider: 'ollama' | 'llamacpp' | 'gemini';
    sizeBytes?: number;
    quantization?: string;
    tier: 'lightweight' | 'medium' | 'strong';
    loaded: boolean;
    ramEstimateGb: number;
  }>;
  reasonIfUnavailable: string | null;
  setupInstructions: string[];
  settings?: {
    inferenceMode?: InferenceMode;
    preferredProvider: 'auto' | 'ollama' | 'llamacpp' | 'gemini';
    preferredModel: string | null;
    allowCloudFallback: boolean;
    ollamaUrl: string;
    llamacppUrl: string;
  };
}

export interface Conversation {
  id: string;
  title: string;
  language: LanguageMode;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  intent: string | null;
  modelUsed: string | null;
  toolCalls: Array<{ toolId: string; status: string; summary: string }>;
  createdAt: string;
}

export interface TaskItem {
  id: string;
  title: string;
  goal: string;
  status: 'queued' | 'running' | 'paused' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  progress: number;
  assignedAgents: string[];
  resultSummary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  steps?: Array<{
    id: string;
    stepOrder: number;
    title: string;
    agentRole: string;
    status: string;
    toolId: string | null;
    errorMessage: string | null;
  }>;
}

export interface AgentItem {
  role: string;
  displayName: string;
  description: string;
  allowedTools: string[];
  status: string;
  currentTaskId: string | null;
  lastActiveAt: string | null;
  totalRuns: number;
}

export interface ApprovalItem {
  id: string;
  taskId: string | null;
  toolId: string;
  actionSummary: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  payloadJson: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface MemoryItem {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  context: string | null;
  importance: number;
  confidence: number;
  contradictsId: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export interface VoiceConfig {
  enabled: boolean;
  wakeWord: string;
  continuousListening: boolean;
  language: LanguageMode;
  speechRate: number;
  voiceName: string;
  inputDeviceId: string;
  outputDeviceId: string;
  vadThreshold: number;
  interruptible: boolean;
  silenceTimeoutMs: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}
