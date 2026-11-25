import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import { resolveSafeWorkspacePath } from '../security/guard.js';

export interface FileEntryInfo {
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  isDirectory: boolean;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  'data',
]);

export function searchWorkspaceFiles(options?: {
  query?: string;
  subDir?: string;
  maxResults?: number;
}): FileEntryInfo[] {
  const baseDir = options?.subDir
    ? resolveSafeWorkspacePath(options.subDir)
    : config.workspaceRoot;
  const maxResults = Math.min(options?.maxResults ?? 200, 500);
  const query = options?.query?.toLowerCase().trim() || '';
  const results: FileEntryInfo[] = [];

  function walk(dir: string): void {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.env')) continue;

      const full = path.join(dir, entry.name);
      const rel = path.relative(config.workspaceRoot, full).replace(/\\/g, '/');
      const matches = !query || rel.toLowerCase().includes(query);

      if (entry.isDirectory()) {
        if (matches) {
          results.push({
            relativePath: rel,
            name: entry.name,
            extension: '',
            sizeBytes: 0,
            modifiedAt: fs.statSync(full).mtime.toISOString(),
            isDirectory: true,
          });
        }
        walk(full);
      } else if (entry.isFile() && matches) {
        const stat = fs.statSync(full);
        results.push({
          relativePath: rel,
          name: entry.name,
          extension: path.extname(entry.name).toLowerCase(),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isDirectory: false,
        });
      }
    }
  }

  walk(baseDir);
  return results;
}

export function readAndParseWorkspaceFile(relPath: string): {
  relativePath: string;
  format: string;
  sizeBytes: number;
  content: string;
  parsedSummary?: Record<string, unknown>;
} {
  const resolved = resolveSafeWorkspacePath(relPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${relPath}`);
  }
  if (stat.size > config.resourceLimits.maxFileReadBytes) {
    throw new Error(
      `File size (${stat.size} bytes) exceeds safe read limit (${config.resourceLimits.maxFileReadBytes} bytes)`
    );
  }

  const ext = path.extname(resolved).toLowerCase();
  const content = fs.readFileSync(resolved, 'utf8');
  let parsedSummary: Record<string, unknown> | undefined;

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content);
      parsedSummary = {
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
        keys: typeof parsed === 'object' && parsed && !Array.isArray(parsed) ? Object.keys(parsed) : undefined,
        length: Array.isArray(parsed) ? parsed.length : undefined,
      };
    } catch {
      parsedSummary = { parseError: 'Invalid JSON syntax' };
    }
  } else if (ext === '.csv') {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const headers = lines[0]?.split(',').map((h) => h.trim()) || [];
    parsedSummary = { rowCount: Math.max(0, lines.length - 1), headers };
  }

  return {
    relativePath: path.relative(config.workspaceRoot, resolved).replace(/\\/g, '/'),
    format: ext.replace('.', '') || 'text',
    sizeBytes: stat.size,
    content,
    parsedSummary,
  };
}

export function createFileCheckpoint(paths: string[], label: string, taskId?: string): string {
  const snapshot: Array<{ relativePath: string; existed: boolean; content: string | null }> = [];
  for (const p of paths) {
    const resolved = resolveSafeWorkspacePath(p);
    const rel = path.relative(config.workspaceRoot, resolved).replace(/\\/g, '/');
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      snapshot.push({
        relativePath: rel,
        existed: true,
        content: fs.readFileSync(resolved, 'utf8'),
      });
    } else {
      snapshot.push({
        relativePath: rel,
        existed: false,
        content: null,
      });
    }
  }

  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare(
    'INSERT INTO checkpoints (id, task_id, label, files_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, taskId || null, label, JSON.stringify(snapshot), new Date().toISOString());
  return id;
}

export function restoreFileCheckpoint(checkpointId: string): {
  restoredFiles: string[];
  removedFiles: string[];
} {
  const db = getDb();
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId) as
    | { files_snapshot_json: string }
    | undefined;
  if (!row) {
    throw new Error(`Checkpoint ${checkpointId} not found`);
  }

  const snapshot = JSON.parse(row.files_snapshot_json) as Array<{
    relativePath: string;
    existed: boolean;
    content: string | null;
  }>;

  const restoredFiles: string[] = [];
  const removedFiles: string[] = [];

  for (const item of snapshot) {
    const resolved = resolveSafeWorkspacePath(item.relativePath);
    if (item.existed && item.content !== null) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, item.content, 'utf8');
      restoredFiles.push(item.relativePath);
    } else if (!item.existed && fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
      removedFiles.push(item.relativePath);
    }
  }

  db.prepare('UPDATE checkpoints SET restored_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    checkpointId
  );

  return { restoredFiles, removedFiles };
}

export function writeWorkspaceFileWithCheckpoint(
  relPath: string,
  content: string,
  taskId?: string
): { relativePath: string; checkpointId: string; bytesWritten: number } {
  const resolved = resolveSafeWorkspacePath(relPath);
  const rel = path.relative(config.workspaceRoot, resolved).replace(/\\/g, '/');
  const checkpointId = createFileCheckpoint([rel], `Before writing ${rel}`, taskId);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');

  return {
    relativePath: rel,
    checkpointId,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
  };
}

export function findDuplicateFiles(subDir?: string): Array<{
  hash: string;
  sizeBytes: number;
  files: string[];
}> {
  const files = searchWorkspaceFiles({ subDir, maxResults: 300 }).filter((f) => !f.isDirectory);
  const bySize = new Map<number, FileEntryInfo[]>();
  for (const f of files) {
    if (f.sizeBytes === 0 || f.sizeBytes > config.resourceLimits.maxFileReadBytes) continue;
    const arr = bySize.get(f.sizeBytes) || [];
    arr.push(f);
    bySize.set(f.sizeBytes, arr);
  }

  const byHash = new Map<string, { sizeBytes: number; files: string[] }>();
  for (const [sizeBytes, group] of bySize.entries()) {
    if (group.length < 2) continue;
    for (const file of group) {
      const resolved = resolveSafeWorkspacePath(file.relativePath);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
      const existing = byHash.get(hash) || { sizeBytes, files: [] };
      existing.files.push(file.relativePath);
      byHash.set(hash, existing);
    }
  }

  return Array.from(byHash.entries())
    .filter(([, g]) => g.files.length > 1)
    .map(([hash, g]) => ({ hash, sizeBytes: g.sizeBytes, files: g.files }));
}
