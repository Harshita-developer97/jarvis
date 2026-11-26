import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_WAKE_PHRASES,
  detectHindiVoiceAvailable,
  formatVoiceLifecycleLabel,
  isEndConversationCommand,
  isStopSpeechCommand,
  matchWakePhrase,
  resolveSpeechLangTag,
  sanitizeForSpeech,
  splitIntoSpeechSentences,
} from '../src/lib/voiceUtils.js';
import { processUserMessage } from '../server/ai/conversationService.js';
import { getSavedAISettings, saveAISettings } from '../server/ai/engine.js';
import { config } from '../server/config/index.js';
import { getDb } from '../server/database/db.js';
import { pairDevice, revokeDevice } from '../server/devices/deviceService.js';
import { runIterativeRepairLoop } from '../server/engineering/engineerService.js';
import {
  copyWorkspaceFile,
  deleteWorkspaceFile,
  moveWorkspaceFile,
  organizeWorkspaceDirectory,
} from '../server/files/fileService.js';
import { forgetMemoriesByQuery, searchMemories } from '../server/memory/memoryService.js';
import { createApiRouter } from '../server/routes/api.js';
import { resolveSafeWorkspacePath } from '../server/security/guard.js';
import { initializeToolRegistry } from '../server/tools/registry.js';

