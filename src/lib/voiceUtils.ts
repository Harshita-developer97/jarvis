import type { LanguageMode, VoiceConfig, VoiceLifecycleState } from '../types/jarvis';

export const DEFAULT_WAKE_PHRASES = ['Hey Jarvis', 'Jarvis', 'Hello Jarvis'];

const PHONETIC_WAKE_VARIANTS = [
  'hey jarvis',
  'hello jarvis',
  'ok jarvis',
  'okay jarvis',
  'hi jarvis',
  'jarvis',
  'jarvic',
  'jarvish',
  'jarves',
  'jarviz',
  'jervis',
  'हे जार्विस',
  'हेलो जार्विस',
  'जार्विस',
  'जर्विस',
  'जार्विक',
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface WakeMatchResult {
  matched: boolean;
  matchedPhrase: string | null;
  hasCommand: boolean;
  command: string;
}

/**
 * Matches multi-word and phonetic wake phrases (e.g. "Hey Jarvis", "Jarvis", "Hello Jarvis").
 * Distinguishes wake-only ("Hey Jarvis") from one-shot wake+command ("Hey Jarvis, what is the capital of India?").
 */
export function matchWakePhrase(
  transcript: string,
  configuredWakeWord = 'Hey Jarvis',
  wakePhrases: string[] = DEFAULT_WAKE_PHRASES
): WakeMatchResult {
  const normalized = transcript.trim();
  if (!normalized) {
    return { matched: false, matchedPhrase: null, hasCommand: false, command: '' };
  }

  const allCandidates = Array.from(
    new Set(
      [
        configuredWakeWord.trim().toLowerCase(),
        ...wakePhrases.map((p) => p.trim().toLowerCase()),
        ...PHONETIC_WAKE_VARIANTS,
      ].filter((w) => w.length >= 3)
    )
  ).sort((a, b) => b.length - a.length);

  const lower = normalized.toLowerCase();
  for (const candidate of allCandidates) {
    const idx = lower.indexOf(candidate);
    if (idx !== -1) {
      const stripped = normalized
        .replace(new RegExp(escapeRegex(candidate), 'ig'), ' ')
        .replace(/^[\s,.:;!?-]+/, '')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        matched: true,
        matchedPhrase: candidate,
        hasCommand: stripped.length > 0,
        command: stripped,
      };
    }
  }

  return { matched: false, matchedPhrase: null, hasCommand: false, command: normalized };
}

/**
 * Detects spoken commands meant to interrupt or mute JARVIS speech output.
 */
export function isStopSpeechCommand(transcript: string): boolean {
  const lower = transcript.trim().toLowerCase();
  if (!lower) return false;
  const patterns = [
    /\bstop speaking\b/,
    /\bstop talking\b/,
    /\bjarvis stop\b/,
    /\bstop jarvis\b/,
    /\bbe quiet\b/,
    /\bshut up\b/,
    /\bcancel speech\b/,
    /\buse stop karo\b/,
    /\bbolna band karo\b/,
    /\bband karo\b/,
    /\bchup raho\b/,
    /\bruk jao\b/,
    /^stop$/i,
  ];
  return patterns.some((re) => re.test(lower));
}

/**
 * Detects spoken commands meant to end the active follow-up conversation and return to wake-word standby.
 */
export function isEndConversationCommand(transcript: string): boolean {
  const lower = transcript.trim().toLowerCase();
  if (!lower) return false;
  const patterns = [
    /\bbye jarvis\b/,
    /\bgoodbye jarvis\b/,
    /\bgo to sleep\b/,
    /\bsleep mode\b/,
    /\bstop listening\b/,
    /\bend conversation\b/,
    /\bthat'?s all jarvis\b/,
    /\bbas jarvis\b/,
    /\bso jao\b/,
    /^(bye|goodbye)$/i,
  ];
  return patterns.some((re) => re.test(lower));
}

/**
 * Cleans assistant text for natural TTS playback:
 * strips fenced code blocks, JSON payloads, internal telemetry tags, URLs, and markdown noise.
 */
