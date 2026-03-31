import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BookData } from './pdf-extractor';
import { extractPdf } from './pdf-extractor';
import { extractEpub } from './epub-extractor';
import { isSignedIn, loadCloudLibrary } from './google-drive';
import { LibraryEntry, loadLocalLibrary, mergeLibraries, removeLibraryEntry } from './library-storage';

interface LibraryProps {
  onBack: () => void;
  onFileLoaded: (bookData: BookData, fileKey: string) => void;
  driveSignedIn: boolean;
}

/** Generate a deterministic color from a string */
function titleColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 25%, 18%)`;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString('default', { month: 'short', day: 'numeric' });
}

const Library: React.FC<LibraryProps> = ({ onBack, onFileLoaded, driveSignedIn }) => {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<LibraryEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function load() {
      const local = loadLocalLibrary();

      if (driveSignedIn && isSignedIn()) {
        try {
          const cloud = await loadCloudLibrary();
          const cloudEntries: LibraryEntry[] = cloud.map(c => ({
            fileKey: c.fileKey,
            title: c.title,
            fileType: c.fileType || 'pdf',
            progress: c.progress,
            lastRead: c.lastRead,
          }));
          setEntries(mergeLibraries(local, cloudEntries));
        } catch {
          setEntries(local);
        }
      } else {
        setEntries(local);
      }
      setLoading(false);
    }
    load();
  }, [driveSignedIn]);

  const handleCardClick = useCallback((entry: LibraryEntry) => {
    setSelectedEntry(entry);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setSelectedEntry(null); return; }

    setProcessing(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let bookData: BookData;

      if (ext === 'pdf') {
        bookData = await extractPdf(file);
      } else if (ext === 'epub') {
        bookData = await extractEpub(file);
      } else {
        alert('Unsupported file type.');
        setProcessing(false);
        setSelectedEntry(null);
        return;
      }

      const fileKey = `ebook:${file.name}:${file.size}`;
      onFileLoaded(bookData, fileKey);
    } catch (err) {
      console.error('Failed to load file:', err);
      alert('Failed to load file.');
      setProcessing(false);
      setSelectedEntry(null);
    }

    // Reset input so re-selecting the same file triggers onChange
    e.target.value = '';
  }, [onFileLoaded]);

  const handleRemove = useCallback((e: React.MouseEvent, entry: LibraryEntry) => {
    e.stopPropagation();
    removeLibraryEntry(entry.fileKey);
    setEntries(prev => prev.filter(en => en.fileKey !== entry.fileKey));
  }, []);

  if (processing) {
    return (
      <div className="loading-overlay">
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <div className="library">
      <div className="library-header">
        <button className="reader-back" onClick={onBack}>&larr; Back</button>
        <h2 className="library-heading">Your Library</h2>
      </div>

      {loading ? (
        <div className="library-loading">
          <div className="loading-spinner"></div>
        </div>
      ) : entries.length === 0 ? (
        <div className="library-empty">
          <p>No books yet. Open a PDF or EPUB to get started.</p>
          <button className="reader-back" onClick={onBack}>&larr; Upload a book</button>
        </div>
      ) : (
        <>
          {selectedEntry && (
            <div className="library-reupload-hint">
              Re-upload <strong>{selectedEntry.title}</strong> to continue reading
            </div>
          )}
          <div className="library-grid">
            {entries.map(entry => (
              <div
                key={entry.fileKey}
                className="library-card"
                onClick={() => handleCardClick(entry)}
              >
                <div
                  className="library-card-thumb"
                  style={{ backgroundColor: titleColor(entry.title) }}
                >
                  <span className="library-card-type">{entry.fileType.toUpperCase()}</span>
                  <span className="library-card-thumb-title">{entry.title}</span>
                </div>
                <div className="library-card-info">
                  <span className="library-card-title">{entry.title}</span>
                  <div className="library-card-meta">
                    <span>{Math.round(entry.progress * 100)}%</span>
                    <span>{formatRelativeTime(entry.lastRead)}</span>
                  </div>
                </div>
                <div className="library-card-bar">
                  <div className="library-card-bar-fill" style={{ width: `${entry.progress * 100}%` }}></div>
                </div>
                <button
                  className="library-card-remove"
                  onClick={(e) => handleRemove(e, entry)}
                  title="Remove from library"
                >&times;</button>
              </div>
            ))}
          </div>
        </>
      )}

      <input
        type="file"
        ref={fileInputRef}
        accept=".pdf,.epub"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
};

export default Library;
