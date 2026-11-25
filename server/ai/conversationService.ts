import crypto from 'node:crypto';
import {
  detectIntentAndLanguage,
  inspectAIEngineStatus,
  runAIInference,
  type ChatTurnMessage,
} from '../ai/engine.js';
import { createTask, listAgents, listTasks } from '../agents/orchestrator.js';
import { createProductivityItem } from '../business/businessService.js';
import { getDb } from '../database/db.js';
import {
  extractAndStoreConversationInsights,
  searchMemories,
} from '../memory/memoryService.js';
import { collectSystemTelemetry } from '../monitoring/systemMonitor.js';
import { executeTool } from '../tools/registry.js';
import type { LanguageMode } from '../types.js';

export interface ConversationRecord {
  id: string;
  title: string;
  language: LanguageMode;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  intent: string | null;
  modelUsed: string | null;
  toolCalls: Array<{ toolId: string; status: string; summary: string }>;
  createdAt: string;
}

export function createConversation(title = 'New Conversation', language: LanguageMode = 'auto'): ConversationRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO conversations (id, title, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, language, now, now);
  return { id, title, language, summary: null, createdAt: now, updatedAt: now };
}

export function listConversations(limit = 40): ConversationRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    language: r.language as LanguageMode,
    summary: r.summary ? String(r.summary) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function getConversationMessages(conversationId: string): MessageRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    conversationId: String(r.conversation_id),
    role: r.role as MessageRecord['role'],
    content: String(r.content),
    intent: r.intent ? String(r.intent) : null,
    modelUsed: r.model_used ? String(r.model_used) : null,
    toolCalls: JSON.parse(String(r.tool_calls_json || '[]')),
    createdAt: String(r.created_at),
  }));
}

function formatBytesGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export async function processUserMessage(input: {
  conversationId?: string;
  content: string;
  language?: LanguageMode;
  attachmentNames?: string[];
  signal?: AbortSignal;
}): Promise<{
  conversation: ConversationRecord;
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  spawnedTaskId?: string;
  latencyMs: number;
  provider: string;
  inferenceError: string | null;
}> {
  const db = getDb();
  let conv = input.conversationId
    ? listConversations(100).find((c) => c.id === input.conversationId)
    : undefined;
  if (!conv) {
    conv = createConversation(input.content.slice(0, 56), input.language || 'auto');
  }

  const now = new Date().toISOString();
  const { intent, language: detectedLang } = detectIntentAndLanguage(input.content);
  const effectiveLang = input.language && input.language !== 'auto' ? input.language : detectedLang;

  const userMsgId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, intent, attachments_json, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?)`
  ).run(
    userMsgId,
    conv.id,
    input.content,
    intent,
    JSON.stringify(input.attachmentNames || []),
    now
  );

  // Extract useful persistent memories (instructions/preferences/projects)
  extractAndStoreConversationInsights(input.content, conv.id);

  // Budgeted context retrieval for 8 GB RAM / 2048-token context window
  const relevantMemories = searchMemories(input.content, 4);
  const recentHistory = getConversationMessages(conv.id).slice(-6);

  const toolCalls: Array<{ toolId: string; status: string; summary: string }> = [];
  let groundedToolContext = '';
  let spawnedTaskId: string | undefined;

  // Execute deterministic real tools based on intent before local LLM synthesis
  if (intent === 'diagnostics') {
    const diagRes = await executeTool('sys_diagnostics', { deep: true }, { signal: input.signal });
    toolCalls.push({
      toolId: 'sys_diagnostics',
      status: diagRes.status,
      summary: diagRes.ok ? 'Collected live CPU, RAM, disk, and process telemetry' : diagRes.error || 'Failed',
    });
    if (diagRes.ok && diagRes.output) {
      const t = diagRes.output as Awaited<ReturnType<typeof collectSystemTelemetry>>;
      const topProcs = t.processes
        .slice(0, 4)
        .map((p) => `${p.name} (PID ${p.pid}: RAM ${p.memPercent}%, CPU ${p.cpuPercent}%)`)
        .join('; ');
      groundedToolContext += `\n[REAL SYSTEM TELEMETRY]\nOS: ${t.os.platform} ${t.os.release}\nCPU: ${t.cpu.model} (${t.cpu.cores} cores, usage ${t.cpu.usagePercent}%, load1m ${t.cpu.loadAvg1m})\nRAM: ${formatBytesGb(t.memory.usedBytes)} / ${formatBytesGb(t.memory.totalBytes)} (${t.memory.usagePercent}% used, pressure: ${t.memory.pressure})\nDisk: ${formatBytesGb(t.disk.usedBytes)} / ${formatBytesGb(t.disk.totalBytes)} (${t.disk.usagePercent}%)\nTop Processes: ${topProcs || 'unavailable'}`;
    }
  } else if (intent === 'reminder') {
    const item = createProductivityItem({
      itemType: 'reminder',
      title: input.content.slice(0, 120),
      priority: 'medium',
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    toolCalls.push({
      toolId: 'productivity_create',
      status: 'completed',
      summary: `Saved reminder "${item.title}"`,
    });
    groundedToolContext += `\n[CREATED REMINDER]\nID: ${item.id}, Title: ${item.title}`;
  } else if (intent === 'bug_repair' || intent === 'task') {
    const task = createTask({
      title: input.content.slice(0, 80),
      goal: input.content,
      conversationId: conv.id,
      autoStart: true,
    });
    spawnedTaskId = task.id;
    toolCalls.push({
      toolId: 'task_orchestrator',
      status: 'completed',
      summary: `Queued autonomous task ${task.id.slice(0, 8)} (${task.steps?.length || 0} steps)`,
    });
    groundedToolContext += `\n[AUTONOMOUS TASK QUEUED]\nTask ID: ${task.id}\nSteps: ${(task.steps || []).map((s) => `${s.stepOrder}. ${s.title} (${s.agentRole})`).join('; ')}`;
  } else if (intent === 'research') {
    const resOut = await executeTool('web_research', { query: input.content }, { signal: input.signal });
    toolCalls.push({
      toolId: 'web_research',
      status: resOut.status,
      summary: resOut.ok ? 'Completed grounded research query' : resOut.error || 'Failed',
    });
    if (resOut.ok) {
      groundedToolContext += `\n[RESEARCH FINDINGS]\n${JSON.stringify(resOut.output).slice(0, 1000)}`;
    }
  } else if (intent === 'coding') {
    const codeOut = await executeTool('code_analyze', { subDir: '.' }, { signal: input.signal });
    toolCalls.push({
      toolId: 'code_analyze',
      status: codeOut.status,
      summary: codeOut.ok ? 'Analyzed workspace project structure' : codeOut.error || 'Failed',
    });
    if (codeOut.ok) {
      groundedToolContext += `\n[PROJECT ANALYSIS]\n${JSON.stringify(codeOut.output).slice(0, 900)}`;
    }
  }

  const memoryBlock =
    relevantMemories.length > 0
      ? `\n[PERSISTENT MEMORY]\n${relevantMemories
          .map((m) => `- (${m.category}) ${m.title}: ${m.content.slice(0, 160)}`)
          .join('\n')}`
      : '';

  const agentRoles = listAgents().map((a) => a.role).join(', ');
  const recentTasks = listTasks(3);
  const orchestrationBlock =
    `\n[AGENT ORCHESTRATION]\nSpecialized agents: ${agentRoles}.` +
    (recentTasks.length > 0
      ? `\nRecent tasks: ${recentTasks
          .map((t) => `${t.title.slice(0, 40)} [${t.status}, ${t.progress}%]`)
          .join('; ')}`
      : '');

  const langDirective =
    effectiveLang === 'hi'
      ? 'Reply naturally and respectfully in clear Hindi (Devanagari script). Keep technical terms like CPU, RAM, SQLite, API, Git in English when clearest.'
      : effectiveLang === 'hinglish'
      ? 'Reply in natural conversational Hinglish (everyday Hindi + English mix in Latin script, e.g., "Aapka system status check kar liya hai..."). Stay concise and friendly.'
      : 'Reply clearly, concisely, and directly in English.';

  const systemPrompt = `You are JARVIS, a local-first autonomous personal AI operating system running locally on the owner's 8 GB RAM Windows 11 laptop.