export function sanitizeForSpeech(
  rawText: string,
  options?: { shortMode?: boolean }
): string {
  if (!rawText || !rawText.trim()) return '';

  let cleaned = rawText;

  // 1. Remove fenced code blocks completely so raw syntax is never read aloud
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' Code block omitted. ');

  // 2. Remove internal backend diagnostic headers and raw multiline JSON blocks
  cleaned = cleaned.replace(
    /\[(REAL SYSTEM TELEMETRY|AGENT ORCHESTRATION|PERSISTENT MEMORY|AUTONOMOUS TASK QUEUED|CREATED REMINDER|RESEARCH FINDINGS|PROJECT ANALYSIS|MEMORY CONFIRMED)\]/gi,
    ' '
  );
  cleaned = cleaned.replace(/\{[\s\S]*?"[^"]+"\s*:[\s\S]*?\}/g, ' ');
  cleaned = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*\]/g, ' ');

  // 3. Replace markdown links [label](url) with label, and strip bare URLs
  cleaned = cleaned.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1');
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, '');

  // 4. Strip inline code ticks, markdown symbols, and bullet markers cleanly
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
  cleaned = cleaned.replace(/^[\s]*[-*•]+\s+/gm, '');
  cleaned = cleaned.replace(/[*_~>#|]+/g, ' ');

  // 5. Remove trailing setup bullet checklists when Ollama is offline
  cleaned = cleaned.replace(/Setup check:\s*/gi, '');

  // 6. Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (options?.shortMode && cleaned.length > 260) {
    const sentences = splitIntoSpeechSentences(cleaned);
    const concise = sentences.slice(0, 2).join(' ').trim();
    return concise.length > 0 ? concise : cleaned.slice(0, 260).trim();
  }

  return cleaned.slice(0, 1800);
}

/**
 * Segments cleaned speech text into natural sentences to prevent browser SpeechSynthesis stalls
 * on long responses while inserting natural pauses between sentences.
 */
export function splitIntoSpeechSentences(cleanText: string): string[] {
  const normalized = cleanText.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  // Split at sentence-ending punctuation followed by whitespace (preserve decimals/IPs)
  const parts = normalized
    .split(/(?<=[.!?।])\s+(?=[A-Z0-9\u0900-\u097F"'(a-z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length === 0) return [normalized];

  // Ensure no single utterance exceeds ~260 chars for Chrome SpeechSynthesis stability
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.length <= 260) {
      chunks.push(part);
    } else {
      const subParts = part.split(/,\s+/);
      let current = '';
      for (const sub of subParts) {
        if ((current + ', ' + sub).length > 240 && current) {
          chunks.push(current.trim());
          current = sub;
        } else {
          current = current ? `${current}, ${sub}` : sub;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  }
  return chunks;
}

export function detectHindiVoiceAvailable(
  voices: Array<{ lang: string; name: string }>
): boolean {
  return voices.some(
    (v) =>
      v.lang.toLowerCase().startsWith('hi') ||
      v.name.toLowerCase().includes('hindi') ||
      v.name.toLowerCase().includes('hemant') ||
      v.name.toLowerCase().includes('kalpana') ||
      v.name.toLowerCase().includes('swara') ||
      v.name.toLowerCase().includes('madhur')
  );
}

export function resolveSpeechLangTag(language: LanguageMode): string {
  if (language === 'hi') return 'hi-IN';
  if (language === 'en') return 'en-US';
  return 'en-IN';
}

export function formatVoiceLifecycleLabel(state: VoiceLifecycleState): string {
  switch (state) {
    case 'disabled':
      return 'Disabled';
    case 'initializing':
      return 'Initializing Mic';
    case 'wake_listening':
      return 'Wake Listening';
    case 'wake_detected':
      return 'Wake Detected';
    case 'recording_command':
      return 'Recording Command';
    case 'processing':
      return 'Thinking';
    case 'speaking':
      return 'Speaking';
    case 'interrupted':
      return 'Interrupted';
    case 'recovering':
      return 'Recovering Mic';
    case 'error':
      return 'Voice Attention Needed';
  }
}

export function isWithinQuietHours(config: VoiceConfig): boolean {
  if (!config.quietHoursEnabled) return false;
  const parseMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };
  const start = parseMinutes(config.quietHoursStart);
  const end = parseMinutes(config.quietHoursEnd);
  if (start === null || end === null) return false;

  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  if (start <= end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}
