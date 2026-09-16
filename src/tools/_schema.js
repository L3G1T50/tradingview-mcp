/**
 * Shared zod schema helpers for tool parameters.
 */
import { z } from 'zod';

/**
 * Boolean parameter that also accepts the strings "true" and "false".
 * Some MCP clients send booleans as strings. z.coerce.boolean() is not safe
 * for that: it uses Boolean(value), so "false" and "0" both become true.
 * Anything other than a boolean or those two words is rejected.
 */
export function booleanParam() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const word = value.trim().toLowerCase();
    if (word === 'true') return true;
    if (word === 'false') return false;
    return value;
  }, z.boolean());
}

/**
 * Non-negative integer parameter (such as a 0-based index) that also accepts
 * digit strings like "2". z.coerce.number() is not safe for that: it reads
 * "", " ", null and false as 0.
 */
export function indexParam() {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
    z.number().int().min(0),
  );
}
