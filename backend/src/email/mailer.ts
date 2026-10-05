/**
 * Mailer port for the email-integration feature (feature 004, research D1).
 *
 * Two implementations behind one interface:
 *   - `ResendMailer`   — the production sender. A single JSON `POST` to
 *     `https://api.resend.com/emails` via the Node 22 global `fetch` (no SDK).
 *   - `CaptureMailer`  — the dev/test stub. Zero network I/O; holds captured
 *     messages in an in-memory buffer and logs each in a stable, greppable
 *     shape (US5, SC-003).
 *
 * `getMailer()` resolves the active implementation from the config sending
 * mode (T008): live → Resend, capture → Capture, disabled → a no-op (nothing
 * is enqueued in disabled mode, so it is never actually used). `setMailerForTest`
 * is a test-only injection hook (mirrors the `GIFTY_ENABLE_TEST_PROBES`
 * discipline — callers only invoke it from tests).
 *
 * The `meta` argument is optional and provider-agnostic: Resend ignores it,
 * while the CaptureMailer records `kind` + `link` so `capturedEmails()` can
 * surface the shape tests assert (FR-001/FR-003).
 */

import { loadConfig } from '../config/index.js';

export interface OutboundMeta {
  /** The outbox message kind — surfaced by the capture stub for tests. */
  kind?: 'invite' | 'confirmation';
  /** The link embedded in the body — surfaced by the capture stub for tests. */
  link?: string;
}

export interface Mailer {
  send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    meta?: OutboundMeta,
  ): Promise<void>;
}

/** Extract the first http(s) URL from a body string (for capture observability). */
export function extractLink(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : undefined;
}

/**
 * The production live sender (research D1). Uses the global `fetch` — a single
 * JSON `POST`. A non-2xx response throws (the drainer maps it to a scrubbed
 * retry/terminal state). `RESEND_API_KEY` and `RESEND_FROM` come from config.
 */
export class ResendMailer implements Mailer {
  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    _meta?: OutboundMeta,
  ): Promise<void> {
    const { email } = loadConfig();
    if (!email.resendApiKey) {
      throw new Error('ResendMailer is active but RESEND_API_KEY is not configured');
    }
    const body: Record<string, unknown> = {
      from: email.resendFrom ?? 'no-reply@gifty',
      to: [to],
      subject,
      text,
    };
    if (html) body.html = html;

    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${email.resendApiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (DNS, connection refused, timeout, …).
      const e = new Error(
        `Resend network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      (e as { providerError?: string }).providerError = 'network_error';
      throw e;
    }

    if (!res.ok) {
      const e = new Error(`Resend responded ${res.status}`);
      // A stable, scrubbed class the drainer can persist (never a provider key).
      (e as { providerError?: string }).providerError =
        `provider_http_${Math.floor(res.status / 100) * 100}`;
      throw e;
    }
  }
}

export interface CapturedEmail {
  kind?: 'invite' | 'confirmation';
  to: string;
  subject: string;
  text: string;
  link?: string;
}

/**
 * The dev/test capture stub (research D1, US5, SC-003). Zero network I/O:
 * it records each message in an in-memory buffer and logs it in a stable,
 * greppable shape. The test hooks (`capturedEmails` / `resetCapturedEmails`)
 * are only reachable when the operator (or a test) has chosen this stub.
 */
export class CaptureMailer implements Mailer {
  private buffer: CapturedEmail[] = [];

  async send(
    to: string,
    subject: string,
    text: string,
    _html?: string,
    meta?: OutboundMeta,
  ): Promise<void> {
    const link = meta?.link ?? extractLink(text);
    const entry: CapturedEmail = {
      kind: meta?.kind,
      to,
      subject,
      text,
      link,
    };
    this.buffer.push(entry);
    // Stable, greppable shape (SC-003): [email:capture] kind=… to=… subject=…
    // The link is logged for developer convenience (this is a local, non-
    // production stub; the raw-token sensitivity concern is about the *live*
    // path and the DB row, not local dev logging).
    console.log(
      `[email:capture] kind=${entry.kind ?? 'unknown'} to=${to} subject=${JSON.stringify(subject)} link=${link ?? ''}`,
    );
  }

  /** All messages captured since the last reset (tests / dev inspection). */
  capturedEmails(): CapturedEmail[] {
    return this.buffer.map((e) => ({ ...e }));
  }

  /** Clear the capture buffer (tests / dev inspection). */
  resetCapturedEmails(): void {
    this.buffer = [];
  }
}

/** No-op sender for the disabled mode (nothing is enqueued, so unused in practice). */
class NoopMailer implements Mailer {
  async send(): Promise<void> {
    /* disabled mode — no delivery */
  }
}

const captureMailer = new CaptureMailer();
const noopMailer = new NoopMailer();

/** Test-only injection hook — set an arbitrary mailer implementation. */
let activeMailerOverride: Mailer | null = null;

export function setMailerForTest(mailer: Mailer | null): void {
  activeMailerOverride = mailer;
}

/**
 * Resolve the active mailer from the config sending mode (T008). A test
 * override (if any) always wins, so suites can inject a spy without touching
 * the env.
 */
export function getMailer(): Mailer {
  if (activeMailerOverride) return activeMailerOverride;
  const mode = loadConfig().email.mode;
  switch (mode) {
    case 'live':
      return new ResendMailer();
    case 'capture':
      return captureMailer;
    case 'disabled':
      return noopMailer;
  }
}

/**
 * Access the shared capture buffer. Only meaningful in capture mode (dev/test);
 * in any other mode it returns an empty array and reset is a no-op — the hooks
 * exist but never observe live sends (SC-003 discipline).
 */
export function capturedEmails(): CapturedEmail[] {
  return loadConfig().email.mode === 'capture' ? captureMailer.capturedEmails() : [];
}

export function resetCapturedEmails(): void {
  captureMailer.resetCapturedEmails();
}
