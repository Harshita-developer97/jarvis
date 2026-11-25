import express from 'express';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSavedAISettings, runAIInference, saveAISettings } from '../server/ai/engine.js';
import { config } from '../server/config/index.js';
import { getDb } from '../server/database/db.js';
import { createApiRouter } from '../server/routes/api.js';
import { initializeToolRegistry } from '../server/tools/registry.js';

describe('JARVIS Ollama + qwen2.5:3b End-to-End Pipeline (Loopback Verification)', () => {
  let ollamaServer: http.Server;
  let ollamaUrl = '';
  let apiServer: http.Server;
  let apiBaseUrl = '';
  let simulatedDelayMs = 0;
  let dropNextChatConnection = false;
  let simulateColdStartUnloaded = false;
  const createdConversationIds: string[] = [];
  const capturedPayloads: Array<{ model: string; messages: any[]; options: any; keep_alive: string }> = [];

  beforeAll(async () => {
    // 1. Start a loopback HTTP server implementing Ollama's exact /api/tags, /api/ps, and /api/chat protocol
    ollamaServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'qwen2.5:3b',
                size: 1929903288,
                details: { quantization_level: 'Q4_K_M', parameter_size: '3.1B' },
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/api/ps') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: simulateColdStartUnloaded ? [] : [{ name: 'qwen2.5:3b' }],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          if (dropNextChatConnection) {
            dropNextChatConnection = false;
            req.socket.destroy();
            return;
          }
          const parsed = JSON.parse(raw || '{}');
          capturedPayloads.push(parsed);
          const lastUser = [...(parsed.messages || [])].reverse().find((m: any) => m.role === 'user');
          const turnCount = (parsed.messages || []).filter((m: any) => m.role === 'user').length;
          const respond = () => {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                model: parsed.model,
                message: {
                  role: 'assistant',
                  content: `qwen2.5:3b verified reply (turn ${turnCount}): ${String(lastUser?.content || '').slice(0, 60)}`,
                },
                done: true,
                eval_count: 18,
                prompt_eval_count: 140,
              })
            );
          };
          if (simulatedDelayMs > 0) {
            setTimeout(respond, simulatedDelayMs);
          } else {
            respond();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      ollamaServer.listen(0, '127.0.0.1', () => {
        const addr = ollamaServer.address() as { port: number };
        ollamaUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    getDb();
    initializeToolRegistry();
    saveAISettings({
      inferenceMode: 'local_only',
      preferredProvider: 'ollama',
      preferredModel: 'qwen2.5:3b',
      allowCloudFallback: false,
      ollamaUrl,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    await new Promise<void>((resolve) => {
      apiServer = app.listen(0, '127.0.0.1', () => {
        const addr = apiServer.address() as { port: number };
        apiBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    saveAISettings({
      inferenceMode: 'local_only',
      preferredProvider: 'ollama',
      preferredModel: 'qwen2.5:3b',
      allowCloudFallback: false,
      ollamaUrl: 'http://127.0.0.1:11434',
    });

    const db = getDb();
    for (const cid of createdConversationIds) {
      db.prepare('DELETE FROM conversations WHERE id = ?').run(cid);
    }

    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    if (ollamaServer.listening) {
      await new Promise<void>((resolve) => ollamaServer.close(() => resolve()));
    }
  });

  it('enforces local-first Ollama defaults and >=120s cold-start inference timeout', () => {
    expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(config.ollamaDefaultModel).toBe('qwen2.5:3b');
    expect(config.ollamaInferenceTimeoutMs).toBeGreaterThanOrEqual(120_000);
    const saved = getSavedAISettings();
    expect(saved.inferenceMode).toBe('local_only');
    expect(saved.preferredProvider).toBe('ollama');
    expect(saved.preferredModel).toBe('qwen2.5:3b');
  });

  it('connects to Ollama qwen2.5:3b in local_only mode and executes multi-turn chat with system & agent context', async () => {
    const statusRes = await fetch(`${apiBaseUrl}/api/ai/status`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.available).toBe(true);
    expect(status.activeProvider).toBe('ollama');
    expect(status.activeModel).toBe('qwen2.5:3b');
    expect(status.inferenceMode).toBe('local_only');

    // Turn 1 (English)
    const turn1Res = await fetch(`${apiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello JARVIS, confirm local readiness.' }),
    });
    expect(turn1Res.status).toBe(200);
    const turn1 = await turn1Res.json();
    createdConversationIds.push(turn1.conversation.id);

    expect(turn1.provider).toBe('ollama');
    expect(turn1.assistantMessage.modelUsed).toBe('qwen2.5:3b');
    expect(turn1.assistantMessage.content).toContain('qwen2.5:3b verified reply (turn 1)');
    expect(turn1.inferenceError).toBeNull();
    expect(typeof turn1.latencyMs).toBe('number');

    // Turn 2 (Hinglish follow-up in same SQLite conversation)
    const turn2Res = await fetch(`${apiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: turn1.conversation.id,
        content: 'Jarvis, mera laptop slow kyu chal raha hai?',
      }),
    });
    expect(turn2Res.status).toBe(200);
    const turn2 = await turn2Res.json();
    expect(turn2.provider).toBe('ollama');
    expect(turn2.assistantMessage.modelUsed).toBe('qwen2.5:3b');
    expect(turn2.assistantMessage.content).toContain('turn 2');

    // Verify system prompt, orchestration context, 8GB RAM options, and multi-turn history reached Ollama
    const lastReq = capturedPayloads[capturedPayloads.length - 1];
    expect(lastReq.model).toBe('qwen2.5:3b');
    expect(lastReq.keep_alive).toBe('5m');
    expect(lastReq.options.num_ctx).toBe(2048);
    expect(lastReq.options.num_predict).toBe(512);
    expect(lastReq.messages[0].role).toBe('system');
    expect(lastReq.messages[0].content).toContain('[AGENT ORCHESTRATION]');
    expect(lastReq.messages[0].content).toContain('[REAL SYSTEM TELEMETRY]');
    expect(lastReq.messages[0].content).toContain('Hinglish');

    // Verify SQLite persisted all 4 messages cleanly
    const histRes = await fetch(`${apiBaseUrl}/api/conversations/${turn1.conversation.id}/messages`);
    const hist = await histRes.json();
    expect(hist.messages.length).toBe(4);
  });

  it('completes cold-start model loading without premature abort', async () => {
    simulateColdStartUnloaded = true;
    simulatedDelayMs = 250;
    try {
      const res = await fetch(`${apiBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Cold start model readiness check' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      createdConversationIds.push(body.conversation.id);

      expect(body.provider).toBe('ollama');
      expect(body.inferenceError).toBeNull();
      expect(body.assistantMessage.modelUsed).toBe('qwen2.5:3b');
      expect(body.assistantMessage.content).toContain('qwen2.5:3b verified reply');
    } finally {
      simulateColdStartUnloaded = false;
      simulatedDelayMs = 0;
    }
  }, 15_000);

  it('distinguishes timeout cancellation from user abort and connection failure', async () => {
    // 1. Timeout cancellation
    simulatedDelayMs = 350;
    try {
      const timeoutRes = await runAIInference([{ role: 'user', content: 'Slow query' }], {
        timeoutMs: 60,
      });
      expect(timeoutRes.available).toBe(false);
      expect(timeoutRes.errorType).toBe('timeout');
      expect(timeoutRes.error).toContain('timed out');
      expect(timeoutRes.error).not.toContain('This operation was aborted');
    } finally {
      simulatedDelayMs = 0;
    }

    // 2. User cancellation via AbortController (in-flight via /api/chat/interrupt)
    simulatedDelayMs = 400;
    try {
      const chatPromise = fetch(`${apiBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Interruptible user request' }),
      });
      await new Promise((r) => setTimeout(r, 60));
      const intRes = await fetch(`${apiBaseUrl}/api/chat/interrupt`, { method: 'POST' });
      expect(intRes.status).toBe(200);
      const intBody = await intRes.json();
      expect(intBody.aborted).toBeGreaterThanOrEqual(1);

      const chatRes = await chatPromise;
      const chatBody = await chatRes.json();
      createdConversationIds.push(chatBody.conversation.id);
      expect(chatBody.inferenceError).toContain('cancelled by user');
      expect(chatBody.assistantMessage.modelUsed).toContain('cancelled');
    } finally {
      simulatedDelayMs = 0;
    }

    // 3. Direct pre-aborted AbortSignal
    const preAborted = new AbortController();
    preAborted.abort();
    const abortedRes = await runAIInference([{ role: 'user', content: 'Already cancelled' }], {
      signal: preAborted.signal,
    });
    expect(abortedRes.available).toBe(false);
    expect(abortedRes.errorType).toBe('aborted');
    expect(abortedRes.error).toContain('cancelled by user');

    // 4. Mid-request connection drop
    dropNextChatConnection = true;
    const connRes = await runAIInference([{ role: 'user', content: 'Dropped connection probe' }]);
    expect(connRes.available).toBe(false);
    expect(connRes.errorType).toBe('connection');
    expect(connRes.error).toContain('connection failed');
  });

  it('handles Ollama shutdown cleanly without silent Gemini fallback', async () => {
    await new Promise<void>((resolve) => ollamaServer.close(() => resolve()));

    const res = await fetch(`${apiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Are you still running locally?' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    createdConversationIds.push(body.conversation.id);

    expect(body.provider).toBe('none');
    expect(body.assistantMessage.modelUsed).toContain('local_only');
    expect(body.inferenceError).toContain('Ollama');
    expect(getSavedAISettings().inferenceMode).toBe('local_only');
  });
});
