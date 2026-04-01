import React, { useRef, useState, useCallback } from 'react';
import { BookData } from './pdf-extractor';
import { extractPdf } from './pdf-extractor';
import { extractEpub } from './epub-extractor';
import { isSignedIn, saveBookFile, syncBookProgress } from './google-drive';
import { saveLibraryEntry } from './library-storage';

interface LandingProps {
  onFileLoaded: (bookData: BookData, fileKey: string) => void;
  driveReady: boolean;
  driveSignedIn: boolean;
  onDriveSignIn: () => void;
  onDriveSignOut: () => void;
  onShowLibrary: () => void;
  hasLibrary: boolean;
}

const Landing: React.FC<LandingProps> = ({
  onFileLoaded,
  driveReady,
  driveSignedIn,
  onDriveSignIn,
  onDriveSignOut,
  onShowLibrary,
  hasLibrary,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState('');

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setLoadingProgress('');
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let bookData: BookData;

      if (ext === 'pdf') {
        bookData = await extractPdf(file, (current, total) => {
          setLoadingProgress(`Page ${current} of ${total}`);
        });
      } else if (ext === 'epub') {
        setLoadingProgress('Extracting chapters...');
        bookData = await extractEpub(file);
      } else {
        alert('Unsupported file type. Please use PDF or EPUB.');
        setLoading(false);
        return;
      }

      const fileKey = `ebook:${file.name}:${file.size}`;

      // Save to library immediately
      saveLibraryEntry(fileKey, bookData.title, bookData.fileType, 0);

      // Save book file + library to Google Drive in background
      if (driveSignedIn && isSignedIn()) {
        saveBookFile(fileKey, file).catch(err => console.warn('[Landing] saveBookFile failed:', err));
        syncBookProgress(fileKey, bookData.title, 0, [], bookData.fileType).catch(err => console.warn('[Landing] syncBookProgress failed:', err));
      }

      onFileLoaded(bookData, fileKey);
    } catch (err: any) {
      console.error('Failed to load file:', err);
      alert(`Failed to load file: ${err?.message || err}. Please try another.`);
      setLoading(false);
    }
  }, [onFileLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="loading-spinner"></div>
        {loadingProgress && (
          <div className="loading-progress">{loadingProgress}</div>
        )}
      </div>
    );
  }

  return (
    <div className="landing">
      <h1>Reader</h1>
      <p>A gesture-driven reading experience with pinch-to-zoom, scroll morph, and fisheye typography effects.</p>
      <div
        className={`drop-zone${dragOver ? ' drag-over' : ''}`}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="drop-zone-icon">+</div>
        <div className="drop-zone-label">Drop a file or click to browse</div>
        <div className="drop-zone-hint">Supports PDF and EPUB</div>
        <input
          type="file"
          ref={fileInputRef}
          accept=".pdf,.epub"
          onChange={handleInputChange}
        />
      </div>
      {hasLibrary && (
        <button className="library-open-btn" onClick={onShowLibrary}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
          Your Library
        </button>
      )}
      {driveReady && (
        <div className="drive-status">
          {driveSignedIn ? (
            <button className="drive-btn drive-btn-connected" onClick={onDriveSignOut}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Google Drive connected
            </button>
          ) : (
            <button className="drive-btn" onClick={onDriveSignIn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Sync with Google Drive
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default Landing;
