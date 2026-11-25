import fs from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(
  process.env.JARVIS_WORKSPACE_ROOT && process.env.JARVIS_WORKSPACE_ROOT.trim().length > 0
    ? process.env.JARVIS_WORKSPACE_ROOT
    : process.cwd()
);

const dataDir = path.join(workspaceRoot, 'data');
const backupsDir = path.join(dataDir, 'backups');
const checkpointsDir = path.join(dataDir, 'checkpoints');

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  workspaceRoot,
  dataDir,
  dbPath: path.join(dataDir, 'jarvis.db'),
  backupsDir,
  checkpointsDir,
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  llamacppBaseUrl: (process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  resourceLimits: {
    targetSystemRamGb: 8,
    elevatedRamPercent: 78,
    criticalRamPercent: 90,
    elevatedCpuPercent: 80,
    maxConcurrentHeavyTasks: 1,
    defaultToolTimeoutMs: 20_000,
    maxFileReadBytes: 512 * 1024,
  },
};

export function ensureRuntimeDirectories(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupsDir, { recursive: true });
  fs.mkdirSync(config.checkpointsDir, { recursive: true });
}
