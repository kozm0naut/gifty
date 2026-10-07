import { createApp } from './app.js';
import { validateConfig, loadConfig } from './config/index.js';
import { startDrainer, stopDrainer } from './email/outbox.js';

// Fail fast on startup if required config (e.g. JWT_SECRET in production) is
// missing — never serve with a known/default secret (Constitution §IV, 003 FR-006).
// Feature 004 adds the production email gate (EMAIL_ENABLED + RESEND_API_KEY).
validateConfig();

const port = Number(process.env.PORT || 4000);

// Surface the resolved email sending mode at boot so an operator can confirm
// they are in the mode they intended (live / capture / disabled).
const emailMode = loadConfig().email.mode;
if (emailMode === 'live') {
  console.log('[email] mode: live (Resend) — confirmation + invite emails will be delivered');
} else if (emailMode === 'capture') {
  console.log('[email] mode: capture (dev/test) — emails are captured in-memory, no network I/O');
} else {
  console.warn(
    '[email] mode: disabled — accounts auto-confirm on registration and NO emails are sent (004 FR-015)',
  );
}

void (async () => {
  const app = await createApp();
  const server = app.listen(port, () => {
    console.log(`Gift list API listening on http://localhost:${port}`);
    // Start the in-process outbox drainer only after the app is up (no-op in
    // the disabled mode — `startDrainer` checks the config internally).
    startDrainer();
  });

  // Graceful shutdown: stop the drainer (awaiting in-flight sends) so no
  // delivery cycle is abandoned, then let connections drain.
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    void stopDrainer()
      .catch((err) => console.error('[server] drainer stop failed:', err instanceof Error ? err.message : String(err)))
      .then(() => {
        server.close(() => process.exit(0));
      });
    // Hard exit if connections do not drain in a reasonable time.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
