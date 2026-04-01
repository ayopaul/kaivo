import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CanvasRenderer, RenderMode } from './canvas-renderer';
import { BookData, TocEntry } from './pdf-extractor';
import { isSignedIn, syncBookProgress, loadBookProgress } from './google-drive';
import { saveLibraryEntry } from './library-storage';
import { VoiceReader, TTSEngine } from './voice-reader';
import * as GoogleTTS from './google-tts';

interface BookmarkEntry {
  position: number;
  label: string;
  timestamp: number;
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

// ── Reader Component ──

interface ReaderProps {
  bookData: BookData;
  fileKey: string;
  onBack: () => void;
  cloudEnabled: boolean;
}

const Reader: React.FC<ReaderProps> = ({ bookData, fileKey, onBack, cloudEnabled }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);

  const [currentMode, setCurrentMode] = useState<RenderMode>('combined');
  const [bionicEnabled, setBionicEnabled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => loadBookmarks(fileKey));
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  // Voice reader state
  const voiceReaderRef = useRef<VoiceReader | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState('');
  const [voiceRate, setVoiceRate] = useState(1.0);
  const [ttsEngine, setTtsEngine] = useState<TTSEngine>('system');
  const [googleApiKey, setGoogleApiKey] = useState(GoogleTTS.getApiKey() || '');
  const [googleVoices, setGoogleVoices] = useState<GoogleTTS.GoogleVoice[]>([]);
  const [selectedGoogleVoice, setSelectedGoogleVoice] = useState(GoogleTTS.getSavedVoiceName() || '');

  const bookmarkBtnRef = useRef<HTMLButtonElement>(null);
  const bookmarkPanelRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const tocBtnRef = useRef<HTMLButtonElement>(null);
  const lastSaveTimeRef = useRef(0);
  const lastCloudSyncRef = useRef(0);

