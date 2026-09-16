/**
 * Tests for src/core/tab.js via _deps injection — no live TradingView needed.
 * Covers: list, switchTab, closeTab, and the landing-page reuse path of newTab.
 * CDP targets and the Electron shell window are simulated with mock fetch/CDP.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { list, newTab, closeTab, switchTab } from '../src/core/tab.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const SHELL = { id: 'shell', type: 'page', title: 'TradingView', url: 'file:///C:/app/window/index.html' };
const CHART_A = {
  id: 'A', type: 'page',
  title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView',
  url: 'https://www.tradingview.com/chart/abc123/',
};
const CHART_B = { id: 'B', type: 'page', title: 'ES1! Unnamed', url: 'https://www.tradingview.com/chart/def456/?symbol=ES1!' };
const LANDING = { id: 'L', type: 'page', title: 'New tab', url: 'file:///C:/app/landing/index.html' };
const WORKER = { id: 'W', type: 'service_worker', title: 'sw', url: 'https://www.tradingview.com/chart/sw.js' };

// ── Mock helpers ─────────────────────────────────────────────────────────

/** Mock fetch for /json/list; requested URLs tracked in .urls. */
function mockFetch(targets) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    return { json: async () => targets };
  };
  fn.urls = urls;
  return fn;
}

/**
 * Mock chrome-remote-interface factory. `pages` maps target id -> handler(expression).
 * Connecting to an unknown target rejects. Opened/closed counts are tracked so
 * tests can assert no client is leaked.
 */
function mockCDP(pages) {
  const opened = [];
  let closed = 0;
  const fn = async ({ target }) => {
    const handler = pages[target];
    if (!handler) throw new Error(`no such target: ${target}`);
    opened.push(target);
    return {
      Runtime: { evaluate: async ({ expression }) => ({ result: { value: handler(expression) } }) },
      close: async () => { closed++; },
    };
  };
  fn.opened = opened;
  Object.defineProperty(fn, 'closed', { get: () => closed });
  return fn;
}

/** Simulated shell window with `count` tabs; clicks are recorded. */
function shellWindow({ count, onClick = () => {}, closeResult = true }) {
  const clicks = [];
  const state = { count };
  const handler = (expr) => {
    if (expr.includes('!!document.querySelector')) return true;
    if (expr.includes('close.click()')) {
      clicks.push('close');
      if (closeResult) state.count--;
      return closeResult;
    }
    const m = expr.match(/\[(\d+)\]\.click\(\)/);
    if (m) { clicks.push(Number(m[1])); onClick(Number(m[1])); return undefined; }
    if (expr.includes('.length')) return state.count;
    return undefined;
  };
  return { handler, clicks, state };
}

function visibility(isVisible) {
  return (expr) => (expr === 'document.visibilityState' ? (isVisible() ? 'visible' : 'hidden') : undefined);
}

const noSleep = async () => {};

// ── list() ───────────────────────────────────────────────────────────────

describe('list()', () => {
  it('lists chart pages and new-tab landings only, in target order', async () => {
    const fetch = mockFetch([SHELL, CHART_A, WORKER, LANDING, CHART_B]);
    const result = await list({ _deps: { fetch } });

    assert.equal(result.success, true);
    assert.equal(result.tab_count, 3);
    assert.deepEqual(result.tabs.map(t => t.id), ['A', 'L', 'B']);
    assert.deepEqual(result.tabs.map(t => t.index), [0, 1, 2]);
    assert.ok(fetch.urls[0].endsWith('/json/list'));
  });

  it('extracts chart_id, flags landing pages, and strips the marketing title', async () => {
    const fetch = mockFetch([CHART_A, LANDING, CHART_B]);
    const { tabs } = await list({ _deps: { fetch } });

    assert.deepEqual(tabs[0], {
      index: 0, id: 'A', title: 'TradingView', url: CHART_A.url, chart_id: 'abc123', is_chart: true,
    });
    assert.equal(tabs[1].chart_id, null);
    assert.equal(tabs[1].is_chart, false);
    assert.equal(tabs[2].chart_id, 'def456', 'query string is not part of chart_id');
  });

  it('returns an empty list when no chart targets exist', async () => {
    const result = await list({ _deps: { fetch: mockFetch([SHELL, WORKER]) } });
    assert.deepEqual(result, { success: true, tab_count: 0, tabs: [] });
  });
});

// ── switchTab() ──────────────────────────────────────────────────────────