${langDirective}
Strict Grounding Rules:
- Cite ONLY real telemetry, files, tools, tasks, and memories shown below.
- Never claim to have run a tool, edited a file, heard audio, or controlled an app unless it appears in the verified context below.
- If a tool or capability is unavailable, state it plainly and concisely.${orchestrationBlock}${memoryBlock}${groundedToolContext.slice(0, 1400)}`;

  const turns: ChatTurnMessage[] = [
    { role: 'system', content: systemPrompt },
    ...recentHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content.slice(0, 600),
      })),
  ];

  const aiResult = await runAIInference(turns, {
    signal: input.signal,
    maxTokens: 512,
    temperature: 0.35,
  });
  let assistantText = aiResult.text.trim();
  let modelUsed = aiResult.model;

  if (!aiResult.available || !assistantText) {
    // Honest deterministic fallback ONLY reporting real tool/system results & exact Ollama/AI error
    const engineStatus = await inspectAIEngineStatus();
    const errorDetail = aiResult.error || engineStatus.reasonIfUnavailable || 'Local AI engine unavailable';
    if (groundedToolContext) {
      assistantText =
        effectiveLang === 'hinglish'
          ? `Real tool execution complete hua (Local LLM offline/unreachable hai, isliye direct verified tool result dikha raha hoon):\n${groundedToolContext.trim()}\n\nAI Status: ${errorDetail}`
          : effectiveLang === 'hi'
          ? `वास्तविक टूल निष्पादन पूरा हुआ (स्थानीय AI मॉडल अभी उपलब्ध नहीं है, इसलिए सत्यापित परिणाम नीचे हैं):\n${groundedToolContext.trim()}\n\nAI स्थिति: ${errorDetail}`
          : `Executed real subsystem tools directly (local LLM synthesis unavailable):\n${groundedToolContext.trim()}\n\nAI Status: ${errorDetail}`;
    } else {
      assistantText = `Local AI inference could not complete (${errorDetail}).\n\nSetup check:\n- ${engineStatus.setupInstructions.join('\n- ')}`;
    }
    modelUsed = `${aiResult.provider === 'ollama' ? 'ollama-error' : 'ollama-offline'} (${aiResult.inferenceMode})`;
  }

  const assistantMsgId = crypto.randomUUID();
  const replyTime = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, intent, model_used, tool_calls_json, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`
  ).run(
    assistantMsgId,
    conv.id,
    assistantText,
    intent,
    modelUsed,
    JSON.stringify(toolCalls),
    replyTime
  );

  const nextTitle =
    conv.title === 'New Conversation' ? input.content.slice(0, 56) : conv.title;
  db.prepare('UPDATE conversations SET title = ?, language = ?, updated_at = ? WHERE id = ?').run(
    nextTitle,
    effectiveLang,
    replyTime,
    conv.id
  );

  return {
    conversation: { ...conv, title: nextTitle, language: effectiveLang, updatedAt: replyTime },
    userMessage: {
      id: userMsgId,
      conversationId: conv.id,
      role: 'user',
      content: input.content,
      intent,
      modelUsed: null,
      toolCalls: [],
      createdAt: now,
    },
    assistantMessage: {
      id: assistantMsgId,
      conversationId: conv.id,
      role: 'assistant',
      content: assistantText,
      intent,
      modelUsed,
      toolCalls,
      createdAt: replyTime,
    },
    spawnedTaskId,
    latencyMs: aiResult.durationMs,
    provider: aiResult.provider,
    inferenceError: aiResult.available ? null : aiResult.error || null,
  };
}
