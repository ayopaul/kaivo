/**
 * Google Cloud Text-to-Speech integration.
 *
 * Setup:
 * 1. Go to console.cloud.google.com (same project as Drive)
 * 2. Enable "Cloud Text-to-Speech API"
 * 3. Go to Credentials → Create API Key
 * 4. Enter the API key in the voice settings
 *
 * Free tier: 1M standard chars/month, 1M WaveNet chars/month
 */

const API_BASE = 'https://texttospeech.googleapis.com/v1';
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
  return true; // Always configured with default key
}

export interface GoogleVoice {
  name: string;
  languageCodes: string[];
  ssmlGender: string;
  naturalSampleRateHertz: number;
}

/** Fetch available voices */
export async function getVoices(languageCode?: string): Promise<GoogleVoice[]> {
  const key = getApiKey();
  if (!key) throw new Error('Google TTS API key not set');

  const url = languageCode
    ? `${API_BASE}/voices?languageCode=${languageCode}&key=${key}`
    : `${API_BASE}/voices?key=${key}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch voices (${res.status})`);

  const data = await res.json();
  // Prioritize WaveNet and Neural2 voices (higher quality)
  return (data.voices || []).sort((a: any, b: any) => {
    const aScore = a.name.includes('Neural2') ? 2 : a.name.includes('Wavenet') ? 1 : 0;
    const bScore = b.name.includes('Neural2') ? 2 : b.name.includes('Wavenet') ? 1 : 0;
    return bScore - aScore;
  });
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

  const res = await fetch(`${API_BASE}/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: Math.max(0.25, Math.min(4.0, speakingRate)),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  // Response contains base64 encoded audio
  const audioBytes = atob(data.audioContent);
  const buffer = new Uint8Array(audioBytes.length);
  for (let i = 0; i < audioBytes.length; i++) {
    buffer[i] = audioBytes.charCodeAt(i);
  }
  return new Blob([buffer], { type: 'audio/mpeg' });
}

/** Synthesize and play a chunk of text. Returns a promise that resolves when playback ends. */
export async function speakChunk(
  text: string,
  voiceName: string,
  languageCode: string,
  rate: number = 1.0
): Promise<void> {
  // Google TTS has a 5000 byte limit per request — split long text
  const maxLen = 4500;
  const parts = text.length > maxLen ? splitText(text, maxLen) : [text];

  for (const part of parts) {
    const blob = await synthesize(part, voiceName, languageCode, rate);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Playback failed')); };
      audio.play().catch(reject);
    });
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
    // Split at last sentence boundary within maxLen
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
