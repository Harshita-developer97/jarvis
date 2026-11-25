import { useCallback, useEffect, useRef, useState } from 'react';
import { jarvisApi } from '../lib/api';
import type { LanguageMode, VoiceConfig } from '../types/jarvis';

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
}

export interface AudioDeviceSummary {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export interface BackendVoiceCapabilities {
  whisperAvailable?: boolean;
  piperAvailable?: boolean;
  espeakAvailable?: boolean;
  windowsSapiAvailable?: boolean;
}

const WAKE_WORD_VARIANTS = [
  'jarvis',
  'jarvic',
  'jarvish',
  'jarves',
  'jarviz',
  'jervis',
  'जार्विस',
  'जर्विस',
  'जार्विक',
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchWakeWord(
  transcript: string,
  configuredWakeWord: string
): { matched: boolean; command: string } {
  const normalized = transcript.trim();
  const candidates = Array.from(
    new Set(
      [configuredWakeWord.trim().toLowerCase(), ...WAKE_WORD_VARIANTS].filter(
        (w) => w.length >= 3
      )
    )
  );

  const lower = normalized.toLowerCase();
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx !== -1) {
      const stripped = normalized
        .replace(new RegExp(escapeRegex(candidate), 'ig'), ' ')
        .replace(/^[\s,.:;-]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        matched: true,
        command: stripped || 'Hello JARVIS',
      };
    }
  }
  return { matched: false, command: normalized };
}

