/**
 * Voice Reader — Text-to-speech using Web Speech API or Google Cloud TTS.
 *
 * Modes:
 * - "system": Browser's built-in SpeechSynthesis (free, instant, lower quality)
 * - "google": Google Cloud TTS (free 1M chars/mo, high quality WaveNet/Neural2 voices)
 */

import { isConfigured as isGoogleTTSConfigured, speakChunk as googleSpeakChunk, prefetch as googlePrefetch, stopPlayback as googleStopPlayback, pausePlayback as googlePausePlayback, getSavedVoiceName, getSavedLanguageCode } from './google-tts';

export type TTSEngine = 'system' | 'google';

export class VoiceReader {
  private synth: SpeechSynthesis;
  private utterance: SpeechSynthesisUtterance | null = null;
  private text: string = '';
  private chunks: string[] = [];
  private currentChunkIndex: number = 0;
  private currentPosition: number = 0;
  private playing: boolean = false;
  private paused: boolean = false;
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private rate: number = 1.0;
  private engine: TTSEngine = 'system';
  private googleVoiceName: string = '';
  private googleLangCode: string = 'en-US';
  private aborted = false;

  onProgress?: (charOffset: number) => void;
  onEnd?: () => void;
  onStateChange?: () => void;

  constructor() {
    this.synth = window.speechSynthesis;
    // Only restore saved voice if it's a full API name (contains a dash), not a bare name
    const saved = getSavedVoiceName() || '';
    this.googleVoiceName = saved.includes('-') ? saved : '';
    this.googleLangCode = getSavedLanguageCode() || 'en-US';
  }

  private bookTitle: string = '';

  setBookTitle(title: string): void {
    this.bookTitle = title;
  }

  setText(text: string): void {
    // Strip markers the same way the canvas renderer does: keep link text, drop URLs and control chars
    this.text = text
      .replace(/\x01[^\x02]*\x02([^\x03]*)\x03/g, '$1')
      .replace(/[\x01-\x05]/g, '');
    this.chunks = this.text
      .split(/\n\n+/)
      .map(c => c.trim())
      .filter(c => c.length > 0);
    this.currentChunkIndex = 0;
    this.currentPosition = 0;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth.getVoices();
  }

