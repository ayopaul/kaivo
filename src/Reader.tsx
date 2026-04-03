import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CanvasRenderer, RenderMode } from './canvas-renderer';
import { BookData, TocEntry } from './pdf-extractor';
import { isSignedIn, syncBookProgress, loadBookProgress, GoogleUserProfile } from './google-drive';
import { saveLibraryEntry } from './library-storage';
import { VoiceReader, TTSEngine } from './voice-reader';
import * as GoogleTTS from './google-tts';

interface BookmarkEntry {
  position: number;
  label: string;
  timestamp: number;
  contextText?: string;
}

// ── Storage helpers ──

function saveProgress(key: string, progress: number) {
  try { localStorage.setItem(`${key}:progress`, String(progress)); } catch { /* */ }
}
function loadProgress(key: string): number | null {
  const val = localStorage.getItem(`${key}:progress`);
  return val !== null ? parseFloat(val) : null;
}
function saveBookmarks(key: string, bookmarks: BookmarkEntry[]) {
  try { localStorage.setItem(`${key}:bookmarks`, JSON.stringify(bookmarks)); } catch { /* */ }
}
function loadBookmarks(key: string): BookmarkEntry[] {
  try {
    const val = localStorage.getItem(`${key}:bookmarks`);
    return val ? JSON.parse(val) : [];
  } catch { return []; }
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleString('default', { month: 'short' });
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${hour}:${min}`;
}

// Font settings persistence
function loadFontFamily(): string {
  try { return localStorage.getItem('ebook:settings:fontFamily') || "'Playfair Display', Georgia, serif"; } catch { return "'Playfair Display', Georgia, serif"; }
}
function saveFontFamily(family: string) {
  try { localStorage.setItem('ebook:settings:fontFamily', family); } catch { /* */ }
}
function loadFontWeight(): number {
  try { return parseInt(localStorage.getItem('ebook:settings:fontWeight') || '400', 10); } catch { return 400; }
}
function saveFontWeight(weight: number) {
  try { localStorage.setItem('ebook:settings:fontWeight', String(weight)); } catch { /* */ }
}
type Theme = 'dark' | 'light';
function loadTheme(): Theme {
  try { return (localStorage.getItem('ebook:settings:theme') as Theme) || 'dark'; } catch { return 'dark'; }
}
function saveTheme(theme: Theme) {
  try { localStorage.setItem('ebook:settings:theme', theme); } catch { /* */ }
}

const FONT_OPTIONS = [
  { label: 'Playfair Display', value: "'Playfair Display', Georgia, serif" },
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Lora', value: "'Lora', Georgia, serif" },
  { label: 'Merriweather', value: "'Merriweather', Georgia, serif" },
  { label: 'Georgia', value: "Georgia, 'Times New Roman', serif" },
  { label: 'OpenDyslexic', value: "'OpenDyslexic', sans-serif" },
];

// ── Reader Component ──

interface ReaderProps {
  bookData: BookData;
  fileKey: string;
  onBack: () => void;
  cloudEnabled: boolean;
  userProfile?: GoogleUserProfile | null;
}

const Reader: React.FC<ReaderProps> = ({ bookData, fileKey, onBack, cloudEnabled, userProfile }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);

  const [currentMode, setCurrentMode] = useState<RenderMode>('combined');
  const [bionicEnabled, setBionicEnabled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => loadBookmarks(fileKey));
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Bottom bar auto-hide
  const [bottomBarVisible, setBottomBarVisible] = useState(true);

  // Theme
  const [theme, setTheme] = useState<Theme>(loadTheme);

  // Font settings
  const [fontFamily, setFontFamily] = useState(loadFontFamily);
  const [fontWeight, setFontWeight] = useState(loadFontWeight);

  // Voice reader state
  const voiceReaderRef = useRef<VoiceReader | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState('');
  const [voiceRate, setVoiceRate] = useState(1.0);
  const [ttsEngine, setTtsEngine] = useState<TTSEngine>(GoogleTTS.isConfigured() ? 'google' : 'system');
  const [googleApiKey, setGoogleApiKey] = useState(GoogleTTS.getApiKey() || '');
  const [googleVoices, setGoogleVoices] = useState<GoogleTTS.GoogleVoice[]>([]);
  const [selectedGoogleVoice, setSelectedGoogleVoice] = useState(GoogleTTS.getSavedVoiceName() || '');

  const bookmarkBtnRef = useRef<HTMLButtonElement>(null);
  const bookmarkPanelRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const tocBtnRef = useRef<HTMLButtonElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const lastSaveTimeRef = useRef(0);
  const lastCloudSyncRef = useRef(0);

  // Initialize voice reader
  useEffect(() => {
    const vr = new VoiceReader();
    voiceReaderRef.current = vr;
    vr.setBookTitle(bookData.title);
    if (GoogleTTS.isConfigured()) vr.setEngine('google');

    vr.onStateChange = () => {
      setVoicePlaying(vr.isPlaying());
    };

    vr.onEnd = () => {
      setVoicePlaying(false);
    };

    // Wire word highlighting
    vr.onProgress = (charOffset) => {
      rendererRef.current?.setHighlightedWord(charOffset);
    };

    // Load voices (may be async on some browsers)
    const loadVoices = () => {
      const available = vr.getVoices();
      if (available.length > 0) {
        setVoices(available);
        if (!vr['selectedVoice'] && available.length > 0) {
          const defaultVoice = available.find(v => v.default) || available.find(v => v.lang.startsWith('en')) || available[0];
          vr.setVoice(defaultVoice);
          setSelectedVoiceName(defaultVoice.name);
        }
      }
    };
    loadVoices();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    // Pre-load Google TTS voices
    if (GoogleTTS.isConfigured()) {
      GoogleTTS.getVoices('en').then(v => {
        setGoogleVoices(v);
        if (v.length > 0) {
          const saved = GoogleTTS.getSavedVoiceName();
          // Try exact match, then fuzzy match (bare name → full API name), then default to Algieba
          let voice = saved ? v.find(x => x.name === saved) : null;
          if (!voice && saved) voice = v.find(x => x.name.toLowerCase().includes(saved.toLowerCase()));
          if (!voice) voice = v.find(x => /Algenib/i.test(x.name));
          if (!voice) voice = v[0];

          setSelectedGoogleVoice(voice.name);
          GoogleTTS.saveVoiceName(voice.name);
          GoogleTTS.saveLanguageCode(voice.languageCodes[0]);
          vr.setGoogleVoice(voice.name, voice.languageCodes[0]);
        }
      }).catch(() => {});
    }

    return () => {
      vr.destroy();
      voiceReaderRef.current = null;
    };
  }, []);

  // Set text when bookData changes
  useEffect(() => {
    voiceReaderRef.current?.setText(bookData.allText);
  }, [bookData.allText]);

  // Initialize canvas renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;

    renderer.setMode(currentMode);
    renderer.setBionic(bionicEnabled);
    renderer.setFontFamily(fontFamily);
    renderer.setFontWeight(fontWeight);

    // When user clicks a link, save position for "back" navigation (only on first jump)
    renderer.onLinkClick = (_href, fromProgress) => {
      if (readingPositionRef.current === null) {
        setReadingPosition(fromProgress);
      }
    };

    // When user taps a word, seek voice reader to that position
    renderer.onCursorChange = (charOffset) => {
      const vr = voiceReaderRef.current;
      if (!vr) return;
      // Only seek if not currently playing — don't interrupt active playback
      if (!vr.isPlaying() && !vr.isPaused()) {
        vr.seekToOffset(charOffset);
      }
    };

    requestAnimationFrame(async () => {
      renderer.resize();
      renderer.setContent(
        bookData.allText,
        bookData.pageImages.length > 0 ? bookData.pageImages : undefined
      );

      let bm = loadBookmarks(fileKey);
      renderer.setBookmarks(bm.map(b => b.position));

      let savedProgress = loadProgress(fileKey);
      if (cloudEnabled && isSignedIn()) {
        try {
          const cloudData = await loadBookProgress(fileKey);
          if (cloudData) {
            const localLastRead = savedProgress !== null ? Date.now() : 0;
            if (cloudData.lastRead > localLastRead) {
              savedProgress = cloudData.progress;
              if (cloudData.bookmarks.length > 0) {
                bm = cloudData.bookmarks;
                saveBookmarks(fileKey, bm);
                renderer.setBookmarks(bm.map(b => b.position));
              }
            }
          }
        } catch { /* use local */ }
      }

      if (savedProgress !== null && savedProgress > 0.01 && savedProgress < 0.999) {
        renderer.setScrollProgress(savedProgress);
      }

      // Save to library (local + cloud)
      const prog = savedProgress || 0;
      saveLibraryEntry(fileKey, bookData.title, bookData.fileType, prog);
      if (cloudEnabled && isSignedIn()) {
        syncBookProgress(fileKey, bookData.title, prog, loadBookmarks(fileKey), bookData.fileType);
      }
    });

    renderer.onProgress = (prog, direction) => {
      setProgress(prog);

      // Bottom bar auto-hide
      setBottomBarVisible(direction === 'up' || prog < 0.01 || prog > 0.99);

      const now = Date.now();
      if (now - lastSaveTimeRef.current > 500 && prog < 0.999) {
        saveProgress(fileKey, prog);
        saveLibraryEntry(fileKey, bookData.title, bookData.fileType, prog);
        lastSaveTimeRef.current = now;
      }
      if (cloudEnabled && isSignedIn() && now - lastCloudSyncRef.current > 10000) {
        lastCloudSyncRef.current = now;
        syncBookProgress(fileKey, bookData.title, prog, loadBookmarks(fileKey), bookData.fileType);
      }
    };

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [bookData, fileKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { rendererRef.current?.setMode(currentMode); }, [currentMode]);

  useEffect(() => {
    rendererRef.current?.setBionic(bionicEnabled);
  }, [bionicEnabled]);

  useEffect(() => {
    rendererRef.current?.setBookmarks(bookmarks.map(b => b.position));
  }, [bookmarks]);

  useEffect(() => {
    rendererRef.current?.setFontFamily(fontFamily);
    saveFontFamily(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    rendererRef.current?.setFontWeight(fontWeight);
    saveFontWeight(fontWeight);
  }, [fontWeight]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    saveTheme(theme);
    // Update canvas text color
    rendererRef.current?.setTextColor(
      theme === 'light' ? '#2c1e0e' : '#e8e8e8'
    );
  }, [theme]);

  // Close panels when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (bookmarkPanelOpen && bookmarkBtnRef.current && bookmarkPanelRef.current &&
        !bookmarkBtnRef.current.contains(e.target as Node) &&
        !bookmarkPanelRef.current.contains(e.target as Node)) {
        setBookmarkPanelOpen(false);
      }
      if (tocOpen && tocBtnRef.current && tocPanelRef.current &&
        !tocBtnRef.current.contains(e.target as Node) &&
        !tocPanelRef.current.contains(e.target as Node)) {
        setTocOpen(false);
      }
      if (settingsOpen && settingsBtnRef.current && settingsPanelRef.current &&
        !settingsBtnRef.current.contains(e.target as Node) &&
        !settingsPanelRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [bookmarkPanelOpen, tocOpen, settingsOpen]);

  // Scroll hint
  const hintRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const hint = hintRef.current;
    if (!canvas || !hint) return;
    const hideHint = () => { hint.style.opacity = '0'; hint.style.transition = 'opacity 0.5s'; };
    canvas.addEventListener('wheel', hideHint, { once: true });
    canvas.addEventListener('touchstart', hideHint, { once: true });
    return () => { canvas.removeEventListener('wheel', hideHint); canvas.removeEventListener('touchstart', hideHint); };
  }, []);

  // ── Handlers ──

  const handleBack = useCallback(() => {
    const renderer = rendererRef.current;
    if (renderer) {
      const prog = renderer.getProgress();
      saveProgress(fileKey, prog);
      saveLibraryEntry(fileKey, bookData.title, bookData.fileType, prog);
      if (cloudEnabled && isSignedIn()) {
        syncBookProgress(fileKey, bookData.title, prog, loadBookmarks(fileKey), bookData.fileType);
      }
    }
    voiceReaderRef.current?.stop();
    onBack();
  }, [fileKey, onBack, cloudEnabled, bookData.title, bookData.fileType]);

  const handleCloudSync = useCallback(async () => {
    if (!cloudEnabled || !isSignedIn()) return;
    setCloudSyncing(true);
    try {
      const prog = rendererRef.current?.getProgress() ?? 0;
      await syncBookProgress(fileKey, bookData.title, prog, loadBookmarks(fileKey), bookData.fileType);
    } finally { setTimeout(() => setCloudSyncing(false), 500); }
  }, [cloudEnabled, fileKey, bookData.title]);

  const handleModeChange = useCallback((mode: RenderMode) => setCurrentMode(mode), []);
  const handleBionicChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setBionicEnabled(e.target.checked), []);

  const flashBookmarkBtn = useCallback((added: boolean) => {
    const btn = bookmarkBtnRef.current;
    if (!btn) return;
    btn.classList.add(added ? 'flash-add' : 'flash-remove');
    setTimeout(() => btn.classList.remove('flash-add', 'flash-remove'), 400);
  }, []);

  /** Extract ~40 chars of context text near the given progress position */
  const getContextText = useCallback((position: number): string => {
    const text = bookData.allText.replace(/[\x01-\x05]/g, '');
    const charIdx = Math.floor(position * text.length);
    const start = Math.max(0, charIdx - 20);
    const end = Math.min(text.length, charIdx + 20);
    let ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) ctx = '...' + ctx;
    if (end < text.length) ctx = ctx + '...';
    return ctx;
  }, [bookData.allText]);

  const handleBookmarkClick = useCallback(() => {
    setBookmarkPanelOpen(prev => !prev);
    setSettingsOpen(false);
    setTocOpen(false);
  }, []);

  const handleBookmarkAdd = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const position = renderer.getProgress();
    const pct = Math.round(position * 100);
    const current = loadBookmarks(fileKey);
    const isDuplicate = current.some(b => Math.abs(b.position - position) < 0.01);
    if (isDuplicate) {
      const filtered = current.filter(b => Math.abs(b.position - position) >= 0.01);
      saveBookmarks(fileKey, filtered);
      setBookmarks(filtered);
      flashBookmarkBtn(false);
      return;
    }
    const contextText = getContextText(position);
    const entry: BookmarkEntry = { position, label: `${pct}%`, timestamp: Date.now(), contextText };
    const updated = [...current, entry].sort((a, b) => a.position - b.position);
    saveBookmarks(fileKey, updated);
    setBookmarks(updated);
    flashBookmarkBtn(true);
    if (cloudEnabled && isSignedIn()) syncBookProgress(fileKey, bookData.title, position, updated, bookData.fileType);
  }, [fileKey, flashBookmarkBtn, cloudEnabled, bookData.title, getContextText]);

  const [readingPosition, setReadingPosition] = useState<number | null>(null);
  const readingPositionRef = useRef<number | null>(null);
  // Keep ref in sync with state
  readingPositionRef.current = readingPosition;

  const handleBookmarkContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); setBookmarkPanelOpen(prev => !prev); }, []);
  const handleBookmarkNavigate = useCallback((position: number) => {
    // Only save the original reading position on the first jump
    if (readingPosition === null) {
      const currentPos = rendererRef.current?.getProgress() ?? null;
      if (currentPos !== null && Math.abs(currentPos - position) > 0.01) {
        setReadingPosition(currentPos);
      }
    }
    rendererRef.current?.setScrollProgress(position);
    setBookmarkPanelOpen(false);
  }, [readingPosition]);
  const handleReturnToReading = useCallback(() => {
    if (readingPosition !== null) {
      rendererRef.current?.setScrollProgress(readingPosition);
      setReadingPosition(null);
      setBookmarkPanelOpen(false);
    }
  }, [readingPosition]);
  const handleBookmarkDelete = useCallback((index: number) => {
    const current = loadBookmarks(fileKey);
    current.splice(index, 1);
    saveBookmarks(fileKey, current);
    setBookmarks([...current]);
    if (cloudEnabled && isSignedIn()) {
      const prog = rendererRef.current?.getProgress() ?? 0;
      syncBookProgress(fileKey, bookData.title, prog, current, bookData.fileType);
    }
  }, [fileKey, cloudEnabled, bookData.title]);

  const handleTocNavigate = useCallback((position: number) => {
    rendererRef.current?.setScrollProgress(position);
    setTocOpen(false);
  }, []);

  // Voice reader handlers
  const handleVoicePlayPause = useCallback(() => {
    const vr = voiceReaderRef.current;
    if (!vr) return;

    if (vr.isPlaying()) {
      vr.pause();
    } else if (vr.isPaused()) {
      // Resume from where we are now (current scroll position)
      const renderer = rendererRef.current;
      const currentProgress = renderer?.getProgress() ?? progress;
      const charOffset = Math.floor(currentProgress * bookData.allText.length);
      vr.stop();
      vr.seekToOffset(charOffset);
      vr.play();
    } else {
      // Start fresh from current visible position
      const renderer = rendererRef.current;
      const currentProgress = renderer?.getProgress() ?? progress;
      const charOffset = Math.floor(currentProgress * bookData.allText.length);
      vr.seekToOffset(charOffset);
      vr.play();
    }
  }, [progress, bookData.allText]);

  const handleVoiceSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const vr = voiceReaderRef.current;
    if (!vr) return;
    const voice = voices.find(v => v.name === e.target.value);
    if (voice) {
      vr.setVoice(voice);
      setSelectedVoiceName(voice.name);
      if (vr.isPlaying() || vr.isPaused()) {
        const wasPlaying = vr.isPlaying();
        vr.stop();
        rendererRef.current?.setHighlightedWord(null);
        if (wasPlaying) {
          const charOffset = Math.floor(progress * bookData.allText.length);
          vr.seekToOffset(charOffset);
          vr.play();
        }
      }
    }
  }, [voices, progress, bookData.allText]);

  const handleVoiceRateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rate = parseFloat(e.target.value);
    setVoiceRate(rate);
    voiceReaderRef.current?.setRate(rate);
  }, []);

  const handleEngineChange = useCallback((engine: TTSEngine) => {
    setTtsEngine(engine);
    voiceReaderRef.current?.setEngine(engine);
  }, []);

  const handleGoogleApiKeySave = useCallback(async () => {
    GoogleTTS.setApiKey(googleApiKey);
    try {
      const v = await GoogleTTS.getVoices('en');
      setGoogleVoices(v);
      if (v.length > 0 && !selectedGoogleVoice) {
        const best = v[0];
        setSelectedGoogleVoice(best.name);
        GoogleTTS.saveVoiceName(best.name);
        GoogleTTS.saveLanguageCode(best.languageCodes[0]);
        voiceReaderRef.current?.setGoogleVoice(best.name, best.languageCodes[0]);
      }
    } catch (err: any) {
      alert(`Invalid API key: ${err.message}`);
    }
  }, [googleApiKey, selectedGoogleVoice]);

  const handleGoogleVoiceSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    setSelectedGoogleVoice(name);
    GoogleTTS.saveVoiceName(name);
    const voice = googleVoices.find(v => v.name === name);
    if (voice) {
      GoogleTTS.saveLanguageCode(voice.languageCodes[0]);
      voiceReaderRef.current?.setGoogleVoice(name, voice.languageCodes[0]);
    }
  }, [googleVoices]);

  const handleVoicePreview = useCallback(() => {
    voiceReaderRef.current?.preview();
  }, []);

  // ── Render ──

  const pct = Math.round(progress * 100);
  const modes: { key: RenderMode; label: string }[] = [
    { key: 'pinch', label: 'Pinch' },
    { key: 'scroll-morph', label: 'Scroll Morph' },
    { key: 'combined', label: 'Combined' },
  ];

  const hasToc = bookData.toc && bookData.toc.length > 0;

  return (
    <div className="reader">
      {/* Simplified top header: back + title only */}
      <div className="reader-header">
        <div className="reader-header-row1">
          <div className="reader-header-left">
            <button className="reader-back" onClick={handleBack}>&larr;</button>
            <span className="reader-title">{bookData.title}</span>
          </div>
          {cloudEnabled && userProfile?.picture && (
            <img className="reader-profile-pic" src={userProfile.picture} alt="" referrerPolicy="no-referrer" />
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="reader-canvas-wrap">
        <canvas ref={canvasRef}></canvas>
        <div className="scroll-hint" ref={hintRef}>Scroll to read &middot; Pinch to zoom</div>
        {readingPosition !== null && (
          <button className="back-to-reading-fab" onClick={handleReturnToReading}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8h10M3 8l4-4M3 8l4 4"/>
            </svg>
            Back to {Math.round(readingPosition * 100)}%
          </button>
        )}
      </div>

      {/* Bottom bar */}
      <div className={`reader-bottom-bar${bottomBarVisible ? '' : ' hidden'}`}>
        {/* Progress bar at very top of bottom bar */}
        <div className="bottom-progress-bar">
          <div className="bottom-progress-fill" style={{ width: `${pct}%` }}></div>
          <div className="progress-bar-bookmarks">
            {bookmarks.map((b, i) => (
              <div key={i} className="progress-bookmark-dot" style={{ left: `${b.position * 100}%` }}></div>
            ))}
          </div>
        </div>

        <div className="bottom-bar-content">
          {/* Left: TOC button */}
          <div className="bottom-bar-left">
            {hasToc && (
              <div className="toc-group">
                <button
                  className={`toc-btn${tocOpen ? ' active' : ''}`}
                  ref={tocBtnRef}
                  onClick={() => { setTocOpen(prev => !prev); setSettingsOpen(false); setBookmarkPanelOpen(false); }}
                  title="Table of Contents"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <line x1="2" y1="4" x2="14" y2="4"/>
                    <line x1="2" y1="8" x2="10" y2="8"/>
                    <line x1="2" y1="12" x2="12" y2="12"/>
                  </svg>
                </button>
                <div className={`toc-panel${tocOpen ? ' open' : ''}`} ref={tocPanelRef}>
                  <div className="toc-panel-header">Table of Contents</div>
                  <div className="toc-list">
                    {bookData.toc.map((entry, i) => (
                      <div
                        key={i}
                        className="toc-item"
                        style={{ paddingLeft: `${0.8 + entry.level * 1}rem` }}
                        onClick={() => handleTocNavigate(entry.position)}
                      >
                        <span className="toc-item-title">{entry.title}</span>
                        <span className="toc-item-pos">{Math.round(entry.position * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Voice play/pause button */}
          <button
            className={`voice-play-btn${voicePlaying ? ' playing' : ''}`}
            onClick={handleVoicePlayPause}
            title={voicePlaying ? 'Pause reading' : 'Read aloud'}
          >
            {voicePlaying ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="2" width="4" height="12" rx="1" />
                <rect x="9" y="2" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2 L14 8 L4 14 Z" />
              </svg>
            )}
          </button>

          {/* Progress percentage */}
          <span className="bottom-bar-progress-label">{pct}%</span>

          {/* Bookmark button */}
          <div className="bookmark-group">
            <button className="bookmark-btn" ref={bookmarkBtnRef} title="Bookmarks"
              onClick={handleBookmarkClick}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 2h8a1 1 0 0 1 1 1v12l-5-3-5 3V3a1 1 0 0 1 1-1z"/>
              </svg>
            </button>
            <div className={`bookmark-panel${bookmarkPanelOpen ? ' open' : ''}`} ref={bookmarkPanelRef}>
              <div className="bookmark-panel-header">
                <span>Bookmarks</span>
                <div className="bookmark-panel-header-actions">
                  {readingPosition !== null && (
                    <button className="bookmark-return-btn" onClick={handleReturnToReading} title="Return to reading position">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 8h10M3 8l4-4M3 8l4 4"/>
                      </svg>
                      {Math.round(readingPosition * 100)}%
                    </button>
                  )}
                  <button className="bookmark-add-btn" onClick={handleBookmarkAdd} title="Bookmark this page">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div className="bookmark-list">
                {bookmarks.length === 0 ? (
                  <div className="bookmark-empty">No bookmarks yet.<br/>Click the bookmark icon to add one.</div>
                ) : (
                  bookmarks.map((b, i) => (
                    <div key={`${b.position}-${b.timestamp}`} className="bookmark-item" onClick={() => handleBookmarkNavigate(b.position)}>
                      <div className="bookmark-item-content">
                        <div className="bookmark-item-top">
                          <span className="bookmark-item-label">{Math.round(b.position * 100)}%</span>
                          <span className="bookmark-item-time">{formatTime(b.timestamp)}</span>
                        </div>
                        {b.contextText && (
                          <div className="bookmark-item-context">{b.contextText}</div>
                        )}
                      </div>
                      <button className="bookmark-item-delete" title="Remove"
                        onClick={(e) => { e.stopPropagation(); handleBookmarkDelete(i); }}>&times;</button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Settings gear button */}
          <div className="settings-group">
            <button
              className={`settings-btn${settingsOpen ? ' active' : ''}`}
              ref={settingsBtnRef}
              onClick={() => { setSettingsOpen(prev => !prev); setBookmarkPanelOpen(false); setTocOpen(false); }}
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            <div className={`settings-panel${settingsOpen ? ' open' : ''}`} ref={settingsPanelRef}>
              <div className="settings-panel-header">Settings</div>
              <div className="settings-panel-body">
                {/* ── Voice Section ── */}
                <div className="settings-section">
                  <div className="settings-section-title">Voice</div>
                  <div className="settings-row">
                    <select className="voice-select" value={selectedGoogleVoice} onChange={handleGoogleVoiceSelect}>
                      {googleVoices.some(v => v.isChirp3) && (
                        <optgroup label="Chirp 3: HD">
                          {googleVoices.filter(v => v.isChirp3).map(v => (
                            <option key={v.name} value={v.name}>{v.displayName || v.name}</option>
                          ))}
                        </optgroup>
                      )}
                      {googleVoices.some(v => !v.isChirp3) && (
                        <optgroup label="Legacy">
                          {googleVoices.filter(v => !v.isChirp3).map(v => {
                            const parts = v.name.split('-');
                            const type = parts[2] || '';
                            const variant = parts[3] || '';
                            return (
                              <option key={v.name} value={v.name}>
                                {`${type} ${variant}`.trim()} ({v.languageCodes[0]})
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                    </select>
                    <button className="preview-btn" onClick={handleVoicePreview} title="Preview voice">Preview</button>
                  </div>

                  {/* Chirp voices don't support rate adjustment */}
                  {!googleVoices.find(v => v.name === selectedGoogleVoice)?.isChirp3 && (
                    <div className="settings-row">
                      <span className="voice-rate-label">{voiceRate.toFixed(1)}x</span>
                      <input type="range" className="voice-rate-slider" min="0.5" max="2.0" step="0.1" value={voiceRate} onChange={handleVoiceRateChange} />
                    </div>
                  )}
                </div>

                {/* ── Font Section ── */}
                <div className="settings-section">
                  <div className="settings-section-title">Font</div>
                  <div className="settings-row">
                    <select className="settings-select" value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
                      {FONT_OPTIONS.map(f => (
                        <option key={f.label} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">Weight</span>
                    <input type="range" className="settings-slider" min="300" max="700" step="100" value={fontWeight} onChange={(e) => setFontWeight(parseInt(e.target.value, 10))} />
                    <span className="settings-value">{fontWeight}</span>
                  </div>
                </div>

                {/* ── Account Section ── */}
                {cloudEnabled && userProfile && (
                  <div className="settings-section">
                    <div className="settings-section-title">Account</div>
                    <div className="settings-account-row">
                      {userProfile.picture && (
                        <img className="settings-profile-pic" src={userProfile.picture} alt="" referrerPolicy="no-referrer" />
                      )}
                      <div className="settings-profile-info">
                        <span className="settings-profile-name">{userProfile.name}</span>
                        <span className="settings-profile-email">{userProfile.email}</span>
                      </div>
                      <button className={`settings-sync-btn${cloudSyncing ? ' syncing' : ''}`} onClick={handleCloudSync} title="Sync now">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/>
                          <path d="M2.5 11.5a10 10 0 0 1 16.5-5.5L21.5 8"/>
                          <path d="M21.5 12.5a10 10 0 0 1-16.5 5.5L2.5 16"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Display Section ── */}
                <div className="settings-section">
                  <div className="settings-section-title">Display</div>
                  <div className="settings-row">
                    <div className="theme-tabs">
                      <button className={`theme-tab${theme === 'dark' ? ' active' : ''}`} onClick={() => setTheme('dark')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                        Dark
                      </button>
                      <button className={`theme-tab${theme === 'light' ? ' active' : ''}`} onClick={() => setTheme('light')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                        </svg>
                        Light
                      </button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <div className="mode-tabs">
                      {modes.map(m => (
                        <button
                          key={m.key}
                          className={`mode-tab${currentMode === m.key ? ' active' : ''}`}
                          onClick={() => handleModeChange(m.key)}
                        >{m.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row">
                    <label className="bionic-toggle">
                      <span className="bionic-label">Bionic Reading</span>
                      <input type="checkbox" checked={bionicEnabled} onChange={handleBionicChange} />
                      <span className="bionic-slider"></span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default Reader;