describe('switchTab()', () => {
  it('rejects an out-of-range index without touching CDP', async () => {
    const CDP = mockCDP({});
    await assert.rejects(
      () => switchTab({ index: 5, _deps: { fetch: mockFetch([CHART_A, CHART_B]), CDP } }),
      /Tab index 5 out of range \(have 2 tabs\)/,
    );
    assert.equal(CDP.opened.length, 0);
  });

  it('rejects negative, fractional and non-numeric indexes before any request', async () => {
    for (const index of [-1, 1.5, 'abc', undefined]) {
      const fetch = mockFetch([CHART_A, CHART_B]);
      await assert.rejects(
        () => switchTab({ index, _deps: { fetch, CDP: mockCDP({}) } }),
        /Tab index must be a non-negative integer/,
        `index ${JSON.stringify(index)}`,
      );
      assert.equal(fetch.urls.length, 0, `no /json/list request for ${JSON.stringify(index)}`);
    }
  });

  it('skips shell clicks when the target is already visible, then re-attaches', async () => {
    const shell = shellWindow({ count: 2 });
    const CDP = mockCDP({ shell: shell.handler, B: visibility(() => true) });
    const reattached = [];
    const result = await switchTab({
      index: '1', // CLI passes positionals as strings
      _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, reconnectTo: async (id) => { reattached.push(id); }, sleep: noSleep },
    });

    assert.deepEqual(result, {
      success: true, action: 'switched', index: 1, tab_id: 'B', chart_id: 'def456', visually_switched: true,
    });
    assert.deepEqual(shell.clicks, []);
    assert.deepEqual(reattached, ['B']);
    assert.equal(CDP.opened.length, CDP.closed, 'every CDP client is closed');
  });

  it('clicks the same-ordinal shell tab first and stops once the target is visible', async () => {
    let visible = false;
    const shell = shellWindow({ count: 2, onClick: (k) => { if (k === 1) visible = true; } });
    const CDP = mockCDP({ shell: shell.handler, B: visibility(() => visible) });
    const result = await switchTab({
      index: 1,
      _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, reconnectTo: async () => {}, sleep: noSleep },
    });

    assert.equal(result.success, true);
    assert.deepEqual(shell.clicks, [1]);
    assert.equal(CDP.opened.length, CDP.closed, 'every CDP client is closed');
  });

  it('falls back to the other shell tabs when the ordinal does not match', async () => {
    let visible = false;
    const shell = shellWindow({ count: 3, onClick: (k) => { if (k === 2) visible = true; } });
    const CDP = mockCDP({ shell: shell.handler, A: visibility(() => visible) });
    await switchTab({
      index: 0,
      _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, reconnectTo: async () => {}, sleep: noSleep },
    });

    assert.deepEqual(shell.clicks, [0, 1, 2], 'ordinal 0 first, then the rest in order (deduplicated)');
  });

  it('throws after clicking every shell tab if the target never becomes visible', async () => {
    const shell = shellWindow({ count: 2 });
    const CDP = mockCDP({ shell: shell.handler, B: visibility(() => false) });
    let reattached = false;
    await assert.rejects(
      () => switchTab({
        index: 1,
        _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, reconnectTo: async () => { reattached = true; }, sleep: noSleep },
      }),
      /never became visible/,
    );
    assert.deepEqual(shell.clicks, [1, 0]);
    assert.equal(reattached, false);
  });

  it('treats an unreachable target as not visible', async () => {
    // No handler for B: connecting to it rejects, which must read as "hidden".
    const shell = shellWindow({ count: 2 });
    const CDP = mockCDP({ shell: shell.handler });
    await assert.rejects(
      () => switchTab({
        index: 1,
        _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, reconnectTo: async () => {}, sleep: noSleep },
      }),
      /never became visible/,
    );
  });

  it('wraps a re-attach failure with context', async () => {
    const CDP = mockCDP({ A: visibility(() => true) });
    await assert.rejects(
      () => switchTab({
        index: 0,
        _deps: { fetch: mockFetch([CHART_A]), CDP, reconnectTo: async () => { throw new Error('socket closed'); }, sleep: noSleep },
      }),
      /Tab is visible but failed to re-attach CDP to it: socket closed/,
    );
  });
});

// ── closeTab() ───────────────────────────────────────────────────────────

