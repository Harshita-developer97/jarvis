import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';
import { collectSystemTelemetry } from '../monitoring/systemMonitor.js';
import type { AIEngineStatus, AIModelInfo, InferenceMode, LanguageMode } from '../types.js';

export interface ChatTurnMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIInferenceResult {
  text: string;
  provider: 'ollama' | 'llamacpp' | 'gemini' | 'none';
  model: string | null;
  inferenceMode: InferenceMode;
  available: boolean;
  error?: string;
  durationMs: number;
  evalCount?: number;
  promptEvalCount?: number;
}

export type DetectedIntent =
  | 'conversation'
  | 'diagnostics'
  | 'task'
  | 'research'
  | 'coding'
  | 'bug_repair'
  | 'business'
  | 'reminder';

function classifyModelTier(name: string, sizeBytes?: number): AIModelInfo['tier'] {
  const lower = name.toLowerCase();
  if (
    lower.includes('0.5b') ||
    lower.includes('1b') ||
    lower.includes('1.5b') ||
    lower.includes('3b') ||
    lower.includes('tiny') ||
    lower.includes('mini')
  ) {
    return 'lightweight';
  }
  if (lower.includes('14b') || lower.includes('32b') || lower.includes('70b')) {
    return 'strong';
  }
  if (sizeBytes && sizeBytes < 2.8 * 1024 ** 3) return 'lightweight';
  if (sizeBytes && sizeBytes > 7.5 * 1024 ** 3) return 'strong';
  return 'medium';
}

export interface SavedAISettings {
  inferenceMode: InferenceMode;
  preferredProvider: 'auto' | 'ollama' | 'llamacpp' | 'gemini';
  preferredModel: string | null;
  allowCloudFallback: boolean;
  ollamaUrl: string;
  llamacppUrl: string;
}

