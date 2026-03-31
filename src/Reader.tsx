import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CanvasRenderer, RenderMode } from './canvas-renderer';
import { BookData, TocEntry } from './pdf-extractor';
import { isSignedIn, syncBookProgress, loadBookProgress } from './google-drive';
import { saveLibraryEntry } from './library-storage';

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
  const [progressBarVisible, setProgressBarVisible] = useState(true);
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => loadBookmarks(fileKey));
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  const bookmarkBtnRef = useRef<HTMLButtonElement>(null);
  const bookmarkPanelRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const tocBtnRef = useRef<HTMLButtonElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveTimeRef = useRef(0);
  const lastCloudSyncRef = useRef(0);

  // Initialize canvas renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;

    renderer.setMode(currentMode);
    renderer.setBionic(bionicEnabled);

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

      if (savedProgress !== null && savedProgress > 0.01 && savedProgress < 0.98) {
        renderer.setScrollProgress(savedProgress);
      }

      // Save to library
      saveLibraryEntry(fileKey, bookData.title, bookData.fileType, savedProgress || 0);
    });

    renderer.onProgress = (prog, direction) => {
      setProgress(prog);
      if (direction === 'up') {
        setProgressBarVisible(true);
        if (hideTimeoutRef.current) { clearTimeout(hideTimeoutRef.current); hideTimeoutRef.current = null; }
      } else if (direction === 'down' && prog > 0.02) {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = setTimeout(() => setProgressBarVisible(false), 800);
      }
      const now = Date.now();
      if (now - lastSaveTimeRef.current > 500) {
        saveProgress(fileKey, prog);
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
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [bookData, fileKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { rendererRef.current?.setMode(currentMode); }, [currentMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const savedProgress = renderer.getProgress();
    renderer.setBionic(bionicEnabled);
    renderer.setContent(
      bookData.allText,
      bionicEnabled ? undefined : (bookData.pageImages.length > 0 ? bookData.pageImages : undefined)
    );
    if (savedProgress > 0.001) {
      renderer.setScrollProgress(savedProgress);
    }
  }, [bionicEnabled, bookData]);

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
      {/* Progress bar */}
      <div className={`progress-bar-wrap${progressBarVisible ? ' visible' : ''}`}>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }}></div>
          <div className="progress-bar-bookmarks">
            {bookmarks.map((b, i) => (
              <div key={i} className="progress-bookmark-dot" style={{ left: `${b.position * 100}%` }}></div>
            ))}
          </div>
        </div>
        <span className="progress-label">{pct}%</span>
      </div>

      {/* Header */}
      <div className="reader-header">
        <div className="reader-header-left">
          <button className="reader-back" onClick={handleBack}>&larr; Back</button>
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
        <span className="reader-title">{bookData.title}</span>
        <div className="reader-controls">
          <div className="mode-tabs">
            {modes.map(m => (
              <button
                key={m.key}
                className={`mode-tab${currentMode === m.key ? ' active' : ''}`}
                onClick={() => handleModeChange(m.key)}
              >{m.label}</button>
            ))}
          </div>
          <label className="bionic-toggle">
            <span className="bionic-label">Bionic</span>
            <input type="checkbox" checked={bionicEnabled} onChange={handleBionicChange} />
            <span className="bionic-slider"></span>
          </label>
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

      {/* Canvas */}
      <div className="reader-canvas-wrap">
        <canvas ref={canvasRef}></canvas>
        <div className="scroll-hint" ref={hintRef}>Scroll to read &middot; Pinch to zoom</div>
      </div>
    </div>
  );
};

export default Reader;
