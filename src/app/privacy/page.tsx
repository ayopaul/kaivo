export default function PrivacyPolicy() {
  return (
    <div className="legal-page">
      <a href="/" className="legal-back">&larr; Back</a>
      <h1>Privacy Policy</h1>
      <p className="legal-updated">Last updated: April 3, 2026</p>

      <section>
        <h2>Overview</h2>
        <p>
          Ebook Reader is a client-side web application. Your books and reading data are processed
          entirely in your browser. We do not operate servers that store your personal data.
        </p>
      </section>

      <section>
        <h2>Data We Collect</h2>
        <p>We do not collect, transmit, or store any personal data on our servers. Specifically:</p>
        <ul>
          <li><strong>Book files</strong> — processed entirely in your browser. Files are never uploaded to our servers.</li>
          <li><strong>Reading progress and bookmarks</strong> — stored locally in your browser (localStorage).</li>
          <li><strong>Font and display preferences</strong> — stored locally in your browser.</li>
        </ul>
      </section>

      <section>
        <h2>Google Drive Integration</h2>
        <p>
          If you choose to sign in with Google, the app uses the Google Drive API to sync your
          reading progress and book files to your own Google Drive account (in the app-specific
          data folder). This data is stored in your personal Google account, not on our servers.
        </p>
        <p>The app requests the following permissions:</p>
        <ul>
          <li><strong>drive.appdata</strong> — to store reading progress in your Drive&apos;s app data folder</li>
          <li><strong>profile and email</strong> — to display your name and profile picture in the app</li>
        </ul>
        <p>You can revoke access at any time by signing out or visiting your Google Account permissions.</p>
      </section>

      <section>
        <h2>Google Cloud Text-to-Speech</h2>
        <p>
          The voice reading feature sends text to Google&apos;s Cloud Text-to-Speech API for audio
          synthesis. This is subject to <a href="https://cloud.google.com/terms" target="_blank" rel="noopener noreferrer">Google Cloud&apos;s Terms of Service</a>.
          No text is stored by us.
        </p>
      </section>

      <section>
        <h2>Cookies and Tracking</h2>
        <p>
          This app does not use cookies, analytics, or any third-party tracking. We do not serve ads.
        </p>
      </section>

      <section>
        <h2>Data Deletion</h2>
        <p>
          To delete all local data, clear your browser&apos;s site data for this domain. To remove
          synced data, sign out of Google Drive in the app settings, then delete the app data
          from your Google Account.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          For questions about this privacy policy, please open an issue on the project repository.
        </p>
      </section>
    </div>
  );
}
