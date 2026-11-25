import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { getDb } from '../database/db.js';
import { logAudit } from '../logging/logger.js';
import type { LanguageMode, VoiceDeviceInfo } from '../types.js';

const execFileAsync = promisify(execFile);

export interface VoiceConfig {
  enabled: boolean;
  wakeWord: string;
  continuousListening: boolean;
  language: LanguageMode;
  speechRate: number;
  voiceName: string;
  inputDeviceId: string;
  outputDeviceId: string;
  vadThreshold: number;
  interruptible: boolean;
  silenceTimeoutMs: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export interface VoiceSubsystemStatus {
  config: VoiceConfig;
  backendCapabilities: {
    whisperAvailable: boolean;
    piperAvailable: boolean;
    espeakAvailable: boolean;
    windowsSapiAvailable: boolean;
    arecordAvailable: boolean;
    osDevices: VoiceDeviceInfo[];
    browserSpeechSupportedNote: string;
  };
  setupGuidance: string[];
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: true,
  wakeWord: 'JARVIS',
  continuousListening: false,
  language: 'auto',
  speechRate: 1.0,
  voiceName: 'default',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  vadThreshold: 12,
  interruptible: true,
  silenceTimeoutMs: 1800,
  quietHoursEnabled: false,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
};

async function hasBinary(cmd: string): Promise<boolean> {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(checker, [cmd], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

export function getVoiceConfig(): VoiceConfig {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get('voice_config') as { value_json: string } | undefined;
  if (!row) return { ...DEFAULT_VOICE_CONFIG };
  try {
    return { ...DEFAULT_VOICE_CONFIG, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
}

export function updateVoiceConfig(patch: Partial<VoiceConfig>): VoiceConfig {
  const next = { ...getVoiceConfig(), ...patch };
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run('voice_config', JSON.stringify(next), new Date().toISOString());
  return next;
}

async function detectOsAudioDevices(): Promise<VoiceDeviceInfo[]> {
  const devices: VoiceDeviceInfo[] = [];
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_SoundDevice | Select-Object DeviceID,Name | ConvertTo-Json -Compress',
        ],
        { timeout: 3500 }
      );
      const parsed = JSON.parse(stdout || '[]');
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item?.Name) {
          devices.push({
            id: String(item.DeviceID || item.Name),
            name: String(item.Name),
            kind: 'audiooutput',
            source: 'os',
          });
        }
      }
    } catch {
      // ignore if CIM unavailable
    }
    return devices;
  }

  // Linux ALSA inspection if available
  try {
    const { stdout } = await execFileAsync('arecord', ['-l'], { timeout: 2000 });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('card ')) {
        devices.push({
          id: line.slice(0, 24),
          name: line.trim(),
          kind: 'audioinput',
          source: 'os',
        });
      }
    }
  } catch {
    // No ALSA capture hardware in container
  }
  return devices;
}

export async function getVoiceSubsystemStatus(): Promise<VoiceSubsystemStatus> {
  const [whisper, fasterWhisper, piper, espeak, arecord, osDevices] = await Promise.all([
    hasBinary('whisper'),
    hasBinary('faster-whisper'),
    hasBinary('piper'),
    hasBinary('espeak-ng').then((v) => v || hasBinary('espeak')),
    hasBinary('arecord'),
    detectOsAudioDevices(),
  ]);

  const windowsSapiAvailable = process.platform === 'win32';
  const guidance: string[] = [];
  if (!whisper && !fasterWhisper) {
    guidance.push(
      'Local backend STT (whisper.cpp / faster-whisper) is not installed on this host. Browser SpeechRecognition + AudioContext VAD are active when a microphone is attached.'
    );
  }
  if (!piper && !espeak && !windowsSapiAvailable) {
    guidance.push(
      'Local backend TTS (Piper / eSpeak-NG / Windows SAPI) is not available on this host. Browser SpeechSynthesis provides interruptible speech output.'
    );
  }

  return {
    config: getVoiceConfig(),
    backendCapabilities: {
      whisperAvailable: whisper || fasterWhisper,
      piperAvailable: piper,
      espeakAvailable: espeak,
      windowsSapiAvailable,
      arecordAvailable: arecord,
      osDevices,
      browserSpeechSupportedNote:
        'Client Web Audio AnalyserNode VAD, silence detection, audio device enumeration, Push-to-Talk, Wake Word ("JARVIS"), EN/HI/Hinglish SpeechRecognition, and interruptible SpeechSynthesis run locally.',
    },
    setupGuidance: guidance,
  };
}

