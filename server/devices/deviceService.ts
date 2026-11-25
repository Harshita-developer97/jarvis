import crypto from 'node:crypto';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';
import { generateSecureToken, hashSecret, verifySecret } from '../security/guard.js';

export interface PairedDevice {
  id: string;
  name: string;
  platform: 'windows' | 'android' | 'linux' | 'macos' | 'web';
  deviceType: 'desktop' | 'mobile' | 'tablet';
  capabilities: string[];
  status: 'paired' | 'offline' | 'revoked';
  lastSeenAt: string;
  createdAt: string;
}

export function pairDevice(input: {
  name: string;
  platform: PairedDevice['platform'];
  deviceType: PairedDevice['deviceType'];
  capabilities: string[];
}): { device: PairedDevice; pairingToken: string } {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const pairingToken = `jrv_${generateSecureToken(20)}`;
  const tokenHash = hashSecret(pairingToken);

  db.prepare(
    `INSERT INTO devices (id, name, platform, device_type, capabilities_json, status, token_hash, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'paired', ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.platform,
    input.deviceType,
    JSON.stringify(input.capabilities),
    tokenHash,
    now,
    now
  );

  logAudit('security', 'device_architecture', 'device_paired', {
    id,
    name: input.name,
    platform: input.platform,
  });

  return {
    device: {
      id,
      name: input.name,
      platform: input.platform,
      deviceType: input.deviceType,
      capabilities: input.capabilities,
      status: 'paired',
      lastSeenAt: now,
      createdAt: now,
    },
    pairingToken,
  };
}

export function listPairedDevices(): PairedDevice[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    platform: r.platform as PairedDevice['platform'],
    deviceType: r.device_type as PairedDevice['deviceType'],
    capabilities: JSON.parse(String(r.capabilities_json || '[]')),
    status: r.status as PairedDevice['status'],
    lastSeenAt: String(r.last_seen_at),
    createdAt: String(r.created_at),
  }));
}

export function verifyDeviceToken(deviceId: string, token: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT token_hash, status FROM devices WHERE id = ?')
    .get(deviceId) as { token_hash: string; status: string } | undefined;
  if (!row || row.status !== 'paired') return false;
  const ok = verifySecret(token, row.token_hash);
  if (ok) {
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      deviceId
    );
  }
  return ok;
}

export function revokeDevice(deviceId: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`)
    .run(deviceId);
  if (Number(res.changes) > 0) {
    logAudit('security', 'device_architecture', 'device_revoked', { deviceId });
    return true;
  }
  return false;
}
