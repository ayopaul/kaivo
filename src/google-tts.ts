/**
 * Google Cloud Text-to-Speech integration.
 *
 * Uses the v1beta1 API to access Chirp 3: HD voices (constellation-named voices
 * like Kore, Puck, Fenrir, etc.) alongside legacy Neural2/WaveNet/Studio voices.
 *
 * Chirp 3: HD voice name format: "en-US-Chirp3-HD-Kore"
 * Chirp 3: HD voices do NOT support speakingRate — it's ignored.
 *
 * Setup:
 * 1. Go to console.cloud.google.com (same project as Drive)
 * 2. Enable "Cloud Text-to-Speech API"
 * 3. Go to Credentials → Create API Key
 * 4. Enter the API key in the voice settings
 */

const API_BASE = 'https://texttospeech.googleapis.com/v1beta1';
const DEFAULT_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_TTS_API_KEY || '';

let apiKey: string | null = null;

export function setApiKey(key: string) {
  apiKey = key;
  try { localStorage.setItem('google-tts:apiKey', key); } catch { /* */ }
}

export function getApiKey(): string | null {
  if (apiKey) return apiKey;
  try { apiKey = localStorage.getItem('google-tts:apiKey'); } catch { /* */ }
  return apiKey || DEFAULT_API_KEY;
}

export function isConfigured(): boolean {
  const key = getApiKey();
  return !!key && key.length > 10;
}

export interface GoogleVoice {
  name: string;          // Full API name, e.g. "en-US-Chirp3-HD-Kore" or "en-US-Neural2-A"
  languageCodes: string[];
  ssmlGender: string;
  naturalSampleRateHertz: number;
  isChirp3?: boolean;
  displayName?: string;  // Friendly label for Chirp 3 voices
}

/** Extract the friendly name from a Chirp voice name */
function chirpDisplayName(apiName: string): string | null {
  // e.g. "en-US-Chirp3-HD-Kore" → "Kore", "en-US-Chirp-HD-D" → "Chirp D"
  const m3 = apiName.match(/Chirp3-HD-(\w+)$/i);
  if (m3) return m3[1];
  const m1 = apiName.match(/Chirp-HD-(\w+)$/i);
  if (m1) return `Chirp ${m1[1]}`;
  return null;
}

/** Fetch available voices — returns Chirp 3: HD voices first, then legacy HD voices */
export async function getVoices(languageCode?: string): Promise<GoogleVoice[]> {
  const key = getApiKey();
  if (!key) throw new Error('Google TTS API key not set');

  const url = languageCode
    ? `${API_BASE}/voices?languageCode=${languageCode}&key=${key}`
    : `${API_BASE}/voices?key=${key}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch voices (${res.status})`);

  const data = await res.json();
  const allVoices: GoogleVoice[] = data.voices || [];

  const chirp3: GoogleVoice[] = [];
  const legacy: GoogleVoice[] = [];

  const seenChirp = new Set<string>();
  for (const v of allVoices) {
    const friendly = chirpDisplayName(v.name);
    if (friendly) {
      // Only keep en-US variants to avoid duplicates (en-AU, en-GB, en-IN)
      if (!v.name.startsWith('en-US-')) continue;
      if (seenChirp.has(friendly)) continue;
      seenChirp.add(friendly);
      chirp3.push({ ...v, isChirp3: true, displayName: friendly });
    } else if (/Neural2|Wavenet|Studio|Journey/i.test(v.name)) {
      legacy.push(v);
    }
  }

  // Sort Chirp 3 alphabetically by display name
  chirp3.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

  // Sort legacy: Studio > Journey > Neural2 > WaveNet
  legacy.sort((a, b) => {
    const score = (n: string) =>
      n.includes('Studio') ? 4 : n.includes('Journey') ? 3 : n.includes('Neural2') ? 2 : n.includes('Wavenet') ? 1 : 0;
    return score(b.name) - score(a.name);
  });

  return [...chirp3, ...legacy];
}

/** Check if a voice name is a Chirp HD voice (no speakingRate support) */
function isChirpVoice(voiceName: string): boolean {
  return /Chirp/i.test(voiceName);
}