function isWithinQuietHours(config: VoiceConfig): boolean {
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

function resolveRecognitionLang(language: LanguageMode): string {
  if (language === 'hi') return 'hi-IN';
  if (language === 'en') return 'en-US';
  // en-IN recognizes Indian English, Hinglish, and mixed Hindi words dramatically better than en-US
  return 'en-IN';
}

export function useVoiceAssistant(
  voiceConfig: VoiceConfig,
  onTranscriptCommand: (text: string) => void,
  backendCaps?: BackendVoiceCapabilities
) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDeviceSummary[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceSummary[]>([]);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const speechDetectedAtRef = useRef<number | null>(null);
  const lastVoiceActivityRef = useRef<number>(0);
  const latestTranscriptRef = useRef<string>('');
  const dispatchedInSessionRef = useRef<boolean>(false);
  const onTranscriptRef = useRef(onTranscriptCommand);
  const voiceConfigRef = useRef(voiceConfig);

  useEffect(() => {
    onTranscriptRef.current = onTranscriptCommand;
  }, [onTranscriptCommand]);

  useEffect(() => {
    voiceConfigRef.current = voiceConfig;
  }, [voiceConfig]);

  const SpeechRecognitionCtor =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const sttSupported = Boolean(SpeechRecognitionCtor) || Boolean(backendCaps?.whisperAvailable);
  const ttsSupported =
    (typeof window !== 'undefined' && 'speechSynthesis' in window) ||
    Boolean(
      backendCaps?.piperAvailable ||
        backendCaps?.espeakAvailable ||
        backendCaps?.windowsSapiAvailable
    );

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs: AudioDeviceSummary[] = [];
      const outputs: AudioDeviceSummary[] = [];
      for (const dev of list) {
        if (dev.kind === 'audioinput') {
          inputs.push({
            deviceId: dev.deviceId || 'default',
            label: dev.label || `Microphone (${inputs.length + 1})`,
            kind: 'audioinput',
          });
        } else if (dev.kind === 'audiooutput') {
          outputs.push({
            deviceId: dev.deviceId || 'default',
            label: dev.label || `Speaker (${outputs.length + 1})`,
            kind: 'audiooutput',
          });
        }
      }
      setInputDevices(inputs);
      setOutputDevices(outputs);
    } catch {
      // Browser blocked device enumeration without permission
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      const handler = () => void refreshDevices();
      navigator.mediaDevices.addEventListener('devicechange', handler);
      return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
    }
  }, [refreshDevices]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const loadVoices = () => {
      setAvailableVoices(window.speechSynthesis.getVoices());
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const stopAudioMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    speechDetectedAtRef.current = null;
    setVoiceActive(false);
    setMicLevel(0);
  }, []);

  const dispatchFinalTranscript = useCallback(
    (rawText: string, continuousMode?: boolean) => {
      const cfg = voiceConfigRef.current;
      const isContinuous = continuousMode ?? cfg.continuousListening;
      const text = rawText.trim();
      if (!text) return;

      if (isContinuous) {
        const wakeCheck = matchWakeWord(text, cfg.wakeWord || 'JARVIS');
        if (wakeCheck.matched) {
          dispatchedInSessionRef.current = true;
          setInterimText('');
          onTranscriptRef.current(wakeCheck.command);
        } else {
          setInterimText(
            `Heard "${text}" — say "${cfg.wakeWord || 'JARVIS'}" first to run`
          );
        }
      } else {
        dispatchedInSessionRef.current = true;
        setInterimText('');
        onTranscriptRef.current(text);
      }
    },
    []
  );

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    // Flush any unfinalized push-to-talk speech captured before stop
    if (!voiceConfig.continuousListening && !dispatchedInSessionRef.current && latestTranscriptRef.current.trim()) {
      const buffered = latestTranscriptRef.current.trim();
      latestTranscriptRef.current = '';
      dispatchFinalTranscript(buffered);
    } else {
      latestTranscriptRef.current = '';
      setInterimText('');
    }
    stopAudioMeter();
  }, [voiceConfig.continuousListening, dispatchFinalTranscript, stopAudioMeter]);

  const startAudioMeter = useCallback(
    async (withWhisperRecorder = false) => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const audioConstraint: MediaTrackConstraints | boolean =
          voiceConfig.inputDeviceId && voiceConfig.inputDeviceId !== 'default'
            ? { deviceId: { ideal: voiceConfig.inputDeviceId } }
            : true;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        if (!listeningRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioStreamRef.current = stream;
        void refreshDevices();

        if (withWhisperRecorder && typeof MediaRecorder !== 'undefined') {
          recordedChunksRef.current = [];
          const recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (ev) => {
            if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
          };
          recorder.onstop = () => {
            const chunks = recordedChunksRef.current;
            recordedChunksRef.current = [];
            if (chunks.length === 0) return;
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            const reader = new FileReader();
            reader.onloadend = async () => {
              const result = typeof reader.result === 'string' ? reader.result : '';
              const base64 = result.includes(',') ? result.split(',')[1] : result;
              if (!base64 || base64.length < 16) return;
              try {
                const tr = await jarvisApi.transcribeVoice(base64, voiceConfig.language);
                if (tr?.ok && tr.text) {
                  dispatchFinalTranscript(String(tr.text));
                } else if (tr?.error) {
                  setVoiceError(String(tr.error));
                }
              } catch (err) {
                setVoiceError(
                  err instanceof Error ? err.message : 'Local Whisper transcription failed'
                );
              }
            };
            reader.readAsDataURL(blob);
          };
          recorder.start();
          mediaRecorderRef.current = recorder;
        }

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const vadThreshold = voiceConfig.vadThreshold || 12;
        const silenceTimeoutMs = Math.max(voiceConfig.silenceTimeoutMs || 2400, 2400);

        const tick = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const level = Math.min(100, Math.round((sum / data.length / 128) * 100));
          setMicLevel(level);

          const now = Date.now();
          if (level >= vadThreshold) {
            setVoiceActive(true);
            if (!speechDetectedAtRef.current) speechDetectedAtRef.current = now;
            lastVoiceActivityRef.current = now;
          } else {
            setVoiceActive(false);
            if (
              !voiceConfig.continuousListening &&
              speechDetectedAtRef.current &&
              now - speechDetectedAtRef.current > 450 &&
              now - lastVoiceActivityRef.current > silenceTimeoutMs
            ) {
              stopListening();
              return;
            }
          }

          if (listeningRef.current) {
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        const inIframe = typeof window !== 'undefined' && window.self !== window.top;
        const msg = err instanceof Error ? err.message : 'Microphone unavailable';
        if (inIframe && /permission|denied|notallowed/i.test(msg)) {
          setVoiceError(
            'Microphone blocked inside embedded preview. Open this app in a standalone Chrome/Edge tab to enable voice input.'
          );
        } else if (withWhisperRecorder) {
          setVoiceError(`Microphone permission/device error: ${msg}`);
        }
      }
    },
    [
      voiceConfig.inputDeviceId,
      voiceConfig.vadThreshold,
      voiceConfig.silenceTimeoutMs,
      voiceConfig.continuousListening,
      voiceConfig.language,
      refreshDevices,
      stopListening,
      dispatchFinalTranscript,
    ]
  );

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
      audioElementRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string, langOverride?: LanguageMode) => {
      if (!voiceConfig.enabled || !text.trim() || isWithinQuietHours(voiceConfig)) return;
      if (voiceConfig.interruptible) {
        stopSpeaking();
      }
      const clean = text.replace(/[*_`#[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
      if (!clean) return;

      const backendHasTts = Boolean(
        backendCaps?.piperAvailable ||
          backendCaps?.espeakAvailable ||
          backendCaps?.windowsSapiAvailable
      );

      // Only hit backend TTS endpoint when an actual local TTS binary exists on the host;
      // otherwise stay synchronous so Chrome/Edge never drops user-gesture speech synthesis activation.
      if (backendHasTts) {
        try {
          const res = await jarvisApi.synthesizeVoice(clean, voiceConfig.speechRate || 1.0);
          if (res?.ok && res.audioBase64) {
            const audio = new Audio(`data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`);
            if (
              voiceConfig.outputDeviceId &&
              voiceConfig.outputDeviceId !== 'default' &&
              typeof (audio as any).setSinkId === 'function'
            ) {
              await (audio as any).setSinkId(voiceConfig.outputDeviceId).catch(() => {});
            }
            audioElementRef.current = audio;
            audio.onplay = () => setSpeaking(true);
            audio.onended = () => setSpeaking(false);
            audio.onerror = () => setSpeaking(false);
            await audio.play();
            return;
          }
        } catch {
          // Fall back to browser SpeechSynthesis below
        }
      }

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setVoiceError('No local TTS engine or browser SpeechSynthesis is available.');
        return;
      }

      try {
        window.speechSynthesis.resume();
      } catch {
        // ignore
      }

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = voiceConfig.speechRate || 1.0;

      const lang = langOverride || voiceConfig.language;
      if (lang === 'hi') utterance.lang = 'hi-IN';
      else if (lang === 'en') utterance.lang = 'en-US';
      else utterance.lang = 'en-IN';

      const voices = availableVoices.length > 0 ? availableVoices : window.speechSynthesis.getVoices();
      if (voiceConfig.voiceName && voiceConfig.voiceName !== 'default') {
        const match = voices.find((v) => v.name === voiceConfig.voiceName);
        if (match) utterance.voice = match;
      } else {
        const preferred =
          voices.find((v) => v.lang.toLowerCase() === utterance.lang.toLowerCase()) ||
          voices.find((v) => v.lang.toLowerCase().startsWith(utterance.lang.slice(0, 2).toLowerCase()));
        if (preferred) utterance.voice = preferred;
      }

      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = (ev) => {
        setSpeaking(false);
        const errCode = (ev as any)?.error;
        if (errCode && errCode !== 'canceled' && errCode !== 'interrupted') {
          setVoiceError(
            `Browser speech playback blocked (${errCode}). Click "Speak reply" on any message or allow audio in browser.`
          );
        }
      };

      window.speechSynthesis.speak(utterance);
    },
    [voiceConfig, backendCaps, availableVoices, stopSpeaking]
  );

  const startListening = useCallback(async (continuousOverride?: boolean) => {
    const cfg = voiceConfigRef.current;
    const isContinuous = continuousOverride ?? cfg.continuousListening;
    setVoiceError(null);
    latestTranscriptRef.current = '';
    dispatchedInSessionRef.current = false;

    if (cfg.interruptible) {
      stopSpeaking();
    }

    // Prime browser speechSynthesis inside user click gesture so async chat replies speak cleanly
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
      } catch {
        // ignore
      }
    }

    if (!SpeechRecognitionCtor) {
      if (backendCaps?.whisperAvailable) {
        listeningRef.current = true;
        setListening(true);
        await startAudioMeter(true);
        return;
      }
      setVoiceError(
        'Browser SpeechRecognition is unavailable here. Use Chrome or Edge in a standalone tab, or install Whisper for offline backend STT.'
      );
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }

    const recognition: SpeechRecognitionInstance = new SpeechRecognitionCtor();
    recognition.continuous = isContinuous;
    recognition.interimResults = true;
    recognition.lang = resolveRecognitionLang(cfg.language);

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0]?.transcript || '';
        if (res.isFinal) finalChunk += ` ${transcript}`;
        else interim += ` ${transcript}`;
      }

      const cleanInterim = interim.trim();
      const cleanFinal = finalChunk.trim();
      if (cleanInterim) {
        latestTranscriptRef.current = cleanInterim;
        setInterimText(cleanInterim);
      }

      if (cleanFinal) {
        latestTranscriptRef.current = '';
        dispatchFinalTranscript(cleanFinal, isContinuous);
        if (!isContinuous) {
          stopListening();
        }
      }
    };

    recognition.onerror = (ev: any) => {
      const code = ev?.error || 'unknown';
      if (code === 'aborted') return;
      if (code === 'no-speech' && isContinuous) return;

      const inIframe = typeof window !== 'undefined' && window.self !== window.top;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setVoiceError(
          inIframe
            ? 'Voice recognition was blocked by the embedded iframe sandbox. Open this preview URL in a new Chrome/Edge tab for full mic access.'
            : 'Microphone permission denied. Allow mic permission in Chrome/Edge site settings and try again.'
        );
        stopListening();
        return;
      }

      if (code === 'network') {
        if (backendCaps?.whisperAvailable) {
          setVoiceError('Browser Speech API network error — switching to local Whisper capture.');
          try {
            recognition.abort();
          } catch {
            // ignore
          }
          void startAudioMeter(true);
          return;
        }
        setVoiceError(
          'Browser SpeechRecognition could not reach speech service (offline or blocked). Type your message below or install local Whisper for 100% offline STT.'
        );
        stopListening();
        return;
      }

      setVoiceError(`Voice recognition notice: ${code}`);
      if (!isContinuous) {
        stopListening();
      }
    };

    recognition.onend = () => {
      if (listeningRef.current && isContinuous) {
        try {
          recognition.start();
          return;
        } catch {
          stopListening();
          return;
        }
      }
      if (listeningRef.current) {
        stopListening();
      }
    };

    recognitionRef.current = recognition;
    listeningRef.current = true;
    setListening(true);

    try {
      recognition.start();
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Unable to start speech recognition');
      stopListening();
      return;
    }

    // Start live mic meter alongside recognition without blocking user-gesture recognition.start()
    void startAudioMeter(false);
  }, [
    SpeechRecognitionCtor,
    backendCaps?.whisperAvailable,
    dispatchFinalTranscript,
    startAudioMeter,
    stopListening,
    stopSpeaking,
  ]);

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      stopAudioMeter();
      stopSpeaking();
    };
  }, [stopAudioMeter, stopSpeaking]);

  return {
    sttSupported,
    ttsSupported,
    listening,
    speaking,
    micLevel,
    voiceActive,
    interimText,
    voiceError,
    availableVoices,
    inputDevices,
    outputDevices,
    refreshDevices,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  };
}
