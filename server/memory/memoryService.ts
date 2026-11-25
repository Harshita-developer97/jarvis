import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/db.js';
import { containsSensitiveCredential, redactSecrets } from '../security/guard.js';
import type { MemoryCategory } from '../types.js';

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  source: string;
  context: string | null;
  importance: number;
  confidence: number;
  tags: string[];
  contradictsId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function storeMemory(input: {
  category: MemoryCategory;
  title: string;
  content: string;
  source: string;
  context?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  expiresAt?: string | null;
}): { stored: boolean; deduplicated: boolean; rejectedReason?: string; item?: MemoryItem } {
  if (!input.content || input.content.trim().length < 4) {
    return { stored: false, deduplicated: false, rejectedReason: 'Content too short' };
  }

  if (containsSensitiveCredential(input.content) || containsSensitiveCredential(input.title)) {
    return {
      stored: false,
      deduplicated: false,
      rejectedReason: 'Refused to store potential credential or API secret in memory',
    };
  }

  const db = getDb();
  const cleanTitle = redactSecrets(input.title.trim()).slice(0, 180);
  const cleanContent = redactSecrets(input.content.trim()).slice(0, 4000);
  const cleanContext = input.context ? redactSecrets(input.context.trim()).slice(0, 500) : null;
  const now = new Date().toISOString();

  // Deduplication check against recent memories in same category
  const existing = db
    .prepare(
      'SELECT id, title, content, importance FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT 40'
    )
    .all(input.category) as Array<{
    id: string;
    title: string;
    content: string;
    importance: number;
  }>;

  for (const row of existing) {
    const sim = jaccardSimilarity(`${row.title} ${row.content}`, `${cleanTitle} ${cleanContent}`);
    if (sim >= 0.85) {
      // Update timestamp & boost importance slightly rather than creating duplicate
      const nextImportance = Math.min(1, Math.max(row.importance, input.importance ?? 0.5) + 0.05);
      db.prepare('UPDATE memories SET updated_at = ?, importance = ? WHERE id = ?').run(
        now,
        nextImportance,
        row.id
      );
      return {
        stored: true,
        deduplicated: true,
        item: getMemoryById(row.id) || undefined,
      };
    }
  }

  // Contradiction detection (same subject tokens with negation or differing preference)
  let contradictsId: string | null = null;
  if (input.category === 'preference' || input.category === 'instruction' || input.category === 'fact') {
    for (const row of existing) {
      const sim = jaccardSimilarity(row.title, cleanTitle);
      if (sim >= 0.65 && row.content !== cleanContent) {
        contradictsId = row.id;
        break;
      }
    }
  }

  const id = crypto.randomUUID();
  const importance = Math.min(1, Math.max(0, input.importance ?? 0.6));
  const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.85));
  const tagsJson = JSON.stringify(input.tags || []);

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO memories
        (id, category, title, content, source, context, importance, confidence, tags_json, contradicts_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.category,
      cleanTitle,
      cleanContent,
      input.source,
      cleanContext,
      importance,
      confidence,
      tagsJson,
      contradictsId,
      input.expiresAt || null,
      now,
      now
    );

    db.prepare(
      'INSERT INTO memory_fts (memory_id, title, content, context, category) VALUES (?, ?, ?, ?, ?)'
    ).run(id, cleanTitle, cleanContent, cleanContext || '', input.category);
  });

  return { stored: true, deduplicated: false, item: getMemoryById(id) || undefined };
}

function mapMemoryRow(row: Record<string, unknown>): MemoryItem {
  return {
    id: String(row.id),
    category: row.category as MemoryCategory,
    title: String(row.title),
    content: String(row.content),
    source: String(row.source),
    context: row.context ? String(row.context) : null,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    tags: JSON.parse(String(row.tags_json || '[]')),
    contradictsId: row.contradicts_id ? String(row.contradicts_id) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getMemoryById(id: string): MemoryItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapMemoryRow(row) : null;
}

export function listMemories(options?: {
  category?: string;
  limit?: number;
}): MemoryItem[] {
  const db = getDb();
  purgeExpiredMemories();
  const limit = Math.min(Math.max(1, options?.limit ?? 100), 500);
  if (options?.category && options.category !== 'all') {
    const rows = db
      .prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?')
      .all(options.category, limit) as Array<Record<string, unknown>>;
    return rows.map(mapMemoryRow);
  }
  const rows = db
    .prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapMemoryRow);
}