/** Synthesize speech, returns an audio Blob (MP3) */
export async function synthesize(
  text: string,
  voiceName: string,
  languageCode: string,
  speakingRate: number = 1.0
): Promise<Blob> {
  const key = getApiKey();
  if (!key) throw new Error('Google TTS API key not set');

  const chirp3 = isChirpVoice(voiceName);

  const body: any = {
    input: { text },
    voice: {
      languageCode,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'MP3',
    },
  };

  // Chirp 3: HD does NOT support speakingRate
  if (!chirp3) {
    body.audioConfig.speakingRate = Math.max(0.25, Math.min(4.0, speakingRate));
  }

  const res = await fetch(`${API_BASE}/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const audioBytes = atob(data.audioContent);
  const buffer = new Uint8Array(audioBytes.length);
  for (let i = 0; i < audioBytes.length; i++) {
    buffer[i] = audioBytes.charCodeAt(i);
  }
  return new Blob([buffer], { type: 'audio/mpeg' });
}

// ── Pre-fetch cache for gapless playback ──
const prefetchCache = new Map<string, Promise<Blob>>();

function cacheKey(text: string): string {
  // Use first 100 chars + length for uniqueness
  return text.slice(0, 100) + ':' + text.length;
}

/** Pre-fetch audio for a chunk (including split parts) so it's ready when needed */
export function prefetch(text: string, voiceName: string, languageCode: string, rate: number = 1.0): void {
  const maxLen = 4500;
  const parts = text.length > maxLen ? splitText(text, maxLen) : [text];

  for (const part of parts) {
    const key = cacheKey(part);
    if (prefetchCache.has(key)) continue;
    const promise = synthesize(part, voiceName, languageCode, rate);
    prefetchCache.set(key, promise);
    promise.then(() => setTimeout(() => prefetchCache.delete(key), 90000)).catch(() => prefetchCache.delete(key));
  }
}

/** Get a cached blob or synthesize fresh */
async function synthesizeWithCache(text: string, voiceName: string, languageCode: string, rate: number): Promise<Blob> {
  const key = cacheKey(text);
  const cached = prefetchCache.get(key);
  if (cached) {
    prefetchCache.delete(key);
    return cached;
  }
  return synthesize(text, voiceName, languageCode, rate);
}

/** Reusable audio element to maintain user-gesture autoplay permission */
let sharedAudio: HTMLAudioElement | null = null;
let wordProgressTimer: number | null = null;
let abortResolve: (() => void) | null = null; // resolves the current speakChunk promise on stop

function getAudio(): HTMLAudioElement {
  if (!sharedAudio) sharedAudio = new Audio();
  return sharedAudio;
}

/** Pause current Google TTS audio */
export function pausePlayback(): void {
  if (sharedAudio && !sharedAudio.paused) {
    sharedAudio.pause();
  }
}

/** Stop current Google TTS playback immediately */
export function stopPlayback(): void {
  if (wordProgressTimer !== null) {
    clearInterval(wordProgressTimer);
    wordProgressTimer = null;
  }
  if (sharedAudio) {
    sharedAudio.pause();
    sharedAudio.onended = null;
    sharedAudio.onerror = null;
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
  }
  // Unblock any pending speakChunk promise
  if (abortResolve) {
    abortResolve();
    abortResolve = null;
  }
}

/** Synthesize and play a chunk of text. Returns a promise that resolves when playback ends.
 *  onWordProgress is called periodically with the estimated character offset within this chunk. */
export async function speakChunk(
  text: string,
  voiceName: string,
  languageCode: string,
  rate: number = 1.0,
  onWordProgress?: (charOffset: number) => void
): Promise<void> {
  // Google TTS has a 5000 byte limit per request — split long text
  const maxLen = 4500;
  const parts = text.length > maxLen ? splitText(text, maxLen) : [text];

  let partOffset = 0;
  let aborted = false;

  for (const part of parts) {
    if (aborted) break;

    const blob = await synthesizeWithCache(part, voiceName, languageCode, rate);
    if (aborted) break;

    const url = URL.createObjectURL(blob);
    const audio = getAudio();

    const offset = partOffset;
    await new Promise<void>((resolve, reject) => {
      // Register abort handler so stopPlayback() can unblock us
      abortResolve = () => { aborted = true; URL.revokeObjectURL(url); resolve(); };

      if (onWordProgress) {
        const wordBounds: number[] = [];
        const re = /\S+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(part)) !== null) wordBounds.push(m.index);

        if (wordProgressTimer !== null) clearInterval(wordProgressTimer);
        wordProgressTimer = window.setInterval(() => {
          if (!audio.duration || audio.paused) return;
          const frac = audio.currentTime / audio.duration;
          const charPos = Math.floor(frac * part.length);
          let wordIdx = 0;
          for (let i = wordBounds.length - 1; i >= 0; i--) {
            if (wordBounds[i] <= charPos) { wordIdx = wordBounds[i]; break; }
          }
          onWordProgress(offset + wordIdx);
        }, 120);
      }

      audio.onended = () => {
        if (wordProgressTimer !== null) { clearInterval(wordProgressTimer); wordProgressTimer = null; }
        abortResolve = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => {
        if (wordProgressTimer !== null) { clearInterval(wordProgressTimer); wordProgressTimer = null; }
        abortResolve = null;
        URL.revokeObjectURL(url);
        reject(new Error('Playback failed'));
      };
      audio.src = url;
      audio.play().catch(reject);
    });

    partOffset += part.length;
  }
}

function splitText(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return parts;
}

// ── Saved preferences ──

export function getSavedVoiceName(): string | null {
  try { return localStorage.getItem('google-tts:voiceName'); } catch { return null; }
}

export function saveVoiceName(name: string) {
  try { localStorage.setItem('google-tts:voiceName', name); } catch { /* */ }
}

export function getSavedLanguageCode(): string | null {
  try { return localStorage.getItem('google-tts:langCode'); } catch { return null; }
}

export function saveLanguageCode(code: string) {
  try { localStorage.setItem('google-tts:langCode', code); } catch { /* */ }
}
