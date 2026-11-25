import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createConversation,
  getConversationMessages,
  listConversations,
  processUserMessage,
} from '../ai/conversationService.js';
import {
  getSavedAISettings,
  inspectAIEngineStatus,
  loadOllamaModel,
  pullOllamaModel,
  saveAISettings,
  testAIInference,
  unloadOllamaModel,
} from '../ai/engine.js';
import {
  controlTask,
  createTask,
  listAgents,
  listTasks,
} from '../agents/orchestrator.js';
import {
  createAutomation,
  listAutomations,
  runAutomationNow,
  toggleAutomation,
} from '../automation/automationService.js';
import { conductResearch, inspectWebPage, listResearchReports } from '../browser/browserService.js';
import {
  createBusinessRecord,
  createProductivityItem,
  evaluateDecisionMatrix,
  getBusinessSummary,
  getOwnerAbsenceConfig,
  listBusinessRecords,
  listProductivityItems,
  runDigitalTwinSimulation,
  updateOwnerAbsenceConfig,
  updateProductivityItemStatus,
} from '../business/businessService.js';
import {
  checkDatabaseIntegrity,
  createDatabaseBackup,
  getDb,
  listDatabaseBackups,
} from '../database/db.js';
import {
  executeDesktopAction,
  getAutostartStatus,
  getDesktopCapabilities,
  setAutostartEnabled,
} from '../desktop/windowsControl.js';
import {
  listPairedDevices,
  pairDevice,
  revokeDevice,
  verifyDeviceToken,
} from '../devices/deviceService.js';
import {
  analyzeProject,
  applyMultiFileChanges,
  detectTestEnvironment,
  executeRealTests,
  generateUnitTestsForFile,
  getTestBaseline,
  listBugRecords,
  listProjects,
  listTestRuns,
  runBugScan,
  runIterativeRepairLoop,
  saveTestBaseline,
} from '../engineering/engineerService.js';
import { eventBus } from '../events/eventBus.js';
import {
  copyWorkspaceFile,
  findDuplicateFiles,
  moveWorkspaceFile,
  readAndParseWorkspaceFile,
  restoreFileCheckpoint,
  searchWorkspaceFiles,
  writeWorkspaceFileWithCheckpoint,
} from '../files/fileService.js';
import { getAuditLogs, logAudit } from '../logging/logger.js';
import {
  deleteMemory,
  forgetMemoriesByQuery,
  listMemories,
  searchMemories,
  storeMemory,
  updateMemory,
} from '../memory/memoryService.js';
import { collectSystemTelemetry } from '../monitoring/systemMonitor.js';
import {
  executeTool,
  listPendingApprovals,
  listRegisteredTools,
  listToolExecutions,
  resolveApprovalRequest,
} from '../tools/registry.js';
import {
  getVoiceSubsystemStatus,
  synthesizeSpeechLocal,
  transcribeAudioLocal,
  updateVoiceConfig,
} from '../voice/voiceService.js';
import type { JarvisEvent } from '../types.js';

const activeChatAbortControllers = new Map<string, AbortController>();