export function searchMemories(query: string, limit = 8): MemoryItem[] {
  const db = getDb();
  purgeExpiredMemories();
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return listMemories({ limit });
  }

  // 1. FTS5 keyword matches
  const ftsQuery = tokens.slice(0, 8).map((t) => `${t}*`).join(' OR ');
  const ftsIds = new Set<string>();
  try {
    const ftsRows = db
      .prepare('SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT 30')
      .all(ftsQuery) as Array<{ memory_id: string }>;
    for (const r of ftsRows) ftsIds.add(r.memory_id);
  } catch {
    // fallback if FTS query syntax had edge characters
  }

  // 2. Semantic / lexical similarity + recency + importance ranking across recent pool
  const candidates = db
    .prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 200')
    .all() as Array<Record<string, unknown>>;

  const nowMs = Date.now();
  const scored = candidates.map((row) => {
    const item = mapMemoryRow(row);
    const sim = jaccardSimilarity(query, `${item.title} ${item.content} ${item.context || ''}`);
    const ftsBoost = ftsIds.has(item.id) ? 0.35 : 0;
    const ageDays = Math.max(0, (nowMs - Date.parse(item.updatedAt)) / 86_400_000);
    const recency = Math.exp(-ageDays / 30) * 0.15;
    const score = sim * 0.55 + ftsBoost + item.importance * 0.2 + recency;
    return { ...item, score: Math.round(score * 1000) / 1000 };
  });

  return scored
    .filter((m) => (m.score || 0) > 0.12 || ftsIds.has(m.id))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
}

export function updateMemory(
  id: string,
  patch: { title?: string; content?: string; category?: MemoryCategory; importance?: number }
): MemoryItem | null {
  const existing = getMemoryById(id);
  if (!existing) return null;

  const nextTitle = patch.title ? redactSecrets(patch.title.trim()) : existing.title;
  const nextContent = patch.content ? redactSecrets(patch.content.trim()) : existing.content;
  if (containsSensitiveCredential(nextContent) || containsSensitiveCredential(nextTitle)) {
    throw new Error('Cannot store credentials in memory');
  }
  const nextCat = patch.category || existing.category;
  const nextImp = patch.importance ?? existing.importance;
  const now = new Date().toISOString();

  const db = getDb();
  withTransaction(db, () => {
    db.prepare(
      'UPDATE memories SET title = ?, content = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?'
    ).run(nextTitle, nextContent, nextCat, nextImp, now, id);
    db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
    db.prepare(
      'INSERT INTO memory_fts (memory_id, title, content, context, category) VALUES (?, ?, ?, ?, ?)'
    ).run(id, nextTitle, nextContent, existing.context || '', nextCat);
  });

  return getMemoryById(id);
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  return withTransaction(db, () => {
    db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
    const res = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  });
}

export function purgeExpiredMemories(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db
    .prepare('SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?')
    .all(now) as Array<{ id: string }>;
  if (expired.length === 0) return 0;

  return withTransaction(db, () => {
    for (const row of expired) {
      db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(row.id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
    }
    return expired.length;
  });
}

export function extractAndStoreConversationInsights(
  userMessage: string,
  conversationId: string
): MemoryItem[] {
  const saved: MemoryItem[] = [];
  const lower = userMessage.toLowerCase();

  // Explicit user instructions / preferences ("remember that...", "meri preference...", "always...")
  const triggers = [
    /(?:remember\s+that|yaad\s+rakhna|note\s+that|always\s+use|my\s+preference\s+is|prefer\s+to)\s+(.{8,300})/i,
    /(?:i\s+am\s+building|my\s+project\s+is|we\s+are\s+working\s+on|mera\s+project)\s+(.{8,300})/i,
  ];

  for (const regex of triggers) {
    const match = userMessage.match(regex);
    if (match && match[1]) {
      const category: MemoryCategory = lower.includes('project')
        ? 'project'
        : lower.includes('prefer')
        ? 'preference'
        : 'instruction';
      const res = storeMemory({
        category,
        title: match[1].slice(0, 72),
        content: match[1].trim(),
        source: `conversation:${conversationId}`,
        context: 'Auto-extracted from user instruction',
        importance: 0.85,
      });
      if (res.stored && res.item) saved.push(res.item);
    }
  }
  return saved;
}
