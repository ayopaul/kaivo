export interface LibraryEntry {
  fileKey: string;
  title: string;
  fileType: 'pdf' | 'epub';
  progress: number;
  lastRead: number;
  coverImage?: string;
}

const LIBRARY_KEY = 'ebook:library';

export function saveLibraryEntry(
  fileKey: string,
  title: string,
  fileType: 'pdf' | 'epub',
  progress: number,
  coverImage?: string
) {
  try {
    const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}');
    const existing = library[fileKey];
    library[fileKey] = {
      fileKey, title, fileType, progress, lastRead: Date.now(),
      // Preserve existing cover if not provided
      coverImage: coverImage || existing?.coverImage,
    };
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch { /* quota */ }
}

export function loadLocalLibrary(): LibraryEntry[] {
  try {
    const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}');
    return (Object.values(library) as LibraryEntry[])
      .sort((a, b) => b.lastRead - a.lastRead);
  } catch {
    return [];
  }
}

export function removeLibraryEntry(fileKey: string) {
  try {
    const library = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}');
    delete library[fileKey];
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch { /* */ }
}

/** Merge local and cloud library entries, preferring most recent */
export function mergeLibraries(local: LibraryEntry[], cloud: LibraryEntry[]): LibraryEntry[] {
  const merged = new Map<string, LibraryEntry>();

  for (const entry of local) {
    merged.set(entry.fileKey, entry);
  }

  for (const entry of cloud) {
    const existing = merged.get(entry.fileKey);
    if (!existing || entry.lastRead > existing.lastRead) {
      merged.set(entry.fileKey, entry);
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.lastRead - a.lastRead);
}