export function createApiRouter(): Router {
  const router = Router();

  // Optional paired companion device bearer-token check (rejects forged/revoked device tokens with 401)
  router.use((req: Request, res: Response, next) => {
    const authHeader = req.headers.authorization;
    const deviceIdHeader = req.headers['x-jarvis-device-id'];
    if (authHeader && authHeader.startsWith('Bearer jrv_')) {
      const token = authHeader.slice('Bearer '.length).trim();
      const deviceId = typeof deviceIdHeader === 'string' ? deviceIdHeader.trim() : '';
      if (!deviceId || !verifyDeviceToken(deviceId, token)) {
        logAudit('security', 'device_auth', 'invalid_device_token', {
          deviceId: deviceId || 'missing',
          path: req.path,
        });
        return res.status(401).json({ error: 'Invalid or revoked device pairing token' });
      }
    }
    next();
  });

  // Real-time Server-Sent Events stream
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const onEvent = (event: JarvisEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventBus.on('jarvis_event', onEvent);
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      eventBus.off('jarvis_event', onEvent);
    });
  });

  // Health & Hardware Telemetry
  router.get('/health', async (_req: Request, res: Response) => {
    const dbCheck = checkDatabaseIntegrity();
    const telemetry = await collectSystemTelemetry(false);
    const ai = await inspectAIEngineStatus();
    res.json({
      status: dbCheck.ok ? 'healthy' : 'degraded',
      database: dbCheck,
      telemetry,
      ai,
    });
  });

  router.get('/system/telemetry', async (req: Request, res: Response) => {
    const deep = req.query.deep === 'true';
    const telemetry = await collectSystemTelemetry(deep);
    res.json(telemetry);
  });

  // First-Run Setup Wizard Inspection & Configuration
  router.get('/setup/inspect', async (_req: Request, res: Response) => {
    const [telemetry, ai, voice] = await Promise.all([
      collectSystemTelemetry(true),
      inspectAIEngineStatus(),
      getVoiceSubsystemStatus(),
    ]);
    const db = getDb();
    const setupDoneRow = db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('setup_completed') as { value_json: string } | undefined;

    const missingDependencies: string[] = [];
    if (!telemetry.runtimes.ollama && !telemetry.runtimes.llamacpp) {
      missingDependencies.push('Ollama or llama.cpp local LLM server');
    }
    if (!voice.backendCapabilities.whisperAvailable) {
      missingDependencies.push('whisper.cpp / faster-whisper (optional backend STT; browser speech active)');
    }
    if (!voice.backendCapabilities.piperAvailable) {
      missingDependencies.push('Piper TTS (optional backend TTS; browser synthesis active)');
    }
    if (!telemetry.runtimes.cargo) {
      missingDependencies.push('Rust/Cargo (required only to compile Tauri native binary)');
    }

    const totalRamGb = Math.round((telemetry.memory.totalBytes / 1024 ** 3) * 10) / 10;
    const recommendedModel =
      totalRamGb <= 8.5 ? 'qwen2.5:3b (Q4_K_M, ~2.0 GB RAM)' : 'qwen2.5:7b (Q4_K_M, ~4.7 GB RAM)';

    res.json({
      setupCompleted: setupDoneRow ? JSON.parse(setupDoneRow.value_json) : false,
      telemetry,
      ai,
      voice,
      missingDependencies,
      recommendedModel,
      targetProfile: totalRamGb <= 8.5 ? 'Low-Resource 8GB Mode' : 'Standard Mode',
    });
  });

  router.post('/setup/complete', (req: Request, res: Response) => {
    const schema = z.object({
      language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
      wakeWord: z.string().min(2).max(48).optional(),
      inferenceMode: z.enum(['local_only', 'cloud_assisted']).optional(),
      preferredProvider: z.enum(['auto', 'ollama', 'llamacpp', 'gemini']).optional(),
      ollamaUrl: z.string().url().optional(),
      allowCloudFallback: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    if (parsed.data.language || parsed.data.wakeWord) {
      updateVoiceConfig({
        language: parsed.data.language,
        wakeWord: parsed.data.wakeWord,
      });
    }
    if (
      parsed.data.inferenceMode ||
      parsed.data.preferredProvider ||
      parsed.data.ollamaUrl ||
      parsed.data.allowCloudFallback !== undefined
    ) {
      saveAISettings({
        inferenceMode: parsed.data.inferenceMode,
        preferredProvider: parsed.data.preferredProvider,
        ollamaUrl: parsed.data.ollamaUrl,
        allowCloudFallback: parsed.data.allowCloudFallback,
      });
    }

    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('setup_completed', 'true', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = 'true', updated_at = excluded.updated_at`
    ).run(new Date().toISOString());

    logAudit('info', 'setup', 'wizard_completed', parsed.data);
    res.json({ ok: true });
  });

  // AI Engine & Model Management
  router.get('/ai/status', async (_req: Request, res: Response) => {
    const [status, settings] = await Promise.all([
      inspectAIEngineStatus(),
      Promise.resolve(getSavedAISettings()),
    ]);
    res.json({ ...status, settings });
  });

  router.post('/ai/settings', (req: Request, res: Response) => {
    const schema = z.object({
      inferenceMode: z.enum(['local_only', 'cloud_assisted']).optional(),
      preferredProvider: z.enum(['auto', 'ollama', 'llamacpp', 'gemini']).optional(),
      preferredModel: z.string().nullable().optional(),
      allowCloudFallback: z.boolean().optional(),
      ollamaUrl: z.string().url().optional(),
      llamacppUrl: z.string().url().optional(),
      systemPrompt: z.string().max(2000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(saveAISettings(parsed.data));
  });

  router.post('/ai/test', async (_req: Request, res: Response) => {
    const result = await testAIInference();
    res.status(result.ok ? 200 : 503).json(result);
  });

  router.post('/ai/models/load', async (req: Request, res: Response) => {
    const schema = z.object({ modelName: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await loadOllamaModel(parsed.data.modelName);
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.post('/ai/models/unload', async (req: Request, res: Response) => {
    const schema = z.object({ modelName: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await unloadOllamaModel(parsed.data.modelName);
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.post('/ai/models/pull', async (req: Request, res: Response) => {
    const schema = z.object({ modelName: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await pullOllamaModel(parsed.data.modelName);
    res.status(result.ok ? 200 : 502).json(result);
  });

  // Conversations & Chat
  router.get('/conversations', (_req: Request, res: Response) => {
    res.json({ conversations: listConversations() });
  });

  router.post('/conversations', (req: Request, res: Response) => {
    const schema = z.object({
      title: z.string().min(1).max(120).optional(),
      language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(createConversation(parsed.data.title, parsed.data.language));
  });

  router.get('/conversations/:id/messages', (req: Request, res: Response) => {
    res.json({ messages: getConversationMessages(String(req.params.id)) });
  });

  router.post('/chat', async (req: Request, res: Response) => {
    const schema = z.object({
      conversationId: z.string().optional(),
      content: z.string().min(1).max(16_000),
      language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
      attachmentNames: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    activeChatAbortControllers.set(requestId, controller);

    try {
      const result = await processUserMessage({
        ...parsed.data,
        signal: controller.signal,
      });
      res.json({ requestId, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Chat processing error' });
    } finally {
      activeChatAbortControllers.delete(requestId);
    }
  });

  router.post('/chat/interrupt', (_req: Request, res: Response) => {
    let aborted = 0;
    for (const controller of activeChatAbortControllers.values()) {
      controller.abort();
      aborted++;
    }
    res.json({ ok: true, aborted });
  });

  // Voice Subsystem
  router.get('/voice', async (_req: Request, res: Response) => {
    res.json(await getVoiceSubsystemStatus());
  });

  router.patch('/voice', (req: Request, res: Response) => {
    const schema = z.object({
      enabled: z.boolean().optional(),
      wakeWord: z.string().min(2).max(48).optional(),
      wakePhrases: z.array(z.string().min(2).max(48)).optional(),
      continuousListening: z.boolean().optional(),
      language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
      speechRate: z.number().min(0.5).max(2.0).optional(),
      speechPitch: z.number().min(0.5).max(2.0).optional(),
      speechVolume: z.number().min(0.0).max(1.0).optional(),
      shortVoiceResponses: z.boolean().optional(),
      voiceName: z.string().optional(),
      inputDeviceId: z.string().optional(),
      outputDeviceId: z.string().optional(),
      vadThreshold: z.number().min(1).max(80).optional(),
      interruptible: z.boolean().optional(),
      silenceTimeoutMs: z.number().min(500).max(6000).optional(),
      quietHoursEnabled: z.boolean().optional(),
      quietHoursStart: z.string().optional(),
      quietHoursEnd: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(updateVoiceConfig(parsed.data));
  });

  router.post('/voice/transcribe', async (req: Request, res: Response) => {
    const schema = z.object({
      audioBase64: z.string().min(10),
      language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await transcribeAudioLocal(parsed.data.audioBase64, parsed.data.language);
    res.status(result.ok ? 200 : 503).json(result);
  });

  router.post('/voice/synthesize', async (req: Request, res: Response) => {
    const schema = z.object({
      text: z.string().min(1).max(1200),
      rate: z.number().min(0.5).max(2.0).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await synthesizeSpeechLocal(parsed.data.text, parsed.data.rate ?? 1.0);
    res.status(result.ok ? 200 : 503).json(result);
  });

  // Memory & Knowledge Brain
  router.get('/memory', (req: Request, res: Response) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (query) {
      return res.json({ items: searchMemories(query, 30) });
    }
    res.json({ items: listMemories({ category, limit: 150 }) });
  });

  router.post('/memory', (req: Request, res: Response) => {
    const schema = z.object({
      category: z.enum([
        'preference',
        'instruction',
        'project',
        'goal',
        'conversation',
        'decision',
        'task',
        'fact',
        'technical',
        'business',
        'correction',
        'lesson',
        'workflow_success',
        'workflow_failure',
      ]),
      title: z.string().min(2).max(180),
      content: z.string().min(4).max(4000),
      source: z.string().default('owner'),
      context: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = storeMemory(parsed.data);
    if (!result.stored) return res.status(400).json({ error: result.rejectedReason });
    res.status(201).json(result);
  });

  router.patch('/memory/:id', (req: Request, res: Response) => {
    const schema = z.object({
      title: z.string().min(2).optional(),
      content: z.string().min(4).optional(),
      importance: z.number().min(0).max(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const updated = updateMemory(String(req.params.id), parsed.data);
      if (!updated) return res.status(404).json({ error: 'Memory not found' });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  router.delete('/memory/:id', (req: Request, res: Response) => {
    const deleted = deleteMemory(String(req.params.id));
    res.status(deleted ? 200 : 404).json({ ok: deleted });
  });

  router.post('/memory/forget', (req: Request, res: Response) => {
    const schema = z.object({ query: z.string().min(2).max(300) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(forgetMemoriesByQuery(parsed.data.query));
  });

  router.get('/memory/export', (_req: Request, res: Response) => {
    res.json({ exportedAt: new Date().toISOString(), items: listMemories({ limit: 500 }) });
  });

  // Tasks & Multi-Agent Orchestrator
  router.get('/tasks', (_req: Request, res: Response) => {
    res.json({ tasks: listTasks() });
  });

  router.post('/tasks', (req: Request, res: Response) => {
    const schema = z.object({
      title: z.string().min(2).max(140),
      goal: z.string().min(2).max(2000),
      priority: z.number().int().min(1).max(5).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const task = createTask(parsed.data);
    res.status(201).json(task);
  });

  router.post('/tasks/:id/control', (req: Request, res: Response) => {
    const schema = z.object({ action: z.enum(['pause', 'resume', 'cancel', 'retry']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const task = controlTask(String(req.params.id), parsed.data.action);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  router.get('/agents', (_req: Request, res: Response) => {
    const db = getDb();
    const recentRuns = db
      .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 30')
      .all();
    res.json({ agents: listAgents(), recentRuns });
  });

  // Tool Registry & Approvals
  router.get('/tools', (_req: Request, res: Response) => {
    res.json({
      tools: listRegisteredTools(),
      executions: listToolExecutions(40),
      approvals: listPendingApprovals(),
    });
  });

  router.post('/tools/execute', async (req: Request, res: Response) => {
    const schema = z.object({
      toolId: z.string().min(1),
      input: z.unknown().optional(),
      approvedByOwner: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await executeTool(parsed.data.toolId, parsed.data.input, {
      approvedByOwner: parsed.data.approvedByOwner,
    });
    res.json(result);
  });

  router.post('/approvals/:id', async (req: Request, res: Response) => {
    const schema = z.object({ decision: z.enum(['approved', 'rejected']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const result = await resolveApprovalRequest(String(req.params.id), parsed.data.decision);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Approval error' });
    }
  });

  // Files & Checkpoints
  router.get('/files', (req: Request, res: Response) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : undefined;
      const subDir = typeof req.query.subDir === 'string' ? req.query.subDir : undefined;
      res.json({ files: searchWorkspaceFiles({ query, subDir, maxResults: 200 }) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'File search failed' });
    }
  });

  router.get('/files/read', (req: Request, res: Response) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      res.json(readAndParseWorkspaceFile(relPath));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Read failed' });
    }
  });

  router.post('/files/write', (req: Request, res: Response) => {
    const schema = z.object({ path: z.string().min(1), content: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(writeWorkspaceFileWithCheckpoint(parsed.data.path, parsed.data.content));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Write failed' });
    }
  });

  router.post('/files/move', (req: Request, res: Response) => {
    const schema = z.object({ from: z.string().min(1), to: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(moveWorkspaceFile(parsed.data.from, parsed.data.to));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Move failed' });
    }
  });

  router.post('/files/copy', (req: Request, res: Response) => {
    const schema = z.object({ from: z.string().min(1), to: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(copyWorkspaceFile(parsed.data.from, parsed.data.to));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Copy failed' });
    }
  });

  router.post('/files/delete', async (req: Request, res: Response) => {
    const schema = z.object({
      path: z.string().min(1),
      approvedByOwner: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const gated = await executeTool(
      'file_delete',
      { path: parsed.data.path },
      { approvedByOwner: parsed.data.approvedByOwner }
    );
    res.json(gated);
  });

  router.post('/files/organize', async (req: Request, res: Response) => {
    const schema = z.object({
      subDir: z.string().min(1),
      dryRun: z.boolean().optional(),
      approvedByOwner: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const gated = await executeTool(
      'file_organize',
      { subDir: parsed.data.subDir, dryRun: parsed.data.dryRun },
      { approvedByOwner: parsed.data.approvedByOwner }
    );
    res.json(gated);
  });

  router.get('/files/duplicates', (_req: Request, res: Response) => {
    res.json({ duplicates: findDuplicateFiles() });
  });

  router.post('/checkpoints/:id/restore', (req: Request, res: Response) => {
    try {
      res.json(restoreFileCheckpoint(String(req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  // Browser Agent & Research Engine
  router.post('/browser/inspect', async (req: Request, res: Response) => {
    const schema = z.object({ url: z.string().url() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const page = await inspectWebPage(parsed.data.url);
      res.json(page);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Inspection blocked/failed' });
    }
  });

  router.get('/research', (_req: Request, res: Response) => {
    res.json({ reports: listResearchReports() });
  });

  router.post('/research', async (req: Request, res: Response) => {
    const schema = z.object({
      query: z.string().min(2),
      urls: z.array(z.string().url()).optional(),
      onlineAllowed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const report = await conductResearch(parsed.data.query, parsed.data);
    res.status(201).json(report);
  });

  // Software Engineer, Bug Hunter & Testing Lab
  router.get('/projects', (_req: Request, res: Response) => {
    res.json({ projects: listProjects() });
  });

  router.post('/projects/analyze', async (req: Request, res: Response) => {
    const schema = z.object({ subDir: z.string().default('.') });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(await analyzeProject(parsed.data.subDir));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Analysis failed' });
    }
  });

  router.get('/bugs', (_req: Request, res: Response) => {
    res.json({ bugs: listBugRecords() });
  });

  router.post('/bugs/scan', async (req: Request, res: Response) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    const findings = await runBugScan(projectId);
    res.json({ findings });
  });

  router.get('/tests', (_req: Request, res: Response) => {
    res.json({ runs: listTestRuns() });
  });

  router.post('/tests/run', async (req: Request, res: Response) => {
    const schema = z.object({
      suite: z.enum(['typecheck', 'vitest', 'all']).default('typecheck'),
      projectId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const run = await executeRealTests(parsed.data);
    res.json(run);
  });

  router.get('/engineering/environment', async (_req: Request, res: Response) => {
    res.json(await detectTestEnvironment());
  });

  router.post('/engineering/multi-edit', async (req: Request, res: Response) => {
    const schema = z.object({
      label: z.string().min(2),
      changes: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
      verifyTypecheck: z.boolean().optional(),
      autoRollbackOnFail: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(await applyMultiFileChanges(parsed.data.changes, parsed.data.label, parsed.data));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Multi-file edit failed' });
    }
  });

  router.post('/engineering/generate-tests', async (req: Request, res: Response) => {
    const schema = z.object({
      targetPath: z.string().min(1),
      runImmediately: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(
        await generateUnitTestsForFile(parsed.data.targetPath, Boolean(parsed.data.runImmediately))
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Test generation failed' });
    }
  });

  router.get('/engineering/baseline', (req: Request, res: Response) => {
    const suite = typeof req.query.suite === 'string' ? req.query.suite : 'vitest';
    res.json({ baseline: getTestBaseline(suite) });
  });

  router.post('/engineering/baseline', (req: Request, res: Response) => {
    const schema = z.object({
      suiteName: z.string().min(1),
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(
      saveTestBaseline({
        ...parsed.data,
        capturedAt: new Date().toISOString(),
      })
    );
  });

  router.post('/engineering/repair-loop', async (req: Request, res: Response) => {
    const schema = z.object({
      label: z.string().optional(),
      suite: z.enum(['typecheck', 'vitest']).optional(),
      specificFile: z.string().optional(),
      maxIterations: z.number().int().min(1).max(5).optional(),
      candidateFixes: z
        .array(z.array(z.object({ path: z.string().min(1), content: z.string() })))
        .optional(),
      autoRollbackOnFail: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      res.json(await runIterativeRepairLoop(parsed.data));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Repair loop failed' });
    }
  });

  // Desktop Control & Windows 11 Startup
  router.get('/desktop/capabilities', async (_req: Request, res: Response) => {
    res.json(await getDesktopCapabilities());
  });

  router.post('/desktop/action', async (req: Request, res: Response) => {
    const schema = z.object({
      action: z.enum([
        'check_capabilities',
        'list_processes',
        'list_windows',
        'get_active_window',
        'focus_window',
        'launch_app',
        'close_app',
        'open_url',
        'type_text',
        'scroll',
        'click_at',
        'get_clipboard',
        'set_clipboard',
        'capture_screenshot',
        'windows_diagnostics',
      ]),
      target: z.string().optional(),
      text: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      delta: z.number().optional(),
      approvedByOwner: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    if (parsed.data.action === 'check_capabilities' || parsed.data.action === 'list_processes') {
      return res.json(await executeDesktopAction(parsed.data));
    }
    const gated = await executeTool('computer_control', parsed.data, {
      approvedByOwner: parsed.data.approvedByOwner,
    });
    res.json(gated);
  });

  router.get('/desktop/autostart', async (_req: Request, res: Response) => {
    res.json(await getAutostartStatus());
  });

  router.post('/desktop/autostart', async (req: Request, res: Response) => {
    const schema = z.object({ enabled: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(await setAutostartEnabled(parsed.data.enabled));
  });

  // Business Manager, Productivity, Owner Absence, Decision Engine, Digital Twin
  router.get('/business', (req: Request, res: Response) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    res.json({
      summary: getBusinessSummary(),
      records: listBusinessRecords(domain),
    });
  });

  router.post('/business', (req: Request, res: Response) => {
    const schema = z.object({
      domain: z.enum(['sales', 'marketing', 'finance', 'hr', 'operations']),
      recordType: z.string().min(1),
      title: z.string().min(2),
      status: z.string().optional(),
      amount: z.number().nullable().optional(),
      currency: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(createBusinessRecord(parsed.data));
  });

  router.get('/productivity', (req: Request, res: Response) => {
    const itemType = typeof req.query.type === 'string' ? req.query.type : undefined;
    res.json(listProductivityItems(itemType));
  });

  router.post('/productivity', (req: Request, res: Response) => {
    const schema = z.object({
      itemType: z.enum(['task', 'reminder', 'event', 'note', 'goal']),
      title: z.string().min(2),
      details: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      dueAt: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(createProductivityItem(parsed.data));
  });

  router.patch('/productivity/:id', (req: Request, res: Response) => {
    const schema = z.object({ status: z.enum(['open', 'in_progress', 'done']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const ok = updateProductivityItemStatus(String(req.params.id), parsed.data.status);
    res.status(ok ? 200 : 404).json({ ok });
  });

  router.get('/owner-absence', (_req: Request, res: Response) => {
    res.json(getOwnerAbsenceConfig());
  });

  router.patch('/owner-absence', (req: Request, res: Response) => {
    const schema = z.object({
      enabled: z.boolean().optional(),
      spendingLimitUsd: z.number().min(0).optional(),
      maxDurationHours: z.number().min(1).max(72).optional(),
      emergencyStopped: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(updateOwnerAbsenceConfig(parsed.data));
  });

  router.post('/decision/evaluate', (req: Request, res: Response) => {
    const schema = z.object({
      objective: z.string().min(2),
      alternatives: z
        .array(
          z.object({
            name: z.string().min(1),
            cost: z.number().min(0),
            timeHours: z.number().min(0),
            riskScore: z.number().min(1).max(10),
            benefitScore: z.number().min(1).max(10),
            reversible: z.boolean(),
          })
        )
        .min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(evaluateDecisionMatrix(parsed.data.objective, parsed.data.alternatives));
  });

  router.post('/simulations', (req: Request, res: Response) => {
    const schema = z.object({
      domain: z.string().min(1),
      scenarioName: z.string().min(2),
      assumptions: z.record(z.string(), z.number()),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(runDigitalTwinSimulation(parsed.data));
  });

  // Automations
  router.get('/automations', (_req: Request, res: Response) => {
    const db = getDb();
    const runs = db
      .prepare('SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 30')
      .all();
    res.json({ automations: listAutomations(), runs });
  });

  router.post('/automations', (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(2),
      description: z.string().min(2),
      triggerType: z.enum(['interval', 'event', 'manual']),
      intervalSeconds: z.number().int().min(30).nullable().optional(),
      actionType: z.string().min(1),
      actionPayload: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(createAutomation(parsed.data));
  });

  router.patch('/automations/:id', (req: Request, res: Response) => {
    const schema = z.object({ enabled: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const updated = toggleAutomation(String(req.params.id), parsed.data.enabled);
    if (!updated) return res.status(404).json({ error: 'Automation not found' });
    res.json(updated);
  });

  router.post('/automations/:id/run', async (req: Request, res: Response) => {
    try {
      res.json(await runAutomationNow(String(req.params.id)));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Run failed' });
    }
  });

  // Devices & Android Companion Architecture
  router.get('/devices', (_req: Request, res: Response) => {
    res.json({ devices: listPairedDevices() });
  });

  router.post('/devices/pair', (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(2),
      platform: z.enum(['windows', 'android', 'linux', 'macos', 'web']),
      deviceType: z.enum(['desktop', 'mobile', 'tablet']),
      capabilities: z.array(z.string()).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(pairDevice(parsed.data));
  });

  router.delete('/devices/:id', (req: Request, res: Response) => {
    const ok = revokeDevice(String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Database Backup, Integrity & Audit Logs
  router.get('/database/status', (_req: Request, res: Response) => {
    res.json({
      integrity: checkDatabaseIntegrity(),
      backups: listDatabaseBackups(),
    });
  });

  router.post('/database/backup', (_req: Request, res: Response) => {
    const backup = createDatabaseBackup();
    logAudit('info', 'database', 'backup_created', backup);
    res.status(201).json(backup);
  });

  router.get('/audit', (req: Request, res: Response) => {
    const limit = Number(req.query.limit || 100);
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    res.json({ logs: getAuditLogs(limit, level) });
  });

  return router;
}
