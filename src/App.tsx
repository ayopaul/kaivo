import React, { useState, useEffect, useCallback } from 'react';
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

type View = 'landing' | 'library' | 'reader';

const App: React.FC = () => {
  const [view, setView] = useState<View>('landing');
  const [bookData, setBookData] = useState<BookData | null>(null);
  const [fileKey, setFileKey] = useState('');
  const [driveReady, setDriveReady] = useState(false);
  const [driveSignedIn, setDriveSignedIn] = useState(false);
  const [userProfile, setUserProfile] = useState<GoogleUserProfile | null>(null);
  const [hasLibrary, setHasLibrary] = useState(false);

  useEffect(() => {
    // Check if there are library entries
    setHasLibrary(loadLocalLibrary().length > 0);

    if (isDriveConfigured()) {
      initGoogleAuth().then(() => {
        setDriveReady(true);
        const signedIn = isDriveSignedIn();
        setDriveSignedIn(signedIn);
        if (signedIn) setUserProfile(getUserProfile());
      });
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
    </div>
  );
};

export default App;
