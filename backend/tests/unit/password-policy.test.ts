import { describe, it, expect } from 'vitest';
import {
  validatePasswordPolicy,
  PASSWORD_POLICY_MESSAGE,
} from '../../src/auth/password-policy.js';

describe('password policy (T011, 003 FR-002)', () => {
  it('accepts a password that satisfies every rule', () => {
    const result = validatePasswordPolicy('Password123!');
    expect(result.ok).toBe(true);
  });

  it('rejects a password shorter than 8 characters', () => {
    const result = validatePasswordPolicy('Pa1!x');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(PASSWORD_POLICY_MESSAGE);
  });

  it('rejects a password with no uppercase letter', () => {
    const result = validatePasswordPolicy('password123!');
    expect(result.ok).toBe(false);
  });

  it('rejects a password with no lowercase letter', () => {
    const result = validatePasswordPolicy('PASSWORD123!');
    expect(result.ok).toBe(false);
  });

  it('rejects a password with no number', () => {
    const result = validatePasswordPolicy('Password!xyz');
    expect(result.ok).toBe(false);
  });

  it('rejects a password with no symbol', () => {
    const result = validatePasswordPolicy('Password1234');
    expect(result.ok).toBe(false);
  });

  it('returns the single stable requirement message on any failure', () => {
    expect(
      validatePasswordPolicy('short').message,
    ).toBe(
      'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol.',
    );
  });
});
