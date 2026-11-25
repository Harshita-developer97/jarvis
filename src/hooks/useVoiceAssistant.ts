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

export function useVoiceAssistant(
  voiceConfig: VoiceConfig,
  onTranscriptCommand: (text: string) => void
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
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  const speechDetectedAtRef = useRef<number | null>(null);
  const lastVoiceActivityRef = useRef<number>(0);

  const SpeechRecognitionCtor =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  const sttSupported = Boolean(SpeechRecognitionCtor);
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

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
    if (!ttsSupported) return;
    const loadVoices = () => {
      setAvailableVoices(window.speechSynthesis.getVoices());
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [ttsSupported]);

  const stopAudioMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
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

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterimText('');
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    stopAudioMeter();
  }, [stopAudioMeter]);

  const startAudioMeter = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const audioConstraint: MediaTrackConstraints | boolean =
        voiceConfig.inputDeviceId && voiceConfig.inputDeviceId !== 'default'
          ? { deviceId: { ideal: voiceConfig.inputDeviceId } }
          : true;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      audioStreamRef.current = stream;
      void refreshDevices();

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const vadThreshold = voiceConfig.vadThreshold || 12;
      const silenceTimeoutMs = voiceConfig.silenceTimeoutMs || 1800;

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
            now - lastVoiceActivityRef.current > silenceTimeoutMs
          ) {
            // Auto-stop push-to-talk after configured silence window
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
      setVoiceError(
        err instanceof Error ? `Microphone permission/device error: ${err.message}` : 'Microphone unavailable'
      );
    }
  }, [
    voiceConfig.inputDeviceId,
    voiceConfig.vadThreshold,
    voiceConfig.silenceTimeoutMs,
    voiceConfig.continuousListening,
    refreshDevices,
    stopListening,
  ]);

  const stopSpeaking = useCallback(() => {
    if (ttsSupported) {
      window.speechSynthesis.cancel();
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
      audioElementRef.current = null;
    }
    setSpeaking(false);
  }, [ttsSupported]);

  const speak = useCallback(
    async (text: string, langOverride?: LanguageMode) => {
      if (!voiceConfig.enabled || !text.trim()) return;
      if (voiceConfig.interruptible) {
        stopSpeaking();
      }
      const clean = text.replace(/[*_`#[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);

      // Prefer local backend TTS (Piper / eSpeak-NG / Windows SAPI) if available and specific output routing desired
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
        // Backend local TTS not installed on this host -> gracefully fall back to browser speechSynthesis
      }

      if (!ttsSupported) {
        setVoiceError('No local TTS engine or browser SpeechSynthesis is available.');
        return;
      }

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = voiceConfig.speechRate || 1.0;

      const lang = langOverride || voiceConfig.language;
      if (lang === 'hi') utterance.lang = 'hi-IN';
      else if (lang === 'hinglish') utterance.lang = 'en-IN';
      else utterance.lang = 'en-US';

      if (voiceConfig.voiceName && voiceConfig.voiceName !== 'default') {
        const match = availableVoices.find((v) => v.name === voiceConfig.voiceName);
        if (match) utterance.voice = match;
      }

      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    [ttsSupported, voiceConfig, availableVoices, stopSpeaking]
  );

  const startListening = useCallback(async () => {
    setVoiceError(null);
    if (!SpeechRecognitionCtor) {
      setVoiceError(
        'Browser SpeechRecognition API is unavailable in this webview; check backend Whisper settings or use text input.'
      );
      return;
    }

    if (voiceConfig.interruptible) {
      stopSpeaking();
    }

    const recognition: SpeechRecognitionInstance = new SpeechRecognitionCtor();
    recognition.continuous = voiceConfig.continuousListening;
    recognition.interimResults = true;
    recognition.lang =
      voiceConfig.language === 'hi'
        ? 'hi-IN'
        : voiceConfig.language === 'hinglish'
        ? 'en-IN'
        : 'en-US';

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0]?.transcript || '';
        if (res.isFinal) finalChunk += transcript;
        else interim += transcript;
      }
      setInterimText(interim.trim());

      if (finalChunk.trim()) {
        const text = finalChunk.trim();
        const wake = (voiceConfig.wakeWord || 'JARVIS').toLowerCase();
        if (voiceConfig.continuousListening) {
          if (text.toLowerCase().includes(wake)) {
            const cleaned = text.replace(new RegExp(wake, 'ig'), '').trim() || text;
            onTranscriptCommand(cleaned);
          }
        } else {
          onTranscriptCommand(text);
          stopListening();
        }
      }
    };

    recognition.onerror = (ev: any) => {
      if (ev.error !== 'aborted') {
        setVoiceError(`Voice recognition error: ${ev.error} (recovered cleanly)`);
      }
      if (!voiceConfig.continuousListening) {
        stopListening();
      }
    };

    recognition.onend = () => {
      if (listeningRef.current && voiceConfig.continuousListening) {
        try {
          recognition.start();
        } catch {
          stopListening();
        }
      } else {
        stopListening();
      }
    };

    recognitionRef.current = recognition;
    listeningRef.current = true;
    setListening(true);
    await startAudioMeter();
    try {
      recognition.start();
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : 'Unable to start speech recognition');
      stopListening();
    }
  }, [
    SpeechRecognitionCtor,
    voiceConfig,
    onTranscriptCommand,
    startAudioMeter,
    stopListening,
    stopSpeaking,
  ]);

  useEffect(() => {
    return () => {
      stopListening();
      stopSpeaking();
    };
  }, [stopListening, stopSpeaking]);

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