export async function transcribeAudioLocal(
  audioBase64: string,
  language: LanguageMode = 'auto'
): Promise<{ ok: boolean; text?: string; engine?: string; error?: string }> {
  const hasWhisper = await hasBinary('whisper');
  const hasFaster = await hasBinary('faster-whisper');

  if (!hasWhisper && !hasFaster) {
    return {
      ok: false,
      error:
        'Offline STT engine (whisper or faster-whisper) is not installed on this host. Cannot process server-side WAV locally.',
    };
  }

  const tmpDir = path.join(config.dataDir, 'tmp_audio');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, `${crypto.randomUUID()}.wav`);
  const outDir = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const cleanB64 = audioBase64.replace(/^data:audio\/[a-z0-9+.-]+;base64,/i, '');
    fs.writeFileSync(wavPath, Buffer.from(cleanB64, 'base64'));

    const langFlag = language === 'hi' ? 'hi' : language === 'en' ? 'en' : undefined;
    const bin = hasWhisper ? 'whisper' : 'faster-whisper';
    const args = [wavPath, '--model', 'base', '--output_format', 'txt', '--output_dir', outDir];
    if (langFlag) args.push('--language', langFlag);

    await execFileAsync(bin, args, { timeout: 60_000 });
    const txtFile = path.join(outDir, `${path.basename(wavPath, '.wav')}.txt`);
    const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8').trim() : '';
    logAudit('info', 'voice', 'local_stt_transcribed', { engine: bin, length: text.length });
    return { ok: true, text, engine: bin };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Local transcription failed',
    };
  } finally {
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  }
}

export async function synthesizeSpeechLocal(
  text: string,
  rate = 1.0
): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; engine?: string; error?: string }> {
  const cleanText = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 1200);
  if (!cleanText) return { ok: false, error: 'Empty text' };

  const tmpDir = path.join(config.dataDir, 'tmp_audio');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, `${crypto.randomUUID()}.wav`);

  try {
    if (await hasBinary('piper')) {
      const modelPath = process.env.PIPER_MODEL_PATH || 'en_US-lessac-medium.onnx';
      await new Promise<void>((resolve, reject) => {
        import('node:child_process').then(({ spawn }) => {
          const proc = spawn('piper', ['--model', modelPath, '--output_file', wavPath]);
          proc.on('error', reject);
          proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}`))));
          proc.stdin.write(cleanText);
          proc.stdin.end();
        });
      });
      const buf = fs.readFileSync(wavPath);
      return { ok: true, audioBase64: buf.toString('base64'), mimeType: 'audio/wav', engine: 'piper' };
    }

    if (await hasBinary('espeak-ng')) {
      await execFileAsync('espeak-ng', ['-w', wavPath, '-s', String(Math.round(170 * rate)), cleanText], {
        timeout: 15_000,
      });
      const buf = fs.readFileSync(wavPath);
      return { ok: true, audioBase64: buf.toString('base64'), mimeType: 'audio/wav', engine: 'espeak-ng' };
    }

    if (process.platform === 'win32') {
      // Safe Windows SAPI local offline synthesis passing text via env var (no shell interpolation)
      const sapiRate = Math.max(-10, Math.min(10, Math.round((rate - 1) * 5)));
      const script =
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
        `$s.Rate = ${sapiRate}; $s.SetOutputToWaveFile($env:JARVIS_TTS_OUT); $s.Speak($env:JARVIS_TTS_TEXT); $s.Dispose()`;
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 20_000,
        env: { ...process.env, JARVIS_TTS_OUT: wavPath, JARVIS_TTS_TEXT: cleanText },
      });
      const buf = fs.readFileSync(wavPath);
      return { ok: true, audioBase64: buf.toString('base64'), mimeType: 'audio/wav', engine: 'windows-sapi' };
    }

    return {
      ok: false,
      error: 'No offline backend TTS engine (Piper, eSpeak-NG, or Windows SAPI) is installed on this host.',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Local TTS synthesis failed',
    };
  } finally {
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  }
}
