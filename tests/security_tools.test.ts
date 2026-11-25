import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../server/config/index.js';
import {
  restoreFileCheckpoint,
  writeWorkspaceFileWithCheckpoint,
} from '../server/files/fileService.js';
import {
  redactSecrets,
  resolveSafeWorkspacePath,
  validateExternalUrl,
  validateSafeCommand,
} from '../server/security/guard.js';
import { executeTool, listRegisteredTools, resolveApprovalRequest } from '../server/tools/registry.js';

describe('Security Guard, Path Confinement, SSRF & Tool Registry', () => {
  it('blocks path traversal and .env access outside workspace', () => {
    expect(() => resolveSafeWorkspacePath('../../etc/passwd')).toThrow(/escapes/i);
    expect(() => resolveSafeWorkspacePath('.env')).toThrow(/protected/i);
    const safe = resolveSafeWorkspacePath('package.json');
    expect(safe).toBe(path.join(config.workspaceRoot, 'package.json'));
  });

  it('blocks SSRF attempts targeting localhost, private RFC1918, and cloud metadata IPs', () => {
    expect(() => validateExternalUrl('http://127.0.0.1:3000')).toThrow(/Blocked/i);
    expect(() => validateExternalUrl('http://localhost:11434')).toThrow(/Blocked/i);
    expect(() => validateExternalUrl('http://169.254.169.254/latest/meta-data')).toThrow(/Blocked/i);
    expect(() => validateExternalUrl('http://192.168.1.10/admin')).toThrow(/Blocked/i);
    expect(() => validateExternalUrl('file:///etc/passwd')).toThrow(/Unsupported/i);

    const ok = validateExternalUrl('https://example.com/docs');
    expect(ok.hostname).toBe('example.com');
  });

  it('redacts API keys and bearer tokens from log strings', () => {
    const raw = 'Authorization: Bearer super_secret_token_1234567890 and AIzaSyDummyKey123456789012345';
    const clean = redactSecrets(raw);
    expect(clean).not.toContain('super_secret_token_1234567890');
    expect(clean).not.toContain('AIzaSyDummyKey123456789012345');
  });

  it('blocks unallowlisted binaries and shell metacharacters', () => {
    expect(() => validateSafeCommand('bash', ['-c', 'echo hi'])).toThrow(/not in the authorized/i);
    expect(() => validateSafeCommand('git', ['status;rm -rf /'])).toThrow(/metacharacter/i);
    const safe = validateSafeCommand('git', ['status']);
    expect(safe.risk).toBe('LOW');
  });

  it('creates file checkpoints and restores cleanly on rollback', () => {
    const rel = `data/test-checkpoint-${Date.now()}.txt`;
    const write1 = writeWorkspaceFileWithCheckpoint(rel, 'version-1');
    const full = path.join(config.workspaceRoot, rel);
    expect(fs.readFileSync(full, 'utf8')).toBe('version-1');

    const write2 = writeWorkspaceFileWithCheckpoint(rel, 'version-2');
    expect(fs.readFileSync(full, 'utf8')).toBe('version-2');

    // Restore to write2's checkpoint (which was before version-2 -> version-1)
    restoreFileCheckpoint(write2.checkpointId);
    expect(fs.readFileSync(full, 'utf8')).toBe('version-1');

    // Restore to write1's checkpoint (file didn't exist -> removes file)
    restoreFileCheckpoint(write1.checkpointId);
    expect(fs.existsSync(full)).toBe(false);
  });

  it('enforces approval gates for HIGH risk tools and executes once approved', async () => {
    const tools = listRegisteredTools();
    expect(tools.length).toBeGreaterThanOrEqual(10);

    const unknown = await executeTool('invented_tool_xyz', {});
    expect(unknown.ok).toBe(false);

    const gated = await executeTool('computer_control', { action: 'check_capabilities' });
    expect(gated.status).toBe('waiting_approval');
    expect(gated.approvalId).toBeDefined();

    const approved = await resolveApprovalRequest(gated.approvalId!, 'approved');
    expect(approved.approval.status).toBe('approved');
    expect((approved.execution as any).ok).toBe(true);
  });
});
