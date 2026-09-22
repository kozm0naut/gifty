import { describe, it, expect } from 'vitest';
import { validateCreateGiftItem } from '../../src/gift-items/gift-item.validation.js';

describe('validateCreateGiftItem (unit)', () => {
  it('accepts a minimal item with only a name (FR-003: quantity/price are optional)', () => {
    expect(validateCreateGiftItem({ name: 'Coffee maker' })).toBeNull();
  });

  it('accepts an item with name, optional description, quantity and unitPrice', () => {
    expect(
      validateCreateGiftItem({
        name: 'Headphones',
        description: 'Noise cancelling',
        quantity: 2,
        unitPrice: 149.5,
      })
    ).toBeNull();
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateCreateGiftItem({ name: '' })).toBe('Gift item name is required');
    expect(validateCreateGiftItem({ name: '   ' })).toBe('Gift item name is required');
  });

  it('rejects a missing name', () => {
    expect(validateCreateGiftItem({} as any)).toBe('Gift item name is required');
  });

  it('rejects a quantity below 1 when one is supplied', () => {
    expect(validateCreateGiftItem({ name: 'X', quantity: 0 })).toBe('Quantity must be at least 1');
    expect(validateCreateGiftItem({ name: 'X', quantity: -3 })).toBe('Quantity must be at least 1');
  });

  it('rejects a non-numeric quantity when one is supplied', () => {
    expect(validateCreateGiftItem({ name: 'X', quantity: 'three' as any })).toBe('Quantity must be at least 1');
  });

  it('accepts quantity 1 (the minimum valid value)', () => {
    expect(validateCreateGiftItem({ name: 'X', quantity: 1 })).toBeNull();
  });

  it('rejects a negative unit price when one is supplied', () => {
    expect(validateCreateGiftItem({ name: 'X', unitPrice: -0.01 })).toBe('Unit price must be a non-negative number');
  });

  it('rejects a non-numeric unit price when one is supplied', () => {
    expect(validateCreateGiftItem({ name: 'X', unitPrice: 'free' as any })).toBe('Unit price must be a non-negative number');
  });

  it('accepts a zero unit price (a valid non-negative value)', () => {
    expect(validateCreateGiftItem({ name: 'X', unitPrice: 0 })).toBeNull();
  });

  it('returns the first failing rule when multiple fields are invalid (name takes priority)', () => {
    expect(validateCreateGiftItem({ name: '', quantity: 0, unitPrice: -1 })).toBe('Gift item name is required');
  });
});