export function getSavedAISettings(): SavedAISettings {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get('ai_settings') as { value_json: string } | undefined;
  const defaults: SavedAISettings = {
    inferenceMode: 'local_only',
    preferredProvider: 'ollama',
    preferredModel: 'qwen2.5:3b',
    allowCloudFallback: false,
    ollamaUrl: config.ollamaBaseUrl,
    llamacppUrl: config.llamacppBaseUrl,
  };
  if (!row) return defaults;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<SavedAISettings>;
    const merged: SavedAISettings = { ...defaults, ...parsed };
    // Upgrade legacy 'auto'/null settings to explicit Ollama + qwen2.5:3b local default
    if (merged.preferredProvider === 'auto' && !merged.preferredModel) {
      merged.preferredProvider = 'ollama';
      merged.preferredModel = 'qwen2.5:3b';
    }
    // Never allow silent cloud fallback unless inferenceMode is explicitly cloud_assisted
    if (merged.inferenceMode === 'local_only') {
      merged.allowCloudFallback = false;
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function saveAISettings(patch: Partial<SavedAISettings>): SavedAISettings {
  const current = getSavedAISettings();
  const next: SavedAISettings = { ...current, ...patch };
  if (patch.inferenceMode === 'local_only') {
    next.allowCloudFallback = false;
    if (next.preferredProvider === 'gemini') next.preferredProvider = 'ollama';
    if (!next.preferredModel) next.preferredModel = 'qwen2.5:3b';
  } else if (patch.inferenceMode === 'cloud_assisted') {
    next.allowCloudFallback = true;
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run('ai_settings', JSON.stringify(next), new Date().toISOString());

  logAudit('info', 'ai_engine', 'settings_updated', {
    inferenceMode: next.inferenceMode,
    preferredProvider: next.preferredProvider,
    preferredModel: next.preferredModel,
  });
  return next;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 2000
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectAIEngineStatus(): Promise<AIEngineStatus> {
  const settings = getSavedAISettings();
  const ollamaUrl = (settings.ollamaUrl || config.ollamaBaseUrl).replace(/\/+$/, '');
  const llamacppUrl = (settings.llamacppUrl || config.llamacppBaseUrl).replace(/\/+$/, '');
  const models: AIModelInfo[] = [];

  // 1. Discover Ollama models & loaded processes
  const ollamaTags = await fetchJsonWithTimeout<{
    models?: Array<{
      name: string;
      size?: number;
      details?: { quantization_level?: string; parameter_size?: string };
    }>;
  }>(`${ollamaUrl}/api/tags`);

  const ollamaPs = ollamaTags
    ? await fetchJsonWithTimeout<{ models?: Array<{ name: string }> }>(`${ollamaUrl}/api/ps`)
    : null;
  const loadedNames = new Set((ollamaPs?.models || []).map((m) => m.name));

  const ollamaReachable = ollamaTags !== null && Array.isArray(ollamaTags.models);
  if (ollamaTags?.models) {
    for (const m of ollamaTags.models) {
      const sizeBytes = m.size || 0;
      models.push({
        id: `ollama:${m.name}`,
        name: m.name,
        provider: 'ollama',
        sizeBytes,
        quantization: m.details?.quantization_level,
        tier: classifyModelTier(m.name, sizeBytes),
        loaded: loadedNames.has(m.name),
        ramEstimateGb: Math.round((sizeBytes / 1024 ** 3) * 1.25 * 10) / 10 || 2.5,
      });
    }
  }

  // 2. Discover llama.cpp server
  const llamacppModels = await fetchJsonWithTimeout<{ data?: Array<{ id: string }> }>(
    `${llamacppUrl}/v1/models`
  );
  const llamacppReachable = llamacppModels !== null && Array.isArray(llamacppModels.data);
  if (llamacppModels?.data) {
    for (const m of llamacppModels.data) {
      models.push({
        id: `llamacpp:${m.id}`,
        name: m.id,
        provider: 'llamacpp',
        tier: classifyModelTier(m.id),
        loaded: true,
        ramEstimateGb: 2.5,
      });
    }
  }

  // 3. Optional Gemini API (ONLY active when user explicitly enables cloud_assisted mode)
  const geminiConfigured = Boolean(
    config.geminiApiKey && config.geminiApiKey !== 'MY_GEMINI_API_KEY'
  );
  const cloudAllowed = settings.inferenceMode === 'cloud_assisted';
  if (geminiConfigured && cloudAllowed) {
    models.push({
      id: 'gemini:gemini-2.5-flash',
      name: 'gemini-2.5-flash (Cloud Mode)',
      provider: 'gemini',
      tier: 'medium',
      loaded: true,
      ramEstimateGb: 0,
    });
  }

  let activeProvider: AIEngineStatus['activeProvider'] = 'none';
  let activeModel: string | null = null;
  const installedOllamaModels = models.filter((m) => m.provider === 'ollama');
  const installedLlamacppModels = models.filter((m) => m.provider === 'llamacpp');

  const matchOllamaModel = (target: string | null): string | null => {
    if (!target || installedOllamaModels.length === 0) return installedOllamaModels[0]?.name || null;
    const norm = target.toLowerCase();
    const exact = installedOllamaModels.find(
      (m) => m.name.toLowerCase() === norm || m.name.toLowerCase() === `${norm}:latest`
    );
    if (exact) return exact.name;
    const prefix = installedOllamaModels.find((m) => m.name.toLowerCase().startsWith(norm));
    return prefix ? prefix.name : installedOllamaModels[0]?.name || null;
  };

  if (settings.preferredProvider === 'ollama' && ollamaReachable) {
    const resolved = matchOllamaModel(settings.preferredModel || 'qwen2.5:3b');
    if (resolved) {
      activeProvider = 'ollama';
      activeModel = resolved;
    }
  } else if (settings.preferredProvider === 'llamacpp' && llamacppReachable) {
    activeProvider = 'llamacpp';
    activeModel =
      settings.preferredModel || installedLlamacppModels[0]?.name || null;
  } else if (settings.preferredProvider === 'gemini' && geminiConfigured && cloudAllowed) {
    activeProvider = 'gemini';
    activeModel = 'gemini-2.5-flash';
  } else {
    // Prefer loaded local model first, then any local model
    const preferredLocal = matchOllamaModel(settings.preferredModel || 'qwen2.5:3b');
    const loadedLocal = models.find((m) => m.provider !== 'gemini' && m.loaded);
    const anyLocal = models.find((m) => m.provider !== 'gemini');
    if (ollamaReachable && preferredLocal) {
      activeProvider = 'ollama';
      activeModel = preferredLocal;
    } else if (loadedLocal) {
      activeProvider = loadedLocal.provider;
      activeModel = loadedLocal.name;
    } else if (anyLocal) {
      activeProvider = anyLocal.provider;
      activeModel = anyLocal.name;
    } else if (geminiConfigured && cloudAllowed) {
      activeProvider = 'gemini';
      activeModel = 'gemini-2.5-flash';
    }
  }

  const available = activeProvider !== 'none' && activeModel !== null;
  const setupInstructions: string[] = [];
  let reasonIfUnavailable: string | null = null;

  if (!available) {
    if (ollamaReachable && installedOllamaModels.length === 0) {
      reasonIfUnavailable = `Ollama is running at ${ollamaUrl}, but no local models are pulled yet (expected ${settings.preferredModel || 'qwen2.5:3b'}).`;
    } else if (settings.inferenceMode === 'local_only') {
      reasonIfUnavailable = `Local-Only Mode is active and Ollama is unreachable at ${ollamaUrl} (expected model: ${settings.preferredModel || 'qwen2.5:3b'}). Silent cloud fallback is disabled.`;
    } else {
      reasonIfUnavailable =
        'Cloud-Assisted Mode is active, but neither a local LLM engine nor a valid GEMINI_API_KEY was found.';
    }
    setupInstructions.push(
      `Start Ollama serving on Windows 11 at ${ollamaUrl} (ollama serve)`,
      `Verify model is installed: ollama pull ${settings.preferredModel || 'qwen2.5:3b'}`,
      'Or explicitly switch to Cloud Assisted mode in the top bar if you want cloud fallback.'
    );
  }

  return {
    available,
    inferenceMode: settings.inferenceMode,
    activeProvider,
    activeModel,
    ollamaReachable,
    ollamaUrl,
    llamacppReachable,
    llamacppUrl,
    geminiConfigured,
    models,
    reasonIfUnavailable,
    setupInstructions,
  };
}

export async function enforceLocalMemoryBudget(keepModelName?: string): Promise<string[]> {
  const telemetry = await collectSystemTelemetry(false);
  if (telemetry.memory.pressure === 'normal') return [];

  const status = await inspectAIEngineStatus();
  if (!status.ollamaReachable) return [];

  const unloaded: string[] = [];
  for (const m of status.models) {
    if (m.provider === 'ollama' && m.loaded && m.name !== keepModelName) {
      const res = await unloadOllamaModel(m.name);
      if (res.ok) unloaded.push(m.name);
    }
  }
  if (unloaded.length > 0) {
    logAudit('warn', 'resource_governor', 'auto_unloaded_models', {
      pressure: telemetry.memory.pressure,
      unloaded,
    });
  }
  return unloaded;
}

export async function loadOllamaModel(modelName: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSavedAISettings();
  const ollamaUrl = (settings.ollamaUrl || config.ollamaBaseUrl).replace(/\/+$/, '');
  try {
    // Unload other models first to protect 8GB RAM
    await enforceLocalMemoryBudget(modelName);
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: '', keep_alive: '10m' }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, message: `Ollama load failed: ${txt}` };
    }
    saveAISettings({ preferredProvider: 'ollama', preferredModel: modelName });
    logAudit('info', 'ai_engine', 'model_loaded', { modelName });
    return { ok: true, message: `Model ${modelName} loaded into memory.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Ollama unreachable' };
  }
}

export async function unloadOllamaModel(modelName: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSavedAISettings();
  const ollamaUrl = (settings.ollamaUrl || config.ollamaBaseUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: '', keep_alive: 0 }),
    });
    if (!res.ok) {
      return { ok: false, message: `Failed to unload ${modelName}` };
    }
    logAudit('info', 'ai_engine', 'model_unloaded', { modelName });
    return { ok: true, message: `Model ${modelName} unloaded to free RAM.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Ollama unreachable' };
  }
}

export async function pullOllamaModel(modelName: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSavedAISettings();
  const ollamaUrl = (settings.ollamaUrl || config.ollamaBaseUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: false }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, message: `Ollama pull failed: ${txt}` };
    }
    saveAISettings({
      inferenceMode: 'local_only',
      preferredProvider: 'ollama',
      preferredModel: modelName,
    });
    logAudit('info', 'ai_engine', 'model_pulled', { modelName });
    return { ok: true, message: `Model ${modelName} pulled and configured for local inference.` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Ollama unreachable for model pull',
    };
  }
}

