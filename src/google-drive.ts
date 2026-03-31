/**
 * Google Drive cloud storage for reading progress.
 *
 * Setup:
 * 1. Go to https://console.cloud.google.com
 * 2. Create a project (or select existing)
 * 3. Enable the "Google Drive API"
 * 4. Go to Credentials → Create OAuth 2.0 Client ID (Web application)
 * 5. Add http://localhost:3000 to Authorized JavaScript origins
 * 6. Copy the Client ID and paste it below
 */

const CLIENT_ID = '1043767613653-9dv2u4245dm5sdi591of74jrg5j3dn9p.apps.googleusercontent.com';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
const PROGRESS_FILE = 'ebook-reader-progress.json';

export interface CloudBookData {
  progress: number;
  bookmarks: { position: number; label: string; timestamp: number }[];
  lastRead: number;
  title: string;
  fileKey: string;
  fileType: 'pdf' | 'epub';
}

export interface CloudProgressData {
  books: { [fileKey: string]: CloudBookData };
}

let accessToken: string | null = null;
let tokenClient: any = null;
let gisLoaded = false;

/** Whether a client ID has been configured */
export function isConfigured(): boolean {
  return CLIENT_ID.length > 10;
}

/** Whether the user is currently signed in */
export function isSignedIn(): boolean {
  return !!accessToken;
}

/** Load the Google Identity Services script and init the token client */
export async function initGoogleAuth(): Promise<void> {
  if (!isConfigured()) return;
  if (gisLoaded) return;

  await loadScript('https://accounts.google.com/gsi/client');
  gisLoaded = true;

  tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}, // overridden per-call in signIn()
  });
}

/** Trigger Google sign-in popup. Returns the access token. */
export function signIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Google auth not initialized'));
      return;
    }

    tokenClient.callback = (response: any) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      accessToken = response.access_token;
      resolve(accessToken!);
    };

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

/** Revoke the current token and sign out */
export function signOut(): void {
  if (accessToken) {
    try {
      (window as any).google.accounts.oauth2.revoke(accessToken);
    } catch { /* ignore */ }
    accessToken = null;
  }
}

// ── Drive file operations ──

async function driveGet(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${res.statusText}`);
  return res.json();
}

/** Find the progress file in appDataFolder, return its file ID or null */
async function findProgressFile(): Promise<string | null> {
  const data = await driveGet(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${PROGRESS_FILE}'&fields=files(id)`
  );
  return data.files?.[0]?.id || null;
}

/** Read the progress file contents */
async function readFile(fileId: string): Promise<CloudProgressData> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive read ${res.status}`);
  return res.json();
}

/** Create a new progress file in appDataFolder */
async function createFile(content: CloudProgressData): Promise<string> {
  const metadata = { name: PROGRESS_FILE, parents: ['appDataFolder'] };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' })
  );
  form.append(
    'file',
    new Blob([JSON.stringify(content)], { type: 'application/json' })
  );

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    }
  );
  if (!res.ok) throw new Error(`Drive create ${res.status}`);
  const data = await res.json();
  return data.id;
}

/** Update an existing progress file */
async function updateFile(fileId: string, content: CloudProgressData): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(content),
    }
  );
  if (!res.ok) throw new Error(`Drive update ${res.status}`);
}

// ── High-level API ──

/** Load all reading progress from Google Drive */
export async function loadCloudProgress(): Promise<CloudProgressData | null> {
  if (!accessToken) return null;

  try {
    const fileId = await findProgressFile();
    if (!fileId) return null;
    return await readFile(fileId);
  } catch (err) {
    console.warn('[google-drive] Failed to load progress:', err);
    return null;
  }
}

/** Save all reading progress to Google Drive */
export async function saveCloudProgress(data: CloudProgressData): Promise<void> {
  if (!accessToken) return;

  try {
    const fileId = await findProgressFile();
    if (fileId) {
      await updateFile(fileId, data);
    } else {
      await createFile(data);
    }
  } catch (err) {
    console.warn('[google-drive] Failed to save progress:', err);
  }
}

/** Save progress for a single book (reads existing cloud data, merges, writes back) */
export async function syncBookProgress(
  fileKey: string,
  title: string,
  progress: number,
  bookmarks: { position: number; label: string; timestamp: number }[],
  fileType: 'pdf' | 'epub' = 'pdf'
): Promise<void> {
  if (!accessToken) return;

  try {
    const existing = (await loadCloudProgress()) || { books: {} };
    existing.books[fileKey] = {
      progress,
      bookmarks,
      lastRead: Date.now(),
      title,
      fileKey,
      fileType,
    };
    await saveCloudProgress(existing);
  } catch (err) {
    console.warn('[google-drive] Failed to sync book progress:', err);
  }
}

/** Load progress for a single book from the cloud */
export async function loadBookProgress(fileKey: string): Promise<CloudBookData | null> {
  if (!accessToken) return null;

  try {
    const data = await loadCloudProgress();
    return data?.books?.[fileKey] || null;
  } catch {
    return null;
  }
}

/** Load all books from cloud as a library listing */
export async function loadCloudLibrary(): Promise<CloudBookData[]> {
  if (!accessToken) return [];
  try {
    const data = await loadCloudProgress();
    if (!data?.books) return [];
    return Object.entries(data.books)
      .map(([key, val]) => ({ ...val, fileKey: val.fileKey || key, fileType: val.fileType || 'pdf' as const }))
      .sort((a, b) => b.lastRead - a.lastRead);
  } catch { return []; }
}

// ── Book file storage ──

/** Generate a safe filename for a book in Drive */
function bookFileName(fileKey: string): string {
  let hash = 0;
  for (let i = 0; i < fileKey.length; i++) {
    hash = ((hash << 5) - hash) + fileKey.charCodeAt(i);
    hash |= 0;
  }
  return `book-${Math.abs(hash).toString(36)}.bin`;
}

/** Upload a book file to Google Drive appDataFolder */
export async function saveBookFile(fileKey: string, file: File): Promise<void> {
  if (!accessToken) return;

  try {
    const name = bookFileName(fileKey);

    // Check if already uploaded
    const existingId = await findFileByName(name);
    if (existingId) return; // Already saved

    const metadata = { name, parents: ['appDataFolder'] };
    const arrayBuffer = await file.arrayBuffer();

    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' })
    );
    form.append(
      'file',
      new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' })
    );

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      }
    );
    if (!res.ok) throw new Error(`Upload failed ${res.status}`);
  } catch (err) {
    console.warn('[google-drive] Failed to save book file:', err);
  }
}

/** Download a book file from Google Drive */
export async function loadBookFile(fileKey: string): Promise<File | null> {
  if (!accessToken) return null;

  try {
    const name = bookFileName(fileKey);
    const fileId = await findFileByName(name);
    if (!fileId) return null;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;

    const blob = await res.blob();
    // Extract original filename from fileKey: "ebook:filename.ext:size"
    const parts = fileKey.split(':');
    const fileName = parts.length >= 2 ? parts[1] : 'book';
    return new File([blob], fileName, { type: blob.type });
  } catch (err) {
    console.warn('[google-drive] Failed to load book file:', err);
    return null;
  }
}

/** Check if a book file exists in Drive */
export async function hasBookFile(fileKey: string): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const name = bookFileName(fileKey);
    const id = await findFileByName(name);
    return !!id;
  } catch { return false; }
}

async function findFileByName(name: string): Promise<string | null> {
  const data = await driveGet(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${name}'&fields=files(id)`
  );
  return data.files?.[0]?.id || null;
}

// ── Utility ──

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
