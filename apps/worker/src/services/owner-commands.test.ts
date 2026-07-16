import { describe, expect, test } from 'vitest';
import { isOwnerLineUserId, matchOwnerCommand, parseOwnerLineUserIds } from './owner-commands.js';

describe('parseOwnerLineUserIds', () => {
  test('splits a comma-separated list and trims whitespace', () => {
    expect(parseOwnerLineUserIds('U-a, U-b ,U-c')).toEqual(new Set(['U-a', 'U-b', 'U-c']));
  });

  test('drops empty segments (trailing comma / blank entries)', () => {
    expect(parseOwnerLineUserIds('U-a,,  ,U-b,')).toEqual(new Set(['U-a', 'U-b']));
  });

  test('returns an empty set when unset or empty (safe default = nobody is owner)', () => {
    expect(parseOwnerLineUserIds(undefined)).toEqual(new Set());
    expect(parseOwnerLineUserIds('')).toEqual(new Set());
  });
});

describe('isOwnerLineUserId', () => {
  test('true when userId is in the configured list', () => {
    expect(isOwnerLineUserId('U-owner', 'U-owner,U-other')).toBe(true);
  });

  test('false when userId is not in the list', () => {
    expect(isOwnerLineUserId('U-stranger', 'U-owner,U-other')).toBe(false);
  });

  test('false when userId is undefined', () => {
    expect(isOwnerLineUserId(undefined, 'U-owner')).toBe(false);
  });

  test('false when OWNER_LINE_USER_IDS is unset — nobody is treated as owner', () => {
    expect(isOwnerLineUserId('U-owner', undefined)).toBe(false);
  });
});

describe('matchOwnerCommand', () => {
  test('returns the admin URL for an exact "管理画面" match', () => {
    expect(matchOwnerCommand('管理画面')).toBe('https://satoyama-ai-base.vercel.app/admin');
  });

  test('tolerates surrounding whitespace', () => {
    expect(matchOwnerCommand('  管理画面  ')).toBe('https://satoyama-ai-base.vercel.app/admin');
  });

  test('returns null for unknown text (falls through to normal handling)', () => {
    expect(matchOwnerCommand('こんにちは')).toBeNull();
  });

  test('returns null for partial/contains matches (exact match only)', () => {
    expect(matchOwnerCommand('管理画面を教えて')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(matchOwnerCommand('')).toBeNull();
  });
});