describe('closeTab()', () => {
  it('refuses to close the last tab', async () => {
    const shell = shellWindow({ count: 1 });
    const CDP = mockCDP({ shell: shell.handler });
    await assert.rejects(
      () => closeTab({ _deps: { fetch: mockFetch([SHELL, CHART_A]), CDP, getClient: async () => {}, sleep: noSleep } }),
      /Cannot close the last tab/,
    );
    assert.deepEqual(shell.clicks, []);
  });

  it('clicks the active tab close button and reports the new count', async () => {
    const shell = shellWindow({ count: 3 });
    const CDP = mockCDP({ shell: shell.handler });
    let clientRefreshed = false;
    const result = await closeTab({
      _deps: { fetch: mockFetch([SHELL, CHART_A, CHART_B]), CDP, getClient: async () => { clientRefreshed = true; }, sleep: noSleep },
    });

    assert.deepEqual(result, { success: true, action: 'tab_closed', tabs_before: 3, tabs_after: 2 });
    assert.deepEqual(shell.clicks, ['close']);
    assert.equal(clientRefreshed, true, 'cached client is re-resolved after closing');
    assert.equal(CDP.opened.length, CDP.closed, 'every CDP client is closed');
  });

  it('still succeeds when re-resolving the cached client fails', async () => {
    const shell = shellWindow({ count: 2 });
    const result = await closeTab({
      _deps: {
        fetch: mockFetch([SHELL, CHART_A]), CDP: mockCDP({ shell: shell.handler }),
        getClient: async () => { throw new Error('no chart target'); }, sleep: noSleep,
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.tabs_after, 1);
  });

  it('skips shell candidates that have no tab bar', async () => {
    const DECOY = { id: 'decoy', type: 'page', title: 'x', url: 'file:///C:/app/window/index.html' };
    const shell = shellWindow({ count: 2 });
    const CDP = mockCDP({ decoy: () => false, shell: shell.handler });
    const result = await closeTab({
      _deps: { fetch: mockFetch([DECOY, SHELL, CHART_A]), CDP, getClient: async () => {}, sleep: noSleep },
    });
    assert.equal(result.success, true);
    assert.equal(CDP.opened.length, CDP.closed, 'decoy clients are closed too');
  });

  it('surfaces a missing close button instead of retrying on another shell', async () => {
    const SHELL2 = { ...SHELL, id: 'shell2' };
    const first = shellWindow({ count: 2, closeResult: false });
    const second = shellWindow({ count: 2 });
    const CDP = mockCDP({ shell: first.handler, shell2: second.handler });
    await assert.rejects(
      () => closeTab({ _deps: { fetch: mockFetch([SHELL, SHELL2, CHART_A]), CDP, getClient: async () => {}, sleep: noSleep } }),
      /Close button not found on the active tab/,
    );
    assert.deepEqual(second.clicks, [], 'the close click is not repeated on another window');
    assert.equal(CDP.opened.length, CDP.closed, 'every CDP client is closed');
  });

  it('throws when no shell window is found', async () => {
    await assert.rejects(
      () => closeTab({ _deps: { fetch: mockFetch([CHART_A]), CDP: mockCDP({}), getClient: async () => {}, sleep: noSleep } }),
      /TradingView shell window \(tab bar\) not found/,
    );
  });
});

// ── newTab() ─────────────────────────────────────────────────────────────

describe('newTab() without a layout', () => {
  it('reuses an already-open landing tab instead of opening another', async () => {
    const shell = shellWindow({ count: 2 });
    const CDP = mockCDP({ shell: shell.handler });
    const result = await newTab({ _deps: { fetch: mockFetch([SHELL, CHART_A, LANDING]), CDP, sleep: noSleep } });

    assert.equal(result.success, true);
    assert.equal(result.action, 'new_tab_opened');
    assert.equal(result.tab_count, 2);
    assert.equal(CDP.opened.length, 0, 'no shell click when a landing tab already exists');
  });

  /** Shell whose new-tab button exists; clicking it adds a tab only if `adds`. */
  function shellWithNewTabButton({ count, adds }) {
    const shell = shellWindow({ count });
    const handler = (expr) => {
      if (!expr.includes('create-new-tab')) return shell.handler(expr);
      if (adds) shell.state.count++;
      return true;
    };
    return { handler };
  }

  it('reports success when the new-tab click adds a tab', async () => {
    const CDP = mockCDP({ shell: shellWithNewTabButton({ count: 1, adds: true }).handler });
    const result = await newTab({ _deps: { fetch: mockFetch([SHELL, CHART_A]), CDP, sleep: noSleep } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'new_tab_opened');
  });

  it('reports failure when the new-tab click does not add a tab', async () => {
    const CDP = mockCDP({ shell: shellWithNewTabButton({ count: 1, adds: false }).handler });
    const result = await newTab({ _deps: { fetch: mockFetch([SHELL, CHART_A]), CDP, sleep: noSleep } });
    assert.equal(result.success, false, "list()'s success: true must not overwrite the computed result");
    assert.equal(result.action, 'new_tab_opened');
    assert.equal(result.tab_count, 1);
  });

  it('surfaces a missing new-tab button', async () => {
    // shellWindow answers undefined to the create-new-tab click, i.e. no button.
    const shell = shellWindow({ count: 1 });
    const CDP = mockCDP({ shell: shell.handler });
    await assert.rejects(
      () => newTab({ _deps: { fetch: mockFetch([SHELL, CHART_A]), CDP, sleep: noSleep } }),
      /New-tab button not found in shell window/,
    );
    assert.equal(CDP.opened.length, CDP.closed, 'every CDP client is closed');
  });
});
