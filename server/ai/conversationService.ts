import crypto from 'node:crypto';
import {
  detectIntentAndLanguage,
  getSavedAISettings,
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
  updateConversationSummary,
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

function parseDesktopTarget(input: string): { action: string; target?: string } {
  const lower = input.toLowerCase();
  const urlMatch = input.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    return { action: 'open_url', target: urlMatch[0] };
  }
  if (lower.includes('screenshot')) return { action: 'capture_screenshot' };
  if (lower.includes('active window')) return { action: 'get_active_window' };

  const apps = ['chrome', 'notepad', 'calculator', 'calc', 'explorer', 'vscode', 'terminal', 'edge'];
  const matchedApp = apps.find((a) => lower.includes(a));
  const isClose = /\b(close|band karo|kill)\b/i.test(lower);
  if (matchedApp) {
    return { action: isClose ? 'close_app' : 'launch_app', target: matchedApp };
  }
  return { action: 'check_capabilities' };
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

  const priorMessages = getConversationMessages(conv.id);
  const lastUserOrAssistant = [...priorMessages]
    .reverse()
    .find((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 4);

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
  const autoSavedMemories = extractAndStoreConversationInsights(
    input.content,
    conv.id,
    lastUserOrAssistant?.content
  );

  // Budgeted context retrieval for 8 GB RAM / 2048-token context window
  const relevantMemories = searchMemories(input.content, 5);
  const recentHistory = getConversationMessages(conv.id).slice(-6);

  const toolCalls: Array<{ toolId: string; status: string; summary: string }> = [];
  let groundedToolContext = '';
  let spawnedTaskId: string | undefined;

  if (autoSavedMemories.length > 0) {
    toolCalls.push({
      toolId: 'memory_store',
      status: 'completed',
      summary: `Stored ${autoSavedMemories.length} persistent memory item(s): ${autoSavedMemories
        .map((m) => m.title)
        .join(', ')}`,
    });
    groundedToolContext += `\n[MEMORY CONFIRMED]\nSaved: ${autoSavedMemories
      .map((m) => `"${m.content}"`)
      .join('; ')}`;
  }

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
  } else if (intent === 'memory') {
    const lower = input.content.toLowerCase();
    if (/\b(forget\s+that|forget\s+about|forget\s+my|bhool\s+jao)\b/i.test(lower)) {
      const cleanedQuery = input.content
        .replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '')
        .replace(/\b(forget\s+that|forget\s+about|forget\s+my|bhool\s+jao)\b/i, '')
        .trim();
      const forgetRes = await executeTool(
        'memory_forget',
        { query: cleanedQuery || input.content },
        { signal: input.signal }
      );
      const out = forgetRes.output as { deletedCount?: number; deletedTitles?: string[] } | undefined;
      toolCalls.push({
        toolId: 'memory_forget',
        status: forgetRes.status,
        summary: forgetRes.ok
          ? `Deleted ${out?.deletedCount ?? 0} matching memory item(s)`
          : forgetRes.error || 'Failed',
      });
      groundedToolContext += `\n[MEMORY CONFIRMED]\nForgotten ${out?.deletedCount ?? 0} memory item(s) matching "${cleanedQuery}".`;
    } else if (
      /\b(what did i tell you|do you remember|kya bataya tha|recall)\b/i.test(lower)
    ) {
      const memRes = await executeTool(
        'memory_search',
        { query: input.content, limit: 5 },
        { signal: input.signal }
      );
      const hits = Array.isArray(memRes.output) ? memRes.output : [];
      toolCalls.push({
        toolId: 'memory_search',
        status: memRes.status,
        summary: `Retrieved ${hits.length} matching memory record(s)`,
      });
      if (hits.length > 0) {
        groundedToolContext += `\n[PERSISTENT MEMORY]\n${hits
          .map((m: any) => `- (${m.category}) ${m.content}`)
          .join('\n')}`;
      } else {
        groundedToolContext += `\n[PERSISTENT MEMORY]\nNo matching stored memory found for this query.`;
      }
    }
  } else if (intent === 'computer_control') {
    const desktopReq = parseDesktopTarget(input.content);
    const deskRes = await executeTool('computer_control', desktopReq, { signal: input.signal });
    toolCalls.push({
      toolId: 'computer_control',
      status: deskRes.status,
      summary:
        deskRes.status === 'waiting_approval'
          ? `Approval requested (${deskRes.approvalId?.slice(0, 8)}) to run ${desktopReq.action} ${desktopReq.target || ''}`.trim()
          : deskRes.ok
          ? `Executed ${desktopReq.action}`
          : deskRes.error || 'Desktop action failed',
    });
    if (deskRes.status === 'waiting_approval') {
      groundedToolContext += `\n[DESKTOP APPROVAL REQUIRED]\nAction "${desktopReq.action}" (${desktopReq.target || 'desktop'}) requires owner authorization in Pending Approvals (Approval ID: ${deskRes.approvalId}).`;
    } else if (deskRes.ok) {
      groundedToolContext += `\n[DESKTOP RESULT]\n${JSON.stringify(deskRes.output).slice(0, 600)}`;
    }
  } else if (intent === 'file_ops') {
    const lower = input.content.toLowerCase();
    if (lower.includes('organize')) {
      const orgRes = await executeTool(
        'file_organize',
        { subDir: 'data/organized_staging', dryRun: true },
        { signal: input.signal }
      );
      toolCalls.push({
        toolId: 'file_organize',
        status: orgRes.status,
        summary:
          orgRes.status === 'waiting_approval'
            ? `Approval required (${orgRes.approvalId?.slice(0, 8)}) before organizing folders`
            : orgRes.error || 'Checked folder organization',
      });
      groundedToolContext += `\n[FILE ORGANIZATION]\nFolder reorganization is workspace-confined and requires owner approval (Approval ID: ${orgRes.approvalId || 'none'}) and an existing target folder inside the workspace.`;
    } else {
      const q = input.content.replace(/^(?:hey\s+)?jarvis[\s,:-]*/i, '').slice(0, 60);
      const searchRes = await executeTool(
        'file_search',
        { query: q.includes('file') ? '' : q, maxResults: 25 },
        { signal: input.signal }
      );
      toolCalls.push({
        toolId: 'file_search',
        status: searchRes.status,
        summary: searchRes.ok ? 'Listed workspace files' : searchRes.error || 'File search failed',
      });
      if (searchRes.ok && Array.isArray(searchRes.output)) {
        const list = (searchRes.output as Array<{ relativePath: string }>)
          .slice(0, 10)
          .map((f) => f.relativePath)
          .join(', ');
        groundedToolContext += `\n[WORKSPACE FILES]\nMatched ${(searchRes.output as unknown[]).length} entries: ${list || 'none'}`;
      }
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

  const customPersona = getSavedAISettings().systemPrompt?.trim();
  const baseIdentity =
    customPersona ||
    'You are JARVIS, a local-first autonomous personal AI operating system running locally on the owner\'s 8 GB RAM Windows 11 laptop.';

  const systemPrompt = `${baseIdentity}
${langDirective}
Conversation & Speech Style:
- Keep normal replies concise, direct, and easy to hear aloud unless detailed code or technical tables are explicitly requested.
- Avoid outputting raw internal JSON or system log dumps in your reply.
Strict Grounding Rules:
- Cite ONLY real telemetry, files, tools, tasks, and memories shown below.
- Never claim to have run a tool, edited a file, heard audio, or controlled an app unless it appears in the verified context below.
- If a tool or capability is unavailable or requires approval, state it plainly and concisely.${orchestrationBlock}${memoryBlock}${groundedToolContext.slice(0, 1400)}`;

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
    if (aiResult.errorType === 'aborted') {
      assistantText = groundedToolContext
        ? `Request cancelled by user after executing local tools:\n${groundedToolContext.trim()}`
        : effectiveLang === 'hinglish'
        ? 'Request user dwara cancel kar di gayi hai.'
        : effectiveLang === 'hi'
        ? 'अनुरोध उपयोगकर्ता द्वारा रद्द कर दिया गया है।'
        : 'Request was cancelled by the user before inference completed.';
      modelUsed = `cancelled (${aiResult.inferenceMode})`;
    } else if (aiResult.errorType === 'timeout') {
      assistantText = groundedToolContext
        ? `Local tool results ready, but local model response timed out:\n${groundedToolContext.trim()}\n\nTimeout: ${errorDetail}`
        : errorDetail;
      modelUsed = `ollama-timeout (${aiResult.inferenceMode})`;
    } else if (groundedToolContext) {
      assistantText =
        effectiveLang === 'hinglish'
          ? `Real tool check complete ho gaya hai (Local AI abhi unreachable hai, isliye direct verified result dikha raha hoon):\n${groundedToolContext.trim()}\n\nAI Status: ${errorDetail}`
          : effectiveLang === 'hi'
          ? `वास्तविक सिस्टम जांच पूरी हो गई है (स्थानीय AI मॉडल अभी उपलब्ध नहीं है, इसलिए सत्यापित परिणाम नीचे हैं):\n${groundedToolContext.trim()}\n\nAI स्थिति: ${errorDetail}`
          : `Executed real subsystem tools directly (local LLM synthesis unavailable):\n${groundedToolContext.trim()}\n\nAI Status: ${errorDetail}`;
      modelUsed = `${aiResult.provider === 'ollama' ? 'ollama-error' : 'ollama-offline'} (${aiResult.inferenceMode})`;
    } else if (effectiveLang === 'hinglish') {
      assistantText = `Local-Only Mode active hai, lekin Ollama (${engineStatus.ollamaUrl}) abhi backend se reach nahi ho pa raha (${errorDetail}). Agar aap cloud browser preview me test kar rahe hain, toh upar "Cloud Assisted" par click karein; ya apne Windows 11 laptop par local JARVIS app ke saath Ollama run karein.`;
      modelUsed = `${aiResult.provider === 'ollama' ? 'ollama-error' : 'ollama-offline'} (${aiResult.inferenceMode})`;
    } else if (effectiveLang === 'hi') {
      assistantText = `Local-Only मोड सक्रिय है, लेकिन Ollama (${engineStatus.ollamaUrl}) अभी बैकएंड से कनेक्ट नहीं हो पा रहा है (${errorDetail})। क्लाउड ब्राउज़र प्रीव्यू में चैट करने के लिए ऊपर "Cloud Assisted" चुनें, या अपने Windows 11 लैपटॉप पर लोकल JARVIS चलाएं।`;
      modelUsed = `${aiResult.provider === 'ollama' ? 'ollama-error' : 'ollama-offline'} (${aiResult.inferenceMode})`;
    } else {
      assistantText = `Local-Only Mode is active, and Ollama at ${engineStatus.ollamaUrl} is currently unreachable (${errorDetail}). Switch to "Cloud Assisted" in the top bar for cloud preview chat, or run JARVIS locally on Windows 11.\n\nSetup check:\n- ${engineStatus.setupInstructions.join('\n- ')}`;
      modelUsed = `${aiResult.provider === 'ollama' ? 'ollama-error' : 'ollama-offline'} (${aiResult.inferenceMode})`;
    }
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

  if (recentHistory.length >= 3) {
    updateConversationSummary(
      conv.id,
      `Last topic (${intent}): ${input.content.slice(0, 120)} -> ${assistantText.slice(0, 180)}`
    );
  }

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