  // Initialize voice reader
  useEffect(() => {
    const vr = new VoiceReader();
    voiceReaderRef.current = vr;

    vr.onStateChange = () => {
      setVoicePlaying(vr.isPlaying());
    };

    vr.onEnd = () => {
      setVoicePlaying(false);
      setVoicePanelOpen(false);
    };

    // Load voices (may be async on some browsers)
    const loadVoices = () => {
      const available = vr.getVoices();
      if (available.length > 0) {
        setVoices(available);
        if (!vr['selectedVoice'] && available.length > 0) {
          // Pick default English voice if available
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
        if (v.length > 0 && !GoogleTTS.getSavedVoiceName()) {
          const best = v[0];
          setSelectedGoogleVoice(best.name);
          GoogleTTS.saveVoiceName(best.name);
          GoogleTTS.saveLanguageCode(best.languageCodes[0]);
          vr.setGoogleVoice(best.name, best.languageCodes[0]);
        } else if (GoogleTTS.getSavedVoiceName()) {
          const saved = GoogleTTS.getSavedVoiceName()!;
          const voice = v.find(x => x.name === saved);
          if (voice) vr.setGoogleVoice(saved, voice.languageCodes[0]);
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

    // When user places cursor, update voice reader start position
    renderer.onCursorChange = (charOffset) => {
      voiceReaderRef.current?.seekToOffset(charOffset);
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

    renderer.onProgress = (prog, _direction) => {
      setProgress(prog);
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
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [bookmarkPanelOpen, tocOpen]);

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

  const handleBookmarkClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey || bookmarkPanelOpen) {
      setBookmarkPanelOpen(prev => !prev);
    } else {
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
      const entry: BookmarkEntry = { position, label: `${pct}%`, timestamp: Date.now() };
      const updated = [...current, entry].sort((a, b) => a.position - b.position);
      saveBookmarks(fileKey, updated);
      setBookmarks(updated);
      flashBookmarkBtn(true);
      if (cloudEnabled && isSignedIn()) syncBookProgress(fileKey, bookData.title, position, updated, bookData.fileType);
    }
  }, [bookmarkPanelOpen, fileKey, flashBookmarkBtn, cloudEnabled, bookData.title]);

  const handleBookmarkContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); setBookmarkPanelOpen(prev => !prev); }, []);
  const handleBookmarkNavigate = useCallback((position: number) => { rendererRef.current?.setScrollProgress(position); setBookmarkPanelOpen(false); }, []);
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
      vr.play();
    } else {
      // Start fresh — seek to current reading position
      const charOffset = Math.floor(progress * bookData.allText.length);
      vr.seekToOffset(charOffset);
      vr.play();
      setVoicePanelOpen(true);
    }
  }, [progress, bookData.allText]);

  const handleVoiceStop = useCallback(() => {
    voiceReaderRef.current?.stop();
    setVoicePanelOpen(false);
  }, []);

  const handleVoiceSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const vr = voiceReaderRef.current;
    if (!vr) return;
    const voice = voices.find(v => v.name === e.target.value);
    if (voice) {
      vr.setVoice(voice);
      setSelectedVoiceName(voice.name);
      // If currently playing, restart with new voice
      if (vr.isPlaying() || vr.isPaused()) {
        const wasPlaying = vr.isPlaying();
        vr.stop();
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
      {/* Simplified top header: back + title (left), bionic toggle (right) */}
      <div className="reader-header">
        <div className="reader-header-row1">
          <div className="reader-header-left">
            <button className="reader-back" onClick={handleBack}>&larr;</button>
            <span className="reader-title">{bookData.title}</span>
          </div>
          <div className="reader-header-actions">
            <label className="bionic-toggle">
              <span className="bionic-label">Bionic</span>
              <input type="checkbox" checked={bionicEnabled} onChange={handleBionicChange} />
              <span className="bionic-slider"></span>
            </label>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div className="reader-canvas-wrap">
        <canvas ref={canvasRef}></canvas>
        <div className="scroll-hint" ref={hintRef}>Scroll to read &middot; Pinch to zoom</div>
      </div>

      {/* Voice control panel */}
      {voicePanelOpen && (
        <div className="voice-panel">
          {/* Engine toggle */}
          <div className="voice-panel-row">
            <div className="voice-engine-tabs">
              <button className={`voice-engine-tab${ttsEngine === 'system' ? ' active' : ''}`} onClick={() => handleEngineChange('system')}>System</button>
              <button className={`voice-engine-tab${ttsEngine === 'google' ? ' active' : ''}`} onClick={() => handleEngineChange('google')}>Google HD</button>
            </div>
            <button className="voice-stop-btn" onClick={handleVoiceStop} title="Stop">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
            </button>
          </div>

          {ttsEngine === 'system' ? (
            <div className="voice-panel-row">
              <select className="voice-select" value={selectedVoiceName} onChange={handleVoiceSelect}>
                {voices.map(v => (
                  <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="voice-panel-row">
              <select className="voice-select" value={selectedGoogleVoice} onChange={handleGoogleVoiceSelect}>
                {googleVoices.map(v => (
                  <option key={v.name} value={v.name}>
                    {v.name.split('-').slice(2).join('-')} ({v.languageCodes[0]})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="voice-panel-row">
            <span className="voice-rate-label">{voiceRate.toFixed(1)}x</span>
            <input type="range" className="voice-rate-slider" min="0.5" max="2.0" step="0.1" value={voiceRate} onChange={handleVoiceRateChange} />
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div className="reader-bottom-bar">
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
                  onClick={() => setTocOpen(prev => !prev)}
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

          {/* Center: Mode tabs */}
          <div className="mode-tabs">
            {modes.map(m => (
              <button
                key={m.key}
                className={`mode-tab${currentMode === m.key ? ' active' : ''}`}
                onClick={() => handleModeChange(m.key)}
              >{m.label}</button>
            ))}
          </div>

          {/* Progress percentage */}
          <span className="bottom-bar-progress-label">{pct}%</span>

          {/* Right: Bookmark button */}
          <div className="bookmark-group">
            <button className="bookmark-btn" ref={bookmarkBtnRef} title="Add bookmark"
              onClick={handleBookmarkClick} onContextMenu={handleBookmarkContextMenu}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 2h8a1 1 0 0 1 1 1v12l-5-3-5 3V3a1 1 0 0 1 1-1z"/>
              </svg>
            </button>
            <div className={`bookmark-panel${bookmarkPanelOpen ? ' open' : ''}`} ref={bookmarkPanelRef}>
              <div className="bookmark-panel-header">Bookmarks</div>
              <div className="bookmark-list">
                {bookmarks.length === 0 ? (
                  <div className="bookmark-empty">No bookmarks yet.<br/>Click the bookmark icon to add one.</div>
                ) : (
                  bookmarks.map((b, i) => (
                    <div key={`${b.position}-${b.timestamp}`} className="bookmark-item" onClick={() => handleBookmarkNavigate(b.position)}>
                      <span className="bookmark-item-label">{Math.round(b.position * 100)}%</span>
                      <span className="bookmark-item-time">{formatTime(b.timestamp)}</span>
                      <button className="bookmark-item-delete" title="Remove"
                        onClick={(e) => { e.stopPropagation(); handleBookmarkDelete(i); }}>&times;</button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Far right: Cloud sync (if connected) */}
          {cloudEnabled && (
            <button className={`cloud-sync-btn${cloudSyncing ? ' syncing' : ''}`} onClick={handleCloudSync} title="Sync to Google Drive">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Reader;