export function detectIntentAndLanguage(input: string): {
  intent: DetectedIntent;
  language: LanguageMode;
} {
  const lower = input.toLowerCase();

  const hasDevanagari = /[\u0900-\u097f]/.test(input);
  const hinglishWords = [
    'mera',
    'kyu',
    'kaise',
    'karo',
    'karke',
    'batao',
    'mujhe',
    'hai',
    'nahi',
    'kya',
    'chal raha',
    'thik',
    'fix kar',
    'dena',
  ];
  const isHinglish = hinglishWords.some((w) => lower.includes(w));
  const language: LanguageMode = hasDevanagari ? 'hi' : isHinglish ? 'hinglish' : 'en';

  if (
    lower.includes('slow') ||
    lower.includes('cpu') ||
    lower.includes('ram') ||
    lower.includes('memory usage') ||
    lower.includes('disk') ||
    lower.includes('laptop') ||
    lower.includes('system health') ||
    lower.includes('process')
  ) {
    return { intent: 'diagnostics', language };
  }
  if (
    lower.includes('bug') ||
    lower.includes('audit') ||
    lower.includes('fix') ||
    lower.includes('repair') ||
    lower.includes('error')
  ) {
    return { intent: 'bug_repair', language };
  }
  if (
    lower.includes('remind') ||
    lower.includes('schedule') ||
    lower.includes('calendar') ||
    lower.includes('todo') ||
    lower.includes('yaad dila')
  ) {
    return { intent: 'reminder', language };
  }
  if (
    lower.includes('research') ||
    lower.includes('search') ||
    lower.includes('compare') ||
    lower.includes('investigate')
  ) {
    return { intent: 'research', language };
  }
  if (
    lower.includes('sales') ||
    lower.includes('lead') ||
    lower.includes('revenue') ||
    lower.includes('finance') ||
    lower.includes('invoice') ||
    lower.includes('marketing') ||
    lower.includes('hr')
  ) {
    return { intent: 'business', language };
  }
  if (
    lower.includes('code') ||
    lower.includes('build') ||
    lower.includes('refactor') ||
    lower.includes('test') ||
    lower.includes('api') ||
    lower.includes('function')
  ) {
    return { intent: 'coding', language };
  }
  if (
    lower.includes('create task') ||
    lower.includes('execute') ||
    lower.includes('run ') ||
    lower.includes('automate')
  ) {
    return { intent: 'task', language };
  }
  return { intent: 'conversation', language };
}

