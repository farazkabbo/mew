"use client";

/** The root layout itself failed: a minimal page with its own <html> (no app styles needed). */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
          background: "#f7f5f0",
          color: "#1d1c1a",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <h1 style={{ fontWeight: 400 }}>Neb couldn&apos;t start</h1>
          <p style={{ color: "#6b675f" }}>
            The app didn&apos;t load. Your notes are saved on this device. Try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 20px",
              borderRadius: 999,
              border: 0,
              background: "#1d1c1a",
              color: "#f7f5f0",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
