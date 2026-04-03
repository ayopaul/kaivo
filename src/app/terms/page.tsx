export default function TermsOfService() {
  return (
    <div className="legal-page">
      <a href="/" className="legal-back">&larr; Back</a>
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: April 3, 2026</p>

      <section>
        <h2>Acceptance of Terms</h2>
        <p>
          By using Ebook Reader, you agree to these terms. If you do not agree, please do not
          use the application.
        </p>
      </section>

      <section>
        <h2>Description of Service</h2>
        <p>
          Ebook Reader is a free, client-side web application that allows you to read PDF and
          EPUB files in your browser. The app provides features including text rendering,
          voice reading, bookmarks, and optional Google Drive synchronization.
        </p>
      </section>

      <section>
        <h2>Your Content</h2>
        <p>
          You retain full ownership of any files you open in the app. Your books are processed
          locally in your browser and are not uploaded to our servers. If you enable Google Drive
          sync, files are stored in your personal Google account.
        </p>
      </section>

      <section>
        <h2>Acceptable Use</h2>
        <p>You agree to use the app only for lawful purposes and in compliance with applicable laws regarding digital content and copyright.</p>
      </section>

      <section>
        <h2>Third-Party Services</h2>
        <p>The app integrates with the following third-party services:</p>
        <ul>
          <li><strong>Google Drive API</strong> — for optional cloud sync (subject to Google&apos;s Terms)</li>
          <li><strong>Google Cloud Text-to-Speech</strong> — for voice reading (subject to Google Cloud&apos;s Terms)</li>
          <li><strong>Google Fonts</strong> — for font rendering</li>
        </ul>
        <p>Use of these services is subject to their respective terms and privacy policies.</p>
      </section>

      <section>
        <h2>Disclaimer</h2>
        <p>
          The app is provided &ldquo;as is&rdquo; without warranties of any kind. We do not guarantee
          uninterrupted or error-free operation. We are not responsible for any data loss.
        </p>
      </section>

      <section>
        <h2>Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, we shall not be liable for any indirect,
          incidental, or consequential damages arising from your use of the app.
        </p>
      </section>

      <section>
        <h2>Changes to Terms</h2>
        <p>
          We may update these terms from time to time. Continued use of the app after changes
          constitutes acceptance of the revised terms.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          For questions about these terms, please open an issue on the project repository.
        </p>
      </section>
    </div>
  );
}
