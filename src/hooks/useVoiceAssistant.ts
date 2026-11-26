import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jarvisApi } from '../lib/api';
import {
  DEFAULT_WAKE_PHRASES,
  detectHindiVoiceAvailable,
  isEndConversationCommand,
  isStopSpeechCommand,
  isWithinQuietHours,
  matchWakePhrase,
  resolveSpeechLangTag,
  sanitizeForSpeech,
  splitIntoSpeechSentences,
} from '../lib/voiceUtils';
import type { LanguageMode, VoiceConfig, VoiceLifecycleState } from '../types/jarvis';

const FOLLOW_UP_WINDOW_MS = 60_000;

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

export function useVoiceAssistant(
  voiceConfig: VoiceConfig,
  onTranscriptCommand: (text: string) => void,
  backendCaps?: BackendVoiceCapabilities,
  options?: {
    isProcessing?: boolean;
    onInterruptRequest?: () => void;
  }
) {
  const [lifecycleState, setLifecycleState] = useState<VoiceLifecycleState>('disabled');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [voiceStatusHint, setVoiceStatusHint] = useState<string | null>(null);
  const [followUpActive, setFollowUpActive] = useState(false);
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
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listeningRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const echoTailUntilRef = useRef<number>(0);
  const awaitingCommandUntilRef = useRef<number>(0);
  const inConversationRef = useRef<boolean>(false);
  const wasProcessingRef = useRef<boolean>(false);
  const speechDetectedAtRef = useRef<number | null>(null);
  const lastVoiceActivityRef = useRef<number>(0);
  const latestTranscriptRef = useRef<string>('');
  const dispatchedInSessionRef = useRef<boolean>(false);
  const utteranceGenerationRef = useRef<number>(0);
  const lastDispatchedRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const autoWakeAttemptedRef = useRef<boolean>(false);

  const onTranscriptRef = useRef(onTranscriptCommand);
  const onInterruptRef = useRef(options?.onInterruptRequest);
  const voiceConfigRef = useRef(voiceConfig);
  const isProcessingRef = useRef(Boolean(options?.isProcessing));

  useEffect(() => {
    onTranscriptRef.current = onTranscriptCommand;
  }, [onTranscriptCommand]);

  useEffect(() => {
    onInterruptRef.current = options?.onInterruptRequest;
  }, [options?.onInterruptRequest]);

  useEffect(() => {
    voiceConfigRef.current = voiceConfig;
  }, [voiceConfig]);

  const clearFollowUpTimer = useCallback(() => {
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  }, []);

  const armFollowUpWindow = useCallback(
    (durationMs = FOLLOW_UP_WINDOW_MS) => {
      if (!listeningRef.current || !voiceConfigRef.current.continuousListening) return;
      clearFollowUpTimer();
      inConversationRef.current = true;
      const deadline = Date.now() + durationMs;
      awaitingCommandUntilRef.current = deadline;
      setFollowUpActive(true);
      setVoiceStatusHint(
        `Conversation active (${Math.round(durationMs / 1000)}s) — speak directly without repeating "${voiceConfigRef.current.wakeWord || 'Jarvis'}".`
      );
      if (!isSpeakingRef.current && !isProcessingRef.current) {
        setLifecycleState('recording_command');
      }
      followUpTimerRef.current = setTimeout(() => {
        if (Date.now() < awaitingCommandUntilRef.current) {
          const remaining = awaitingCommandUntilRef.current - Date.now();
          if (remaining > 500) {
            armFollowUpWindow(remaining);
            return;
          }
        }
        inConversationRef.current = false;
        awaitingCommandUntilRef.current = 0;
        setFollowUpActive(false);
        setVoiceStatusHint(null);
        if (listeningRef.current && !isSpeakingRef.current && !isProcessingRef.current) {
          setLifecycleState(
            voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
          );
        }
      }, durationMs + 50);
    },
    [clearFollowUpTimer]
  );

  const sleepConversation = useCallback(() => {
    clearFollowUpTimer();
    inConversationRef.current = false;
    awaitingCommandUntilRef.current = 0;
    setFollowUpActive(false);
    setInterimText('');
    setVoiceStatusHint(
      `Standby — say "${voiceConfigRef.current.wakeWord || 'Hey Jarvis'}" when you need me.`
    );
    if (listeningRef.current && !isSpeakingRef.current && !isProcessingRef.current) {
      setLifecycleState(
        voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
      );
    }
  }, [clearFollowUpTimer]);

  useEffect(() => {
    const busy = Boolean(options?.isProcessing);
    const wasBusy = wasProcessingRef.current;
    wasProcessingRef.current = busy;
    isProcessingRef.current = busy;

    if (busy) {
      setLifecycleState('processing');
      return;
    }

    if (wasBusy && !isSpeakingRef.current && listeningRef.current) {
      if (voiceConfigRef.current.continuousListening && inConversationRef.current) {
        armFollowUpWindow();
      } else {
        setLifecycleState(
          voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
        );
      }
      return;
    }

    if (!isSpeakingRef.current && listeningRef.current) {
      setLifecycleState(
        voiceConfigRef.current.continuousListening
          ? awaitingCommandUntilRef.current > Date.now()
            ? 'recording_command'
            : 'wake_listening'
          : 'recording_command'
      );
    } else if (!isSpeakingRef.current && !listeningRef.current) {
      setLifecycleState((prev) => (prev === 'error' ? 'error' : 'disabled'));
    }
  }, [options?.isProcessing, armFollowUpWindow]);

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

  const hindiVoiceAvailable = useMemo(
    () => detectHindiVoiceAvailable(availableVoices),
    [availableVoices]
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

  const stopSpeaking = useCallback(
    (markInterrupted = false) => {
      utteranceGenerationRef.current += 1;
      if (sentenceTimerRef.current) {
        clearTimeout(sentenceTimerRef.current);
        sentenceTimerRef.current = null;
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current.currentTime = 0;
        audioElementRef.current = null;
      }
      if (isSpeakingRef.current) {
        echoTailUntilRef.current = Date.now() + 400;
      }
      isSpeakingRef.current = false;
      setSpeaking(false);

      if (markInterrupted) {
        setLifecycleState('interrupted');
        setTimeout(() => {
          if (listeningRef.current && !isProcessingRef.current) {
            if (voiceConfigRef.current.continuousListening && inConversationRef.current) {
              armFollowUpWindow();
            } else {
              setLifecycleState(
                voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
              );
            }
          } else if (!isProcessingRef.current) {
            setLifecycleState('disabled');
          }
        }, 450);
      } else if (listeningRef.current && !isProcessingRef.current) {
        if (voiceConfigRef.current.continuousListening && inConversationRef.current) {
          armFollowUpWindow();
        } else {
          setLifecycleState(
            voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
          );
        }
      } else if (!isProcessingRef.current) {
        setLifecycleState('disabled');
      }
    },
    [armFollowUpWindow]
  );

  const speak = useCallback(
    async (text: string, langOverride?: LanguageMode) => {
      const cfg = voiceConfigRef.current;
      if (!cfg.enabled || !text.trim() || isWithinQuietHours(cfg)) return;

      const clean = sanitizeForSpeech(text, { shortMode: cfg.shortVoiceResponses });
      if (!clean) return;

      if (cfg.interruptible) {
        stopSpeaking(false);
      }

      const generation = ++utteranceGenerationRef.current;

      const finishSpeaking = () => {
        if (utteranceGenerationRef.current !== generation) return;
        isSpeakingRef.current = false;
        setSpeaking(false);
        echoTailUntilRef.current = Date.now() + 420;
        if (!isProcessingRef.current) {
          if (listeningRef.current) {
            if (voiceConfigRef.current.continuousListening && inConversationRef.current) {
              armFollowUpWindow();
            } else {
              setLifecycleState(
                voiceConfigRef.current.continuousListening ? 'wake_listening' : 'recording_command'
              );
            }
          } else {
            setLifecycleState('disabled');
          }
        }
      };

      const backendHasTts = Boolean(
        backendCaps?.piperAvailable ||
          backendCaps?.espeakAvailable ||
          backendCaps?.windowsSapiAvailable
      );

      if (backendHasTts) {
        try {
          const res = await jarvisApi.synthesizeVoice(clean.slice(0, 1100), cfg.speechRate || 1.0);
          if (utteranceGenerationRef.current !== generation) return;
          if (res?.ok && res.audioBase64) {
            const audio = new Audio(`data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`);
            audio.volume = Math.max(0, Math.min(1, cfg.speechVolume ?? 1.0));
            if (
              cfg.outputDeviceId &&
              cfg.outputDeviceId !== 'default' &&
              typeof (audio as any).setSinkId === 'function'
            ) {
              await (audio as any).setSinkId(cfg.outputDeviceId).catch(() => {});
            }
            audioElementRef.current = audio;
            audio.onplay = () => {
              isSpeakingRef.current = true;
              setSpeaking(true);
              setLifecycleState('speaking');
            };
            audio.onended = finishSpeaking;
            audio.onerror = finishSpeaking;
            await audio.play();
            return;
          }
        } catch {
          // Fall back to browser SpeechSynthesis cleanly
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

      const chunks = splitIntoSpeechSentences(clean);
      if (chunks.length === 0) return;

      const langTag = resolveSpeechLangTag(langOverride || cfg.language);
      const voices =
        availableVoices.length > 0 ? availableVoices : window.speechSynthesis.getVoices();

      let selectedVoice: SpeechSynthesisVoice | undefined;
      if (cfg.voiceName && cfg.voiceName !== 'default') {
        selectedVoice = voices.find((v) => v.name === cfg.voiceName);
      }
      if (!selectedVoice) {
        selectedVoice =
          voices.find((v) => v.lang.toLowerCase() === langTag.toLowerCase()) ||
          voices.find((v) =>
            v.lang.toLowerCase().startsWith(langTag.slice(0, 2).toLowerCase())
          ) ||
          voices.find((v) => v.lang.toLowerCase().startsWith('en'));
      }

      const speakChunkAt = (index: number) => {
        if (utteranceGenerationRef.current !== generation) return;
        if (index >= chunks.length) {
          finishSpeaking();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        utterance.rate = Math.max(0.5, Math.min(2.0, cfg.speechRate || 1.0));
        utterance.pitch = Math.max(0.5, Math.min(2.0, cfg.speechPitch || 1.0));
        utterance.volume = Math.max(0, Math.min(1, cfg.speechVolume ?? 1.0));
        utterance.lang = selectedVoice?.lang || langTag;
        if (selectedVoice) utterance.voice = selectedVoice;

        utterance.onstart = () => {
          if (utteranceGenerationRef.current !== generation) return;
          isSpeakingRef.current = true;
          setSpeaking(true);
          setLifecycleState('speaking');
        };

        utterance.onend = () => {
          if (utteranceGenerationRef.current !== generation) return;
          if (index + 1 < chunks.length) {
            sentenceTimerRef.current = setTimeout(() => speakChunkAt(index + 1), 140);
          } else {
            finishSpeaking();
          }
        };

        utterance.onerror = (ev) => {
          if (utteranceGenerationRef.current !== generation) return;
          const errCode = (ev as any)?.error;
          isSpeakingRef.current = false;
          setSpeaking(false);
          if (errCode && errCode !== 'canceled' && errCode !== 'interrupted') {
            setVoiceError(
              `Browser speech playback blocked (${errCode}). Click "Speak reply" on any message or allow audio in browser.`
            );
            setLifecycleState('error');
          } else {
            finishSpeaking();
          }
        };

        window.speechSynthesis.speak(utterance);
      };

      speakChunkAt(0);
    },
    [backendCaps, availableVoices, stopSpeaking, armFollowUpWindow]
  );

  const emitCommandSafe = useCallback(
    (commandText: string, keepConversationAlive = false) => {
      const clean = commandText.trim();
      if (!clean) return;
      const now = Date.now();
      if (
        lastDispatchedRef.current.text.toLowerCase() === clean.toLowerCase() &&
        now - lastDispatchedRef.current.at < 2200
      ) {
        return;
      }
      lastDispatchedRef.current = { text: clean, at: now };
      clearFollowUpTimer();
      awaitingCommandUntilRef.current = 0;
      setFollowUpActive(false);
      if (keepConversationAlive) {
        inConversationRef.current = true;
      }
      dispatchedInSessionRef.current = true;
      setInterimText('');
      setVoiceStatusHint(null);
      setLifecycleState('processing');
      onTranscriptRef.current(clean);
    },
    [clearFollowUpTimer]
  );

  const dispatchFinalTranscript = useCallback(
    (rawText: string, continuousMode?: boolean) => {
      const cfg = voiceConfigRef.current;
      const isContinuous = continuousMode ?? cfg.continuousListening;
      const text = rawText.trim();
      if (!text) return;

      // Spoken barge-in stop command works even while JARVIS is speaking
      if (isSpeakingRef.current && isStopSpeechCommand(text)) {
        stopSpeaking(true);
        onInterruptRef.current?.();
        setInterimText('');
        return;
      }

      // Acoustic echo guard: ignore self-output while speaking or right after TTS completes
      if (isSpeakingRef.current || Date.now() < echoTailUntilRef.current) {
        return;
      }

      if (isContinuous) {
        const followUpOpen =
          inConversationRef.current || awaitingCommandUntilRef.current > Date.now();

        if (followUpOpen) {
          if (isEndConversationCommand(text)) {
            sleepConversation();
            return;
          }

          const wakeOnly = matchWakePhrase(
            text,
            cfg.wakeWord || 'Hey Jarvis',
            cfg.wakePhrases || DEFAULT_WAKE_PHRASES
          );
          if (wakeOnly.matched && !wakeOnly.hasCommand) {
            armFollowUpWindow();
            return;
          }
          emitCommandSafe(wakeOnly.matched ? wakeOnly.command : text, true);
          return;
        }

        const wakeCheck = matchWakePhrase(
          text,
          cfg.wakeWord || 'Hey Jarvis',
          cfg.wakePhrases || DEFAULT_WAKE_PHRASES
        );
        if (wakeCheck.matched) {
          if (wakeCheck.hasCommand) {
            emitCommandSafe(wakeCheck.command, true);
          } else {
            // Wake word detected alone ("Hey Jarvis") -> enter active conversation window
            inConversationRef.current = true;
            setLifecycleState('wake_detected');
            armFollowUpWindow();
            if (cfg.enabled) {
              const promptPhrase = cfg.language === 'hi' ? 'जी, बोलिए।' : 'Yes, listening.';
              void speak(promptPhrase, cfg.language);
            }
          }
        } else {
          setVoiceStatusHint(
            `Heard "${text}" — say "${cfg.wakeWord || 'Hey Jarvis'}" once to start conversation.`
          );
        }
      } else {
        emitCommandSafe(text, false);
      }
    },
    [emitCommandSafe, speak, stopSpeaking, armFollowUpWindow, sleepConversation]
  );

  const stopListening = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    clearFollowUpTimer();
    listeningRef.current = false;
    inConversationRef.current = false;
    awaitingCommandUntilRef.current = 0;
    setFollowUpActive(false);
    setVoiceStatusHint(null);
    setListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    // Flush any unfinalized push-to-talk speech captured before stop
    if (
      !voiceConfigRef.current.continuousListening &&
      !dispatchedInSessionRef.current &&
      latestTranscriptRef.current.trim()
    ) {
      const buffered = latestTranscriptRef.current.trim();
      latestTranscriptRef.current = '';
      dispatchFinalTranscript(buffered, false);
    } else {
      latestTranscriptRef.current = '';
      setInterimText('');
    }
    stopAudioMeter();
    if (!isSpeakingRef.current && !isProcessingRef.current) {
      setLifecycleState('disabled');
    }
  }, [clearFollowUpTimer, dispatchFinalTranscript, stopAudioMeter]);

  const startAudioMeter = useCallback(
    async (withWhisperRecorder = false) => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
      const cfg = voiceConfigRef.current;
      try {
        const audioConstraint: MediaTrackConstraints | boolean =
          cfg.inputDeviceId && cfg.inputDeviceId !== 'default'
            ? { deviceId: { ideal: cfg.inputDeviceId } }
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
                const tr = await jarvisApi.transcribeVoice(base64, voiceConfigRef.current.language);
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

        const tick = () => {
          const liveCfg = voiceConfigRef.current;
          const vadThreshold = liveCfg.vadThreshold || 12;
          const silenceTimeoutMs = Math.max(liveCfg.silenceTimeoutMs || 1800, 1800);

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
              !liveCfg.continuousListening &&
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
          setLifecycleState('error');
        } else if (withWhisperRecorder) {
          setVoiceError(`Microphone permission/device error: ${msg}`);
          setLifecycleState('error');
        }
      }
    },
    [refreshDevices, stopListening, dispatchFinalTranscript]
  );

  const startListening = useCallback(
    async (continuousOverride?: boolean) => {
      const cfg = voiceConfigRef.current;
      const isContinuous = continuousOverride ?? cfg.continuousListening;
      setVoiceError(null);
      latestTranscriptRef.current = '';
      dispatchedInSessionRef.current = false;
      setLifecycleState('initializing');

      if (cfg.interruptible && isSpeakingRef.current) {
        stopSpeaking(true);
      }

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
          setLifecycleState(isContinuous ? 'wake_listening' : 'recording_command');
          await startAudioMeter(true);
          return;
        }
        setVoiceError(
          'Browser SpeechRecognition is unavailable here. Use Chrome or Edge in a standalone tab, or install Whisper for offline backend STT.'
        );
        setLifecycleState('error');
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
      recognition.lang = resolveSpeechLangTag(cfg.language);

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
          if (isSpeakingRef.current && isStopSpeechCommand(cleanInterim)) {
            stopSpeaking(true);
            onInterruptRef.current?.();
            return;
          }
          if (!isSpeakingRef.current && Date.now() >= echoTailUntilRef.current) {
            if (isContinuous && awaitingCommandUntilRef.current > Date.now()) {
              awaitingCommandUntilRef.current = Math.max(
                awaitingCommandUntilRef.current,
                Date.now() + 20_000
              );
            }
            latestTranscriptRef.current = cleanInterim;
            setInterimText(cleanInterim);
          }
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
          setLifecycleState('error');
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
          setLifecycleState('error');
          stopListening();
          return;
        }

        setVoiceError(`Voice recognition notice: ${code}`);
        if (!isContinuous) {
          setLifecycleState('error');
          stopListening();
        }
      };

      recognition.onend = () => {
        if (listeningRef.current && isContinuous) {
          setLifecycleState('recovering');
          restartTimerRef.current = setTimeout(() => {
            if (!listeningRef.current) return;
            try {
              recognition.start();
              if (!isSpeakingRef.current && !isProcessingRef.current) {
                setLifecycleState(
                  awaitingCommandUntilRef.current > Date.now()
                    ? 'recording_command'
                    : 'wake_listening'
                );
              }
            } catch {
              setLifecycleState('error');
              stopListening();
            }
          }, 220);
          return;
        }
        if (listeningRef.current) {
          stopListening();
        }
      };

      recognitionRef.current = recognition;
      listeningRef.current = true;
      setListening(true);
      setLifecycleState(isContinuous ? 'wake_listening' : 'recording_command');

      try {
        recognition.start();
      } catch (err) {
        setVoiceError(err instanceof Error ? err.message : 'Unable to start speech recognition');
        setLifecycleState('error');
        stopListening();
        return;
      }

      void startAudioMeter(false);
    },
    [
      SpeechRecognitionCtor,
      backendCaps?.whisperAvailable,
      dispatchFinalTranscript,
      startAudioMeter,
      stopListening,
      stopSpeaking,
    ]
  );

  // Auto-start Wake Listening cleanly on boot if Auto-Wake is persisted and mic permission is already granted
  useEffect(() => {
    if (autoWakeAttemptedRef.current) return;
    if (!voiceConfig.enabled || !voiceConfig.continuousListening) return;
    if (listeningRef.current || !sttSupported) return;

    autoWakeAttemptedRef.current = true;
    const permApi = typeof navigator !== 'undefined' ? (navigator as any).permissions : undefined;
    if (permApi?.query) {
      permApi
        .query({ name: 'microphone' })
        .then((status: { state: string }) => {
          if (status.state === 'granted' && voiceConfigRef.current.continuousListening) {
            void startListening(true);
          } else {
            setVoiceStatusHint(
              `Auto-Wake enabled (${voiceConfigRef.current.wakeWord}) — click "Start Wake Listener" once to arm browser microphone.`
            );
          }
        })
        .catch(() => {
          setVoiceStatusHint(
            `Auto-Wake enabled (${voiceConfigRef.current.wakeWord}) — click "Start Wake Listener" once to arm browser microphone.`
          );
        });
    }
  }, [voiceConfig.enabled, voiceConfig.continuousListening, sttSupported, startListening]);

  useEffect(() => {
    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (sentenceTimerRef.current) clearTimeout(sentenceTimerRef.current);
      clearFollowUpTimer();
      listeningRef.current = false;
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
      stopAudioMeter();
      stopSpeaking(false);
    };
  }, [clearFollowUpTimer, stopAudioMeter, stopSpeaking]);

  return {
    lifecycleState,
    sttSupported,
    ttsSupported,
    hindiVoiceAvailable,
    listening,
    speaking,
    followUpActive,
    micLevel,
    voiceActive,
    interimText,
    voiceStatusHint,
    voiceError,
    availableVoices,
    inputDevices,
    outputDevices,
    refreshDevices,
    startListening,
    stopListening,
    sleepConversation,
    speak,
    stopSpeaking: () => stopSpeaking(true),
  };
}
