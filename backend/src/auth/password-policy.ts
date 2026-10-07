/**
 * Password-strength policy for feature 003 (security hardening) — T014.
 *
 * Pure function over a candidate password (003 FR-002). The default policy is:
 *   - length >= 8, AND
 *   - at least one uppercase letter, one lowercase letter, one number, and
 *     one symbol (any non-alphanumeric character).
 *
 * Rejections use a single, stable, user-facing message so the client can
 * surface the requirement without revealing anything about the account.
 * Sign-in is intentionally unaffected — only new accounts are gated.
 */

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol.';

export interface PasswordPolicyResult {
  /** `true` when the password satisfies the policy. */
  ok: boolean;
  /** Present (and equal to {@link PASSWORD_POLICY_MESSAGE}) when `ok` is `false`. */
  message?: string;
}

const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_NUMBER = /[0-9]/;
const HAS_SYMBOL = /[^A-Za-z0-9]/;

/**
 * Validate a candidate password against the feature 003 policy (003 FR-002).
 * Pure and side-effect free — safe to call in a request path or a unit test.
 */
export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  const ok =
    typeof password === 'string' &&
    password.length >= 8 &&
    HAS_UPPER.test(password) &&
    HAS_LOWER.test(password) &&
    HAS_NUMBER.test(password) &&
    HAS_SYMBOL.test(password);

  if (ok) {
    return { ok: true };
  }
  return { ok: false, message: PASSWORD_POLICY_MESSAGE };
}
