import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BookData } from './pdf-extractor';
import Landing from './Landing';
import Reader from './Reader';
import Library from './Library';
import {
  isConfigured as isDriveConfigured,
  isSignedIn as isDriveSignedIn,
  initGoogleAuth,
  signIn as driveSignIn,
  signOut as driveSignOut,
  getUserProfile,
  GoogleUserProfile,
} from './google-drive';
import { loadLocalLibrary } from './library-storage';

const INSTALL_DISMISSED_KEY = 'ebook:install-dismissed';

type View = 'landing' | 'library' | 'reader';

const App: React.FC = () => {
  const [view, setView] = useState<View>('landing');
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [fileKey, setFileKey] = useState('');
  const [driveReady, setDriveReady] = useState(false);
  const [driveSignedIn, setDriveSignedIn] = useState(false);
  const [userProfile, setUserProfile] = useState<GoogleUserProfile | null>(null);
  const [hasLibrary, setHasLibrary] = useState(false);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const deferredPromptRef = useRef<any>(null);

  useEffect(() => {
    // Apply saved theme
    const savedTheme = localStorage.getItem('ebook:settings:theme');
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

    setHasLibrary(loadLocalLibrary().length > 0);

    if (isDriveConfigured()) {
      initGoogleAuth().then(() => {
        setDriveReady(true);
        const signedIn = isDriveSignedIn();
        setDriveSignedIn(signedIn);
        if (signedIn) setUserProfile(getUserProfile());
      });
    }

    // PWA install prompt
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    const wasDismissed = localStorage.getItem(INSTALL_DISMISSED_KEY);

    if (!isStandalone && !wasDismissed) {
      // Chrome/Edge: capture the beforeinstallprompt event
      const handler = (e: Event) => {
        e.preventDefault();
        deferredPromptRef.current = e;
        setShowInstallPrompt(true);
      };
      window.addEventListener('beforeinstallprompt', handler);

      // Safari/Firefox: show manual instructions after a short delay
      const timer = setTimeout(() => {
        if (!deferredPromptRef.current) {
          setShowInstallPrompt(true);
        }
      }, 2000);

      return () => {
        window.removeEventListener('beforeinstallprompt', handler);
        clearTimeout(timer);
      };
    }
  }, []);

  const handleFileLoaded = useCallback((data: BookData, key: string) => {
    setBookData(data);
    setFileKey(key);
    setView('reader');
    setHasLibrary(true);
  }, []);

  const handleBack = useCallback(() => {
    setBookData(null);
    setFileKey('');
    setView('landing');
    setHasLibrary(loadLocalLibrary().length > 0);
  }, []);

  const handleDriveSignIn = useCallback(async () => {
    try {
      await driveSignIn();
      setDriveSignedIn(true);
      setUserProfile(getUserProfile());
    } catch (err) {
      console.error('Google sign-in failed:', err);
    }
  }, []);

  const handleDriveSignOut = useCallback(() => {
    driveSignOut();
    setDriveSignedIn(false);
    setUserProfile(null);
  }, []);

  const handleShowLibrary = useCallback(() => setView('library'), []);
  const handleBackToLanding = useCallback(() => setView('landing'), []);

  const handleInstall = useCallback(async () => {
    const prompt = deferredPromptRef.current;
    if (prompt) {
      prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') {
        setShowInstallPrompt(false);
      }
      deferredPromptRef.current = null;
    } else {
      // No native prompt (Safari) — dismiss and let the instructions guide them
      setShowInstallPrompt(false);
    }
  }, []);

  const handleDismissInstall = useCallback(() => {
    setShowInstallPrompt(false);
    localStorage.setItem(INSTALL_DISMISSED_KEY, Date.now().toString());
  }, []);

  const isSafari = typeof navigator !== 'undefined' && /Safari/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent);
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  return (
    <div id="app">
      {view === 'landing' && (
        <Landing
          onFileLoaded={handleFileLoaded}
          driveReady={driveReady}
          driveSignedIn={driveSignedIn}
          userProfile={userProfile}
          onDriveSignIn={handleDriveSignIn}
          onDriveSignOut={handleDriveSignOut}
          onShowLibrary={handleShowLibrary}
          hasLibrary={hasLibrary}
        />
      )}
      {view === 'library' && (
        <Library
          onBack={handleBackToLanding}
          onFileLoaded={handleFileLoaded}
          driveSignedIn={driveSignedIn}
        />
      )}
      {view === 'reader' && bookData && (
        <Reader
          bookData={bookData}
          fileKey={fileKey}
          onBack={handleBack}
          cloudEnabled={driveSignedIn}
          userProfile={userProfile}
        />
      )}
      {showInstallPrompt && view === 'landing' && (
        <div className="install-banner">
          <div className="install-banner-content">
            <div className="install-banner-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2v13M12 15l-4-4M12 15l4-4"/>
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
              </svg>
            </div>
            <div className="install-banner-text">
              <strong>Install Ebook Reader</strong>
              {(isSafari || isIOS) ? (
                <span>
                  Tap <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', margin: '0 2px' }}><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then <strong>Add to Home Screen</strong>
                </span>
              ) : (
                <span>Read offline with a full-screen experience</span>
              )}
            </div>
            <div className="install-banner-actions">
              {!isSafari && !isIOS && (
                <button className="install-btn" onClick={handleInstall}>Install</button>
              )}
              <button className="install-dismiss" onClick={handleDismissInstall} title="Dismiss">&times;</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