export async function runAIInference(
  messages: ChatTurnMessage[],
  options?: {
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<AIInferenceResult> {
  const start = Date.now();
  const status = await inspectAIEngineStatus();

  if (!status.available || !status.activeModel) {
    return {
      text: '',
      provider: 'none',
      model: null,
      inferenceMode: status.inferenceMode,
      available: false,
      error: status.reasonIfUnavailable || 'No inference engine available',
      durationMs: Date.now() - start,
    };
  }

  // Strictly block cloud inference if inferenceMode is local_only
  if (status.inferenceMode === 'local_only' && status.activeProvider === 'gemini') {
    return {
      text: '',
      provider: 'none',
      model: null,
      inferenceMode: 'local_only',
      available: false,
      error: 'Cloud inference blocked because Local-Only Mode is active.',
      durationMs: Date.now() - start,
    };
  }

  if (status.activeProvider === 'ollama') {
    try {
      await enforceLocalMemoryBudget(status.activeModel);
      const timeoutSignal = AbortSignal.timeout(45_000);
      const combinedSignal = options?.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(`${status.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combinedSignal,
        body: JSON.stringify({
          model: status.activeModel,
          messages,
          stream: false,
          keep_alive: '5m',
          options: {
            temperature: options?.temperature ?? 0.35,
            num_predict: options?.maxTokens ?? 512,
            num_ctx: 2048,
            num_batch: 256,
          },
        }),
      });
      if (!res.ok) {
        const bodyTxt = await res.text().catch(() => '');
        throw new Error(
          `Ollama returned HTTP ${res.status}${bodyTxt ? `: ${bodyTxt.slice(0, 180)}` : ''}`
        );
      }
      const data = (await res.json()) as {
        message?: { content?: string };
        done?: boolean;
        eval_count?: number;
        prompt_eval_count?: number;
        error?: string;
      };
      if (data.error) {
        throw new Error(`Ollama error: ${data.error}`);
      }
      return {
        text: data.message?.content || '',
        provider: 'ollama',
        model: status.activeModel,
        inferenceMode: status.inferenceMode,
        available: true,
        durationMs: Date.now() - start,
        evalCount: data.eval_count,
        promptEvalCount: data.prompt_eval_count,
      };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? `Ollama request timed out after 45s at ${status.ollamaUrl}`
            : `Ollama inference unavailable at ${status.ollamaUrl}: ${err.message}`
          : 'Ollama inference failed';
      logAudit('warn', 'ai_engine', 'ollama_inference_failed', {
        model: status.activeModel,
        error: msg,
      });
      return {
        text: '',
        provider: 'ollama',
        model: status.activeModel,
        inferenceMode: status.inferenceMode,
        available: false,
        error: msg,
        durationMs: Date.now() - start,
      };
    }
  }

  if (status.activeProvider === 'llamacpp') {
    try {
      const res = await fetch(`${status.llamacppUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options?.signal,
        body: JSON.stringify({
          model: status.activeModel,
          messages,
          temperature: options?.temperature ?? 0.3,
          max_tokens: options?.maxTokens ?? 1024,
        }),
      });
      if (!res.ok) throw new Error(`llama.cpp returned ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return {
        text: data.choices?.[0]?.message?.content || '',
        provider: 'llamacpp',
        model: status.activeModel,
        inferenceMode: status.inferenceMode,
        available: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        text: '',
        provider: 'llamacpp',
        model: status.activeModel,
        inferenceMode: status.inferenceMode,
        available: false,
        error: err instanceof Error ? err.message : 'llama.cpp inference failed',
        durationMs: Date.now() - start,
      };
    }
  }

  if (
    status.inferenceMode === 'cloud_assisted' &&
    status.activeProvider === 'gemini' &&
    config.geminiApiKey
  ) {
    try {
      const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const systemInstruction = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: {
          systemInstruction: systemInstruction || undefined,
          temperature: options?.temperature ?? 0.3,
          maxOutputTokens: options?.maxTokens ?? 1200,
        },
      });
      return {
        text: response.text || '',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        inferenceMode: status.inferenceMode,
        available: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        text: '',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        inferenceMode: status.inferenceMode,
        available: false,
        error: err instanceof Error ? err.message : 'Gemini inference failed',
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    text: '',
    provider: 'none',
    model: null,
    inferenceMode: status.inferenceMode,
    available: false,
    error: 'No active AI provider',
    durationMs: Date.now() - start,
  };
}
