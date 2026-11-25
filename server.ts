import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverInterruptedTasks, seedAgents } from './server/agents/orchestrator.js';
import { startAutomationScheduler, stopAutomationScheduler } from './server/automation/automationService.js';
import { config, ensureRuntimeDirectories } from './server/config/index.js';
import { getDb } from './server/database/db.js';
import { eventBus } from './server/events/eventBus.js';
import { logAudit } from './server/logging/logger.js';
import { collectSystemTelemetry } from './server/monitoring/systemMonitor.js';
import { createApiRouter } from './server/routes/api.js';
import { initializeToolRegistry } from './server/tools/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createJarvisServer() {
  ensureRuntimeDirectories();
  getDb();
  seedAgents();
  initializeToolRegistry();
  recoverInterruptedTasks();
  startAutomationScheduler();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', createApiRouter());

  // Periodic real telemetry broadcast over SSE
  const telemetryInterval = setInterval(async () => {
    try {
      const telemetry = await collectSystemTelemetry(false);
      eventBus.emitEvent('telemetry', telemetry);
    } catch {
      // ignore background tick error
    }
  }, 5000);

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  return { app, telemetryInterval };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  createJarvisServer()
    .then(({ app, telemetryInterval }) => {
      const server = app.listen(config.port, config.host, () => {
        logAudit('info', 'server', 'started', {
          host: config.host,
          port: config.port,
          workspaceRoot: config.workspaceRoot,
        });
        console.log(`JARVIS OS backend + UI listening on http://${config.host}:${config.port}`);
      });

      const shutdown = () => {
        clearInterval(telemetryInterval);
        stopAutomationScheduler();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('Failed to start JARVIS server:', err);
      process.exit(1);
    });
}