  setVoice(voice: SpeechSynthesisVoice): void {
    this.selectedVoice = voice;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.0, rate));
  }

  getRate(): number {
    return this.rate;
  }

  setEngine(engine: TTSEngine): void {
    this.engine = engine;
  }

  getEngine(): TTSEngine {
    return this.engine;
  }

  setGoogleVoice(voiceName: string, langCode: string): void {
    this.googleVoiceName = voiceName;
    this.googleLangCode = langCode;
  }

  play(): void {
    if (this.paused && this.playing) {
      if (this.engine === 'system') {
        this.synth.resume();
      }
      this.paused = false;
      this.onStateChange?.();
      return;
    }

    if (this.playing) return;
    if (this.chunks.length === 0) return;

    this.playing = true;
    this.paused = false;
    this.aborted = false;
    this.onStateChange?.();

    // Media Session API for background audio control
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.bookTitle || 'Reading',
        artist: 'Ebook Reader',
      });
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
    }

    if (this.engine === 'google' && isGoogleTTSConfigured()) {
      this.speakGoogle();
    } else {
      this.speakSystemChunk();
    }
  }

  pause(): void {
    if (!this.playing) return;
    if (this.engine === 'system') {
      this.synth.pause();
    } else {
      googlePausePlayback();
    }
    this.paused = true;
    this.onStateChange?.();
  }

  stop(): void {
    this.aborted = true;
    this.synth.cancel();
    googleStopPlayback();
    this.playing = false;
    this.paused = false;
    this.currentChunkIndex = 0;
    this.currentPosition = 0;
    this.utterance = null;
    this.onStateChange?.();
  }

  isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  seekToOffset(charOffset: number): void {
    let accumulated = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (accumulated + this.chunks[i].length >= charOffset) {
        this.currentChunkIndex = i;
        this.currentPosition = accumulated;
        break;
      }
      accumulated += this.chunks[i].length + 2;
    }
  }

  // ── System TTS ──

  private speakSystemChunk(): void {
    if (this.currentChunkIndex >= this.chunks.length || this.aborted) {
      this.playing = false;
      this.paused = false;
      this.onEnd?.();
      this.onStateChange?.();
      return;
    }

    const chunkText = this.chunks[this.currentChunkIndex];
    const utt = new SpeechSynthesisUtterance(chunkText);
    if (this.selectedVoice) utt.voice = this.selectedVoice;
    utt.rate = this.rate;

    utt.onboundary = (event) => {
      if (event.name === 'word') {
        this.onProgress?.(this.currentPosition + event.charIndex);
      }
    };

    utt.onend = () => {
      if (!this.playing || this.aborted) return;
      this.currentPosition += chunkText.length + 2;
      this.currentChunkIndex++;
      this.speakSystemChunk();
    };

    utt.onerror = (event) => {
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        console.warn('[voice-reader] Speech error:', event.error);
        if (this.playing && !this.aborted) {
          this.currentPosition += chunkText.length + 2;
          this.currentChunkIndex++;
          this.speakSystemChunk();
        }
      }
    };

    this.utterance = utt;
    this.synth.speak(utt);
  }

  // ── Google Cloud TTS ──

  private async speakGoogle(): Promise<void> {
    const voiceName = this.googleVoiceName || getSavedVoiceName() || '';
    const langCode = this.googleLangCode || getSavedLanguageCode() || 'en-US';

    if (!voiceName) {
      console.warn('[voice-reader] No Google voice selected, falling back to system');
      this.speakSystemChunk();
      return;
    }

    while (this.currentChunkIndex < this.chunks.length && !this.aborted) {
      if (this.paused) {
        await new Promise<void>(resolve => {
          const check = () => {
            if (!this.paused || this.aborted) { resolve(); return; }
            setTimeout(check, 100);
          };
          check();
        });
        if (this.aborted) break;
      }

      const chunkText = this.chunks[this.currentChunkIndex];
      const chunkStart = this.currentPosition;
      this.onProgress?.(chunkStart);

      // Pre-fetch the next chunk while this one plays
      const nextChunk = this.currentChunkIndex + 1 < this.chunks.length
        ? this.chunks[this.currentChunkIndex + 1] : null;
      if (nextChunk) {
        googlePrefetch(nextChunk, voiceName, langCode, this.rate);
      }

      try {
        await googleSpeakChunk(chunkText, voiceName, langCode, this.rate, (charOffset) => {
          this.onProgress?.(chunkStart + charOffset);
        });
      } catch (err) {
        console.warn('[voice-reader] Google TTS error, falling back to system:', err);
        this.engine = 'system';
        this.onStateChange?.();
        this.speakSystemChunk();
        return;
      }

      if (this.aborted) break;

      this.currentPosition += chunkText.length + 2;
      this.currentChunkIndex++;
    }

    if (!this.aborted) {
      this.playing = false;
      this.paused = false;
      this.onEnd?.();
      this.onStateChange?.();
    }
  }

  /** Speak a short preview sentence using current engine/voice settings */
  preview(): void {
    const previewText = 'The quick brown fox jumps over the lazy dog';
    if (this.engine === 'google' && isGoogleTTSConfigured()) {
      const voiceName = this.googleVoiceName || getSavedVoiceName() || '';
      const langCode = this.googleLangCode || getSavedLanguageCode() || 'en-US';
      if (voiceName) {
        googleSpeakChunk(previewText, voiceName, langCode, this.rate).catch(() => {});
      }
    } else {
      this.synth.cancel();
      const utt = new SpeechSynthesisUtterance(previewText);
      if (this.selectedVoice) utt.voice = this.selectedVoice;
      utt.rate = this.rate;
      this.synth.speak(utt);
    }
  }

  destroy(): void {
    this.stop();
  }
}
