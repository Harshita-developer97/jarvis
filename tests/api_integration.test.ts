import express from 'express';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../server/database/db.js';
import { createApiRouter } from '../server/routes/api.js';
import { initializeToolRegistry } from '../server/tools/registry.js';

describe('JARVIS Express API Integration', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    getDb();
    initializeToolRegistry();
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns real hardware telemetry and DB integrity from /api/health', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database.ok).toBe(true);
    expect(body.telemetry.memory.totalBytes).toBeGreaterThan(0);
    expect(body.telemetry.cpu.cores).toBeGreaterThan(0);
  });

  it('handles Hinglish diagnostic chat via real sys_diagnostics tool', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Jarvis, mera laptop slow kyu chal raha hai?' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userMessage.intent).toBe('diagnostics');
    expect(body.assistantMessage.toolCalls[0].toolId).toBe('sys_diagnostics');
    expect(body.assistantMessage.content.length).toBeGreaterThan(20);
  });

  it('validates API inputs and rejects malformed payloads with HTTP 400', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns setup inspection details for first-run wizard', async () => {
    const res = await fetch(`${baseUrl}/api/setup/inspect`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recommendedModel).toBeDefined();
    expect(Array.isArray(body.missingDependencies)).toBe(true);
  });

  it('defaults inferenceMode to local_only and exposes engineering/desktop probes truthfully', async () => {
    const aiRes = await fetch(`${baseUrl}/api/ai/status`);
    expect(aiRes.status).toBe(200);
    const aiBody = await aiRes.json();
    expect(aiBody.inferenceMode).toBe('local_only');

    const envRes = await fetch(`${baseUrl}/api/engineering/environment`);
    expect(envRes.status).toBe(200);
    const envBody = await envRes.json();
    expect(envBody.vitestAvailable).toBe(true);
    expect(envBody.typescriptAvailable).toBe(true);

    const deskRes = await fetch(`${baseUrl}/api/desktop/capabilities`);
    expect(deskRes.status).toBe(200);
    const deskBody = await deskRes.json();
    expect(deskBody.platform).toBe(process.platform);
  });
});