describe('JARVIS Restoration — Voice Loop, Memory, File Ops, Repair Loop & Auth', () => {
  const initialAI = getSavedAISettings();

  beforeAll(() => {
    getDb();
    initializeToolRegistry();
  });

  afterAll(() => {
    saveAISettings({
      inferenceMode: initialAI.inferenceMode,
      preferredProvider: initialAI.preferredProvider,
      preferredModel: initialAI.preferredModel,
      ollamaUrl: initialAI.ollamaUrl,
      systemPrompt: initialAI.systemPrompt,
    });
  });

  it('matches multi-word, phonetic, Devanagari, two-step, and one-shot wake phrases accurately', () => {
    const twoStep = matchWakePhrase('Hey Jarvis', 'Hey Jarvis', DEFAULT_WAKE_PHRASES);
    expect(twoStep.matched).toBe(true);
    expect(twoStep.hasCommand).toBe(false);
    expect(twoStep.command).toBe('');

    const oneShot = matchWakePhrase(
      'Hey Jarvis, what is the capital of India?',
      'Hey Jarvis',
      DEFAULT_WAKE_PHRASES
    );
    expect(oneShot.matched).toBe(true);
    expect(oneShot.hasCommand).toBe(true);
    expect(oneShot.command).toBe('what is the capital of India?');

    const shortWake = matchWakePhrase('Jarvis check my RAM usage');
    expect(shortWake.matched).toBe(true);
    expect(shortWake.hasCommand).toBe(true);
    expect(shortWake.command).toBe('check my RAM usage');

    const phonetic = matchWakePhrase('Hello Jarvic open diagnostics');
    expect(phonetic.matched).toBe(true);
    expect(phonetic.hasCommand).toBe(true);

    const hindiWake = matchWakePhrase('हे जार्विस समय बताओ');
    expect(hindiWake.matched).toBe(true);
    expect(hindiWake.hasCommand).toBe(true);

    const unrelated = matchWakePhrase('What is the weather in Delhi');
    expect(unrelated.matched).toBe(false);
  });

  it('detects spoken barge-in stop and end-conversation sleep commands across English and Hinglish', () => {
    expect(isStopSpeechCommand('Jarvis stop')).toBe(true);
    expect(isStopSpeechCommand('please stop speaking now')).toBe(true);
    expect(isStopSpeechCommand('bolna band karo')).toBe(true);
    expect(isStopSpeechCommand('ruk jao')).toBe(true);
    expect(isStopSpeechCommand('tell me about TypeScript generics')).toBe(false);

    expect(isEndConversationCommand('bye jarvis')).toBe(true);
    expect(isEndConversationCommand('go to sleep')).toBe(true);
    expect(isEndConversationCommand('bas jarvis')).toBe(true);
    expect(isEndConversationCommand('so jao')).toBe(true);
    expect(isEndConversationCommand('continue the conversation please')).toBe(false);
  });

  it('sanitizes markdown, fenced code, JSON payloads, URLs, and internal telemetry tags for speech', () => {
    const noisy = `[REAL SYSTEM TELEMETRY] Here is the fix:\n\`\`\`ts\nconst x = { a: 1 };\n\`\`\`\nRead [Docs](https://example.com/docs) and visit https://localhost:3000/api for details. {"status":"ok","cpu":42}`;
    const clean = sanitizeForSpeech(noisy);
    expect(clean).not.toContain('```');
    expect(clean).not.toContain('REAL SYSTEM TELEMETRY');
    expect(clean).not.toContain('https://');
    expect(clean).not.toContain('"cpu"');
    expect(clean).toContain('Read Docs');

    const longProse =
      'First diagnostic check passed cleanly. Second subsystem verified SQLite integrity. Third check confirmed local model routing. Fourth note adds extra context.';
    const shortClean = sanitizeForSpeech(longProse + ' '.repeat(120) + longProse, {
      shortMode: true,
    });
    expect(shortClean.length).toBeLessThanOrEqual(260);
  });

  it('splits multi-sentence speech into Chrome-safe chunks and reports voice lifecycle metadata cleanly', () => {
    const chunks = splitIntoSpeechSentences(
      'Sentence one is clear. दूसरा वाक्य हिंदी में है। Sentence three is short!'
    );
    expect(chunks.length).toBe(3);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(260));

    expect(detectHindiVoiceAvailable([{ lang: 'en-US', name: 'David' }])).toBe(false);
    expect(detectHindiVoiceAvailable([{ lang: 'hi-IN', name: 'Microsoft Swara' }])).toBe(true);
    expect(resolveSpeechLangTag('hi')).toBe('hi-IN');
    expect(resolveSpeechLangTag('en')).toBe('en-US');
    expect(formatVoiceLifecycleLabel('wake_listening')).toBe('Wake Listening');
  });

  it('handles natural language remember, recall, and forget commands in SQLite memory', async () => {
    saveAISettings({ inferenceMode: 'local_only' });
    const uniqueFact = 'jarvis_restoration_token_9471 uses PostgreSQL telemetry';
    await processUserMessage({ content: `Remember that ${uniqueFact}` });

    const recalled = searchMemories('jarvis_restoration_token_9471', 5);
    expect(recalled.length).toBeGreaterThanOrEqual(1);

    const forgetRes = forgetMemoriesByQuery('jarvis_restoration_token_9471');
    expect(forgetRes.deletedCount).toBeGreaterThanOrEqual(1);

    const afterForget = searchMemories('jarvis_restoration_token_9471', 5);
    expect(afterForget.length).toBe(0);
  });

  it('performs workspace-confined copy, move, checkpointed delete, and protected organize operations', () => {
    const tempBaseRel = 'data/__test_file_ops__';
    const tempBaseAbs = path.join(config.workspaceRoot, tempBaseRel);
    fs.rmSync(tempBaseAbs, { recursive: true, force: true });
    fs.mkdirSync(tempBaseAbs, { recursive: true });

    try {
      const srcRel = `${tempBaseRel}/notes.txt`;
      const copyRel = `${tempBaseRel}/notes_copy.txt`;
      const movedRel = `${tempBaseRel}/archive/notes_moved.txt`;

      fs.writeFileSync(resolveSafeWorkspacePath(srcRel), 'hello jarvis file ops', 'utf8');

      const copied = copyWorkspaceFile(srcRel, copyRel);
      expect(fs.existsSync(resolveSafeWorkspacePath(copied.to))).toBe(true);

      const moved = moveWorkspaceFile(copyRel, movedRel);
      expect(fs.existsSync(resolveSafeWorkspacePath(moved.to))).toBe(true);
      expect(fs.existsSync(resolveSafeWorkspacePath(copyRel))).toBe(false);

      const org = organizeWorkspaceDirectory(tempBaseRel, { dryRun: false });
      expect(org.movedCount).toBeGreaterThanOrEqual(1);
      expect(org.checkpointId).toBeTruthy();

      const delTarget = org.plannedMoves[0]?.to || srcRel;
      const deleted = deleteWorkspaceFile(delTarget);
      expect(deleted.checkpointId).toBeTruthy();
      expect(fs.existsSync(resolveSafeWorkspacePath(delTarget))).toBe(false);

      // Protect critical source directories from automated organization
      expect(() => organizeWorkspaceDirectory('src', { dryRun: false })).toThrow(/Refusing/i);
    } finally {
      fs.rmSync(tempBaseAbs, { recursive: true, force: true });
    }
  });

  it('executes bounded iterative repair loop with verification pass and auto-rollback on exhaustion', async () => {
    const probeRel = 'server/__temp_repair_probe__.ts';
    const probeAbs = resolveSafeWorkspacePath(probeRel);
    fs.writeFileSync(probeAbs, 'export const badCount: number = "invalid";\n', 'utf8');

    try {
      // Case A: Candidate fix resolves TypeScript failure in 1 iteration
      const repaired = await runIterativeRepairLoop({
        label: 'Repair temp TS probe',
        suite: 'typecheck',
        maxIterations: 2,
        candidateFixes: [[{ path: probeRel, content: 'export const badCount: number = 42;\n' }]],
      });
      expect(repaired.ok).toBe(true);
      expect(repaired.stoppedReason).toBe('verified_clean');
      expect(repaired.iterationsRun).toBe(1);

      // Case B: Break again and exhaust budget -> rolls back to broken pre-repair checkpoint cleanly
      fs.writeFileSync(probeAbs, 'export const badCount: number = "before_repair";\n', 'utf8');
      const rolledBackRun = await runIterativeRepairLoop({
        label: 'Exhausted repair rollback test',
        suite: 'typecheck',
        maxIterations: 1,
        autoRollbackOnFail: true,
        candidateFixes: [
          [{ path: probeRel, content: 'export const badCount: number = "still_broken";\n' }],
        ],
      });
      expect(rolledBackRun.ok).toBe(false);
      expect(rolledBackRun.rolledBack).toBe(true);
      expect(rolledBackRun.stoppedReason).toBe('max_iterations_reached');
      expect(fs.readFileSync(probeAbs, 'utf8')).toContain('before_repair');
    } finally {
      if (fs.existsSync(probeAbs)) fs.unlinkSync(probeAbs);
    }
  }, 60_000);

  it('handles transient Ollama HTTP 503 with bounded retry on /api/ai/test and enforces paired device bearer auth', async () => {
    let chatAttempts = 0;
    const mockOllama = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [{ name: 'qwen2.5:3b', size: 2_000_000_000, details: { quantization_level: 'Q4_K_M' } }],
          })
        );
        return;
      }
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }));
        return;
      }
      if (req.url === '/api/chat') {
        chatAttempts++;
        if (chatAttempts === 1) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Model warming up');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: 'JARVIS inference check OK.' },
            done: true,
            eval_count: 8,
            prompt_eval_count: 14,
          })
        );
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockOllama.listen(0, '127.0.0.1', resolve));
    const mockAddr = mockOllama.address() as { port: number };
    const mockOllamaUrl = `http://127.0.0.1:${mockAddr.port}`;

    saveAISettings({
      inferenceMode: 'local_only',
      preferredProvider: 'ollama',
      preferredModel: 'qwen2.5:3b',
      ollamaUrl: mockOllamaUrl,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const apiServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const apiAddr = apiServer.address() as { port: number };
    const apiBase = `http://127.0.0.1:${apiAddr.port}`;

    try {
      const testRes = await fetch(`${apiBase}/api/ai/test`, { method: 'POST' });
      expect(testRes.status).toBe(200);
      const testBody = await testRes.json();
      expect(testBody.ok).toBe(true);
      expect(testBody.provider).toBe('ollama');
      expect(testBody.reply).toContain('JARVIS inference check OK');
      expect(chatAttempts).toBe(2);

      // Device bearer token verification: valid succeeds, invalid/revoked gets 401
      const paired = pairDevice({
        name: 'Test Companion Pixel',
        platform: 'android',
        deviceType: 'mobile',
        capabilities: ['chat', 'voice'],
      });

      const validRes = await fetch(`${apiBase}/api/health`, {
        headers: {
          Authorization: `Bearer ${paired.pairingToken}`,
          'x-jarvis-device-id': paired.device.id,
        },
      });
      expect(validRes.status).toBe(200);

      const forgedRes = await fetch(`${apiBase}/api/health`, {
        headers: {
          Authorization: 'Bearer jrv_forged_invalid_token',
          'x-jarvis-device-id': paired.device.id,
        },
      });
      expect(forgedRes.status).toBe(401);

      revokeDevice(paired.device.id);
      const revokedRes = await fetch(`${apiBase}/api/health`, {
        headers: {
          Authorization: `Bearer ${paired.pairingToken}`,
          'x-jarvis-device-id': paired.device.id,
        },
      });
      expect(revokedRes.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await new Promise<void>((resolve) => mockOllama.close(() => resolve()));
    }
  }, 30_000);
});
