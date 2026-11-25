async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const jarvisApi = {
  getHealth: () => requestJson<any>('/api/health'),
  getTelemetry: (deep = false) => requestJson<any>(`/api/system/telemetry?deep=${deep}`),
  inspectSetup: () => requestJson<any>('/api/setup/inspect'),
  completeSetup: (body: Record<string, unknown>) =>
    requestJson<any>('/api/setup/complete', { method: 'POST', body: JSON.stringify(body) }),

  getAIStatus: () => requestJson<any>('/api/ai/status'),
  saveAISettings: (body: Record<string, unknown>) =>
    requestJson<any>('/api/ai/settings', { method: 'POST', body: JSON.stringify(body) }),
  testAI: () => requestJson<any>('/api/ai/test', { method: 'POST' }),
  loadModel: (modelName: string) =>
    requestJson<any>('/api/ai/models/load', { method: 'POST', body: JSON.stringify({ modelName }) }),
  unloadModel: (modelName: string) =>
    requestJson<any>('/api/ai/models/unload', { method: 'POST', body: JSON.stringify({ modelName }) }),
  pullModel: (modelName: string) =>
    requestJson<any>('/api/ai/models/pull', { method: 'POST', body: JSON.stringify({ modelName }) }),

  listConversations: () => requestJson<{ conversations: any[] }>('/api/conversations'),
  createConversation: (title?: string, language?: string) =>
    requestJson<any>('/api/conversations', { method: 'POST', body: JSON.stringify({ title, language }) }),
  getMessages: (convId: string) => requestJson<{ messages: any[] }>(`/api/conversations/${convId}/messages`),
  sendChat: (body: { conversationId?: string; content: string; language?: string; attachmentNames?: string[] }) =>
    requestJson<any>('/api/chat', { method: 'POST', body: JSON.stringify(body) }),
  interruptChat: () => requestJson<any>('/api/chat/interrupt', { method: 'POST' }),

  getVoiceStatus: () => requestJson<any>('/api/voice'),
  updateVoiceConfig: (body: Record<string, unknown>) =>
    requestJson<any>('/api/voice', { method: 'PATCH', body: JSON.stringify(body) }),
  transcribeVoice: (audioBase64: string, language?: string) =>
    requestJson<any>('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audioBase64, language }),
    }),
  synthesizeVoice: (text: string, rate = 1.0) =>
    requestJson<any>('/api/voice/synthesize', {
      method: 'POST',
      body: JSON.stringify({ text, rate }),
    }),

  listMemory: (q?: string, category?: string) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (category && category !== 'all') params.set('category', category);
    return requestJson<{ items: any[] }>(`/api/memory?${params.toString()}`);
  },
  createMemory: (body: Record<string, unknown>) =>
    requestJson<any>('/api/memory', { method: 'POST', body: JSON.stringify(body) }),
  forgetMemory: (query: string) =>
    requestJson<any>('/api/memory/forget', { method: 'POST', body: JSON.stringify({ query }) }),
  deleteMemory: (id: string) => requestJson<any>(`/api/memory/${id}`, { method: 'DELETE' }),

  listTasks: () => requestJson<{ tasks: any[] }>('/api/tasks'),
  createTask: (body: { title: string; goal: string; priority?: number }) =>
    requestJson<any>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  controlTask: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    requestJson<any>(`/api/tasks/${id}/control`, { method: 'POST', body: JSON.stringify({ action }) }),
  listAgents: () => requestJson<{ agents: any[]; recentRuns: any[] }>('/api/agents'),

  getTools: () => requestJson<{ tools: any[]; executions: any[]; approvals: any[] }>('/api/tools'),
  executeTool: (toolId: string, input: unknown, approvedByOwner = false) =>
    requestJson<any>('/api/tools/execute', {
      method: 'POST',
      body: JSON.stringify({ toolId, input, approvedByOwner }),
    }),
  resolveApproval: (id: string, decision: 'approved' | 'rejected') =>
    requestJson<any>(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),

  listFiles: (q?: string) => requestJson<{ files: any[] }>(`/api/files${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  readFile: (path: string) => requestJson<any>(`/api/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    requestJson<any>('/api/files/write', { method: 'POST', body: JSON.stringify({ path, content }) }),
  moveFile: (from: string, to: string) =>
    requestJson<any>('/api/files/move', { method: 'POST', body: JSON.stringify({ from, to }) }),
  copyFile: (from: string, to: string) =>
    requestJson<any>('/api/files/copy', { method: 'POST', body: JSON.stringify({ from, to }) }),
  deleteFile: (path: string, approvedByOwner = false) =>
    requestJson<any>('/api/files/delete', {
      method: 'POST',
      body: JSON.stringify({ path, approvedByOwner }),
    }),
  organizeFolder: (subDir: string, dryRun = false, approvedByOwner = false) =>
    requestJson<any>('/api/files/organize', {
      method: 'POST',
      body: JSON.stringify({ subDir, dryRun, approvedByOwner }),
    }),
  findDuplicateFiles: () => requestJson<{ duplicates: any[] }>('/api/files/duplicates'),

  inspectUrl: (url: string) =>
    requestJson<any>('/api/browser/inspect', { method: 'POST', body: JSON.stringify({ url }) }),
  listResearch: () => requestJson<{ reports: any[] }>('/api/research'),
  runResearch: (query: string, urls?: string[]) =>
    requestJson<any>('/api/research', { method: 'POST', body: JSON.stringify({ query, urls }) }),

  listProjects: () => requestJson<{ projects: any[] }>('/api/projects'),
  analyzeProject: (subDir = '.') =>
    requestJson<any>('/api/projects/analyze', { method: 'POST', body: JSON.stringify({ subDir }) }),
  listBugs: () => requestJson<{ bugs: any[] }>('/api/bugs'),
  scanBugs: (projectId?: string) =>
    requestJson<any>('/api/bugs/scan', { method: 'POST', body: JSON.stringify({ projectId }) }),
  listTests: () => requestJson<{ runs: any[] }>('/api/tests'),
  runTests: (suite: 'typecheck' | 'vitest' | 'all') =>
    requestJson<any>('/api/tests/run', { method: 'POST', body: JSON.stringify({ suite }) }),
  getEngineeringEnv: () => requestJson<any>('/api/engineering/environment'),
  multiEdit: (body: {
    label: string;
    changes: Array<{ path: string; content: string }>;
    verifyTypecheck?: boolean;
    autoRollbackOnFail?: boolean;
  }) => requestJson<any>('/api/engineering/multi-edit', { method: 'POST', body: JSON.stringify(body) }),
  generateTests: (targetPath: string, runImmediately = true) =>
    requestJson<any>('/api/engineering/generate-tests', {
      method: 'POST',
      body: JSON.stringify({ targetPath, runImmediately }),
    }),
  getBaseline: (suite = 'vitest') => requestJson<any>(`/api/engineering/baseline?suite=${encodeURIComponent(suite)}`),
  saveBaseline: (body: { suiteName: string; passed: number; failed: number }) =>
    requestJson<any>('/api/engineering/baseline', { method: 'POST', body: JSON.stringify(body) }),
  repairLoop: (body?: {
    label?: string;
    suite?: 'typecheck' | 'vitest';
    maxIterations?: number;
  }) =>
    requestJson<any>('/api/engineering/repair-loop', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),

  getDesktopCapabilities: () => requestJson<any>('/api/desktop/capabilities'),
  runDesktopAction: (body: {
    action: string;
    target?: string;
    text?: string;
    approvedByOwner?: boolean;
  }) => requestJson<any>('/api/desktop/action', { method: 'POST', body: JSON.stringify(body) }),
  getAutostart: () => requestJson<any>('/api/desktop/autostart'),
  setAutostart: (enabled: boolean) =>
    requestJson<any>('/api/desktop/autostart', { method: 'POST', body: JSON.stringify({ enabled }) }),

  getBusiness: (domain = 'all') => requestJson<any>(`/api/business?domain=${domain}`),
  createBusinessRecord: (body: Record<string, unknown>) =>
    requestJson<any>('/api/business', { method: 'POST', body: JSON.stringify(body) }),
  getProductivity: (type = 'all') => requestJson<any>(`/api/productivity?type=${type}`),
  createProductivityItem: (body: Record<string, unknown>) =>
    requestJson<any>('/api/productivity', { method: 'POST', body: JSON.stringify(body) }),
  updateProductivityStatus: (id: string, status: 'open' | 'in_progress' | 'done') =>
    requestJson<any>(`/api/productivity/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  getOwnerAbsence: () => requestJson<any>('/api/owner-absence'),
  updateOwnerAbsence: (body: Record<string, unknown>) =>
    requestJson<any>('/api/owner-absence', { method: 'PATCH', body: JSON.stringify(body) }),
  evaluateDecision: (body: Record<string, unknown>) =>
    requestJson<any>('/api/decision/evaluate', { method: 'POST', body: JSON.stringify(body) }),
  runSimulation: (body: Record<string, unknown>) =>
    requestJson<any>('/api/simulations', { method: 'POST', body: JSON.stringify(body) }),

  getAutomations: () => requestJson<{ automations: any[]; runs: any[] }>('/api/automations'),
  createAutomation: (body: Record<string, unknown>) =>
    requestJson<any>('/api/automations', { method: 'POST', body: JSON.stringify(body) }),
  toggleAutomation: (id: string, enabled: boolean) =>
    requestJson<any>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  runAutomationNow: (id: string) =>
    requestJson<any>(`/api/automations/${id}/run`, { method: 'POST' }),

  listDevices: () => requestJson<{ devices: any[] }>('/api/devices'),
  pairDevice: (body: Record<string, unknown>) =>
    requestJson<any>('/api/devices/pair', { method: 'POST', body: JSON.stringify(body) }),
  revokeDevice: (id: string) => requestJson<any>(`/api/devices/${id}`, { method: 'DELETE' }),

  getDatabaseStatus: () => requestJson<any>('/api/database/status'),
  createBackup: () => requestJson<any>('/api/database/backup', { method: 'POST' }),
  getAuditLogs: (limit = 80) => requestJson<{ logs: any[] }>(`/api/audit?limit=${limit}`),
};
