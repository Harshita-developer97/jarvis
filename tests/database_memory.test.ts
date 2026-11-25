import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDatabaseIntegrity,
  closeDb,
  createDatabaseBackup,
  getDb,
} from '../server/database/db.js';
import {
  deleteMemory,
  searchMemories,
  storeMemory,
  updateMemory,
} from '../server/memory/memoryService.js';

describe('Database & Persistent Memory Engine', () => {
  beforeAll(() => {
    getDb();
  });

  afterAll(() => {
    closeDb();
  });

  it('passes SQLite PRAGMA integrity_check and applies migrations', () => {
    const check = checkDatabaseIntegrity();
    expect(check.ok).toBe(true);
    expect(check.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('creates a valid SQLite backup file using VACUUM INTO', () => {
    const backup = createDatabaseBackup();
    expect(fs.existsSync(backup.path)).toBe(true);
    expect(backup.sizeBytes).toBeGreaterThan(1024);
    fs.unlinkSync(backup.path);
  });

  it('refuses to store credentials or API keys in memory', () => {
    const res = storeMemory({
      category: 'fact',
      title: 'My leaked key',
      content: 'Use sk-1234567890abcdef1234567890abcdef for auth',
      source: 'test',
    });
    expect(res.stored).toBe(false);
    expect(res.rejectedReason).toMatch(/credential|secret/i);
  });

  it('stores, searches via FTS5, deduplicates, updates, and deletes memory', () => {
    const uniqueTag = `vitest_${Date.now()}`;
    const first = storeMemory({
      category: 'technical',
      title: `SQLite WAL mode ${uniqueTag}`,
      content: `Enable WAL journal mode in SQLite for concurrent reads ${uniqueTag}`,
      source: 'vitest',
      importance: 0.8,
    });
    expect(first.stored).toBe(true);
    expect(first.deduplicated).toBe(false);
    expect(first.item?.id).toBeDefined();

    // Duplicate check
    const dup = storeMemory({
      category: 'technical',
      title: `SQLite WAL mode ${uniqueTag}`,
      content: `Enable WAL journal mode in SQLite for concurrent reads ${uniqueTag}`,
      source: 'vitest',
    });
    expect(dup.stored).toBe(true);
    expect(dup.deduplicated).toBe(true);

    const found = searchMemories(uniqueTag, 5);
    expect(found.some((m) => m.id === first.item?.id)).toBe(true);

    const updated = updateMemory(first.item!.id, {
      content: `Updated WAL note ${uniqueTag}`,
    });
    expect(updated?.content).toContain('Updated WAL note');

    const deleted = deleteMemory(first.item!.id);
    expect(deleted).toBe(true);
  });

  it('detects contradictions in preference memories', () => {
    const tag = `theme_${Date.now()}`;
    const m1 = storeMemory({
      category: 'preference',
      title: `Editor color preference ${tag}`,
      content: 'Always use light theme',
      source: 'test',
    });
    const m2 = storeMemory({
      category: 'preference',
      title: `Editor color preference ${tag}`,
      content: 'Always use dark theme instead',
      source: 'test',
    });
    expect(m2.item?.contradictsId).toBe(m1.item?.id);
    if (m1.item) deleteMemory(m1.item.id);
    if (m2.item) deleteMemory(m2.item.id);
  });
});
