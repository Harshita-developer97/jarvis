import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { processUserMessage, getConversationMessages } from '../server/ai/conversationService.js';
import { getSavedAISettings, runAIInference, saveAISettings } from '../server/ai/engine.js';
import { controlTask, createTask } from '../server/agents/orchestrator.js';
import { getDb } from '../server/database/db.js';
import { executeDesktopAction, getDesktopCapabilities } from '../server/desktop/windowsControl.js';
import {
  applyMultiFileChanges,
  detectTestEnvironment,
  generateUnitTestsForFile,
  getTestBaseline,
  saveTestBaseline,
} from '../server/engineering/engineerService.js';
import { resolveSafeWorkspacePath } from '../server/security/guard.js';
import {
  getVoiceSubsystemStatus,
  synthesizeSpeechLocal,
  transcribeAudioLocal,
} from '../server/voice/voiceService.js';

describe('JARVIS Local-First Capabilities & Integrity Verification', () => {
  const initialAISettings = getSavedAISettings();

  afterAll(() => {
    // Restore default local_only AI mode after tests
    saveAISettings({
      inferenceMode: 'local_only',
      preferredProvider: initialAISettings.preferredProvider,
      preferredModel: initialAISettings.preferredModel,
    });
    const db = getDb();
    db.prepare('DELETE FROM settings WHERE key = ?').run('test_baseline_vitest_probe');
  });

  it('strictly blocks silent cloud fallback when inferenceMode is local_only', async () => {
    saveAISettings({ inferenceMode: 'local_only' });
    const result = await runAIInference([{ role: 'user', content: 'Hello JARVIS' }]);
    expect(result.inferenceMode).toBe('local_only');
    // Since Ollama and llama.cpp are not running in this Linux container, provider must NOT fall back to gemini
    expect(result.provider).not.toBe('gemini');
    expect(result.available).toBe(false);
  });

  it('persists multi-turn conversation history and context in SQLite', async () => {
    saveAISettings({ inferenceMode: 'local_only' });
    const turn1 = await processUserMessage({
      content: 'Remember my project uses SQLite WAL mode for reliability.',
    });
    const turn2 = await processUserMessage({
      conversationId: turn1.conversation.id,
      content: 'Jarvis, check system health metrics right now.',
    });

    const history = getConversationMessages(turn1.conversation.id);
    expect(history.length).toBeGreaterThanOrEqual(4);
    expect(turn2.conversation.id).toBe(turn1.conversation.id);
  });

  it('detects test environment and tracks regression baselines accurately', async () => {
    const env = await detectTestEnvironment();
    expect(env.vitestAvailable).toBe(true);
    expect(env.typescriptAvailable).toBe(true);
    expect(env.node).toBeTruthy();

    saveTestBaseline({
      suiteName: 'vitest_probe',
      passed: 21,
      failed: 0,
      capturedAt: new Date().toISOString(),
    });
    const loaded = getTestBaseline('vitest_probe');
    expect(loaded?.passed).toBe(21);
    expect(loaded?.failed).toBe(0);
  });

  it('automatically rolls back multi-file edits when TypeScript verification fails', async () => {
    const tempRel = 'server/__temp_rollback_probe__.ts';
    const tempAbs = resolveSafeWorkspacePath(tempRel);
    try {
      const outcome = await applyMultiFileChanges(
        [{ path: tempRel, content: 'export const brokenNumber: number = "not_a_number";\n' }],
        'Intentional TypeScript error probe',
        { verifyTypecheck: true, autoRollbackOnFail: true }
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.verificationStatus).toBe('failed');
      expect(outcome.rolledBack).toBe(true);
      expect(outcome.diffs[0]).toContain('+++ b/server/__temp_rollback_probe__.ts');
      expect(fs.existsSync(tempAbs)).toBe(false);
    } finally {
      if (fs.existsSync(tempAbs)) fs.unlinkSync(tempAbs);
    }
  }, 45_000);

  it('generates real Vitest unit tests from source exports and executes them', async () => {
    const gen = await generateUnitTestsForFile('server/logging/logger.ts', true);
    const genAbs = resolveSafeWorkspacePath(gen.generatedTestPath);
    try {
      expect(gen.exportedSymbols).toContain('logAudit');
      expect(gen.exportedSymbols).toContain('getAuditLogs');
      expect(fs.existsSync(genAbs)).toBe(true);
      expect(gen.runResult?.status).toBe('passed');
      expect(gen.runResult?.passed).toBe(2);
    } finally {
      if (fs.existsSync(genAbs)) fs.unlinkSync(genAbs);
      const genDir = path.dirname(genAbs);
      if (fs.existsSync(genDir) && fs.readdirSync(genDir).length === 0) {
        fs.rmdirSync(genDir);
      }
    }
  }, 45_000);

  it('plans full 6-stage sequential multi-agent pipeline for feature engineering goals', () => {
    const task = createTask({
      title: 'Build multi-agent feature workflow',
      goal: 'Build and develop a new feature module with tests and review',
      autoStart: false,
    });
    const roles = (task.steps || []).map((s) => s.agentRole);
    expect(roles).toEqual([
      'planner',
      'researcher',
      'architect',
      'bug_hunter',
      'qa_engineer',
      'independent_reviewer',
    ]);
    controlTask(task.id, 'cancel');
  });

  it('reports desktop control and local STT/TTS capabilities honestly on Linux container', async () => {
    const caps = await getDesktopCapabilities();
    if (process.platform !== 'win32') {
      expect(caps.isWindows11).toBe(false);
      const res = await executeDesktopAction({ action: 'list_windows' });
      expect(res.available).toBe(false);
      expect(res.verified).toBe(false);
      expect(res.unavailableReason).toContain('Windows 11');
    }

    const voiceStatus = await getVoiceSubsystemStatus();
    expect(voiceStatus.config.vadThreshold).toBeGreaterThan(0);

    if (!voiceStatus.backendCapabilities.whisperAvailable) {
      const stt = await transcribeAudioLocal('UklGRiQAAABXQVZFZm10IBAAAAABAAEA');
      expect(stt.ok).toBe(false);
      expect(stt.error).toContain('whisper');
    }

    if (
      !voiceStatus.backendCapabilities.piperAvailable &&
      !voiceStatus.backendCapabilities.espeakAvailable &&
      !voiceStatus.backendCapabilities.windowsSapiAvailable
    ) {
      const tts = await synthesizeSpeechLocal('Hello JARVIS');
      expect(tts.ok).toBe(false);
      expect(tts.error).toContain('offline backend TTS');
    }
  });
});
