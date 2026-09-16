/**
 * Tests for src/core/ui.js via _deps injection — no live TradingView needed.
 * Covers: click, openPanel, fullscreen, layoutList, layoutSwitch, keyboard,
 * typeText, hover, scroll, mouseClick, findElement, uiEvaluate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, openPanel, fullscreen, layoutList, layoutSwitch, keyboard,
  typeText, hover, scroll, mouseClick, findElement, uiEvaluate,
} from '../src/core/ui.js';

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

/** Mock getClient whose Input domain records every dispatched event. */
function mockClient() {
  const events = { key: [], mouse: [], text: [] };
  const client = {
    Input: {
      dispatchKeyEvent: async (e) => { events.key.push(e); },
      dispatchMouseEvent: async (e) => { events.mouse.push(e); },
      insertText: async (e) => { events.text.push(e); },
    },
  };
  let requested = 0;
  const getClient = async () => { requested++; return client; };
  return { getClient, events, get requested() { return requested; } };
}

// ── click() ──────────────────────────────────────────────────────────────

describe('click()', () => {
  it('returns the clicked element details when found', async () => {
    const clicked = { found: true, tag: 'button', text: 'Save', aria_label: null, data_name: 'save' };
    const evaluate = mockEval(clicked);
    const result = await click({ by: 'text', value: 'Save', _deps: { evaluate } });
    assert.deepEqual(result, { success: true, clicked });
  });

  it('throws when no element matches', async () => {
    const evaluate = mockEval({ found: false });
    await assert.rejects(
      () => click({ by: 'aria-label', value: 'Nope', _deps: { evaluate } }),
      /No matching element found for aria-label="Nope"/,
    );
  });

  it('passes by/value through JSON.stringify, not raw interpolation', async () => {
    const evaluate = mockEval({ found: true });
    await click({ by: 'text', value: 'a"b\'c', _deps: { evaluate } });
    assert.ok(evaluate.calls[0].includes(JSON.stringify('a"b\'c')), 'value is JSON-encoded');
    assert.ok(evaluate.calls[0].includes('var by = "text"'), 'by is JSON-encoded');
  });
});

// ── openPanel() ──────────────────────────────────────────────────────────

describe('openPanel()', () => {
  it('reports was_open/performed for a bottom panel', async () => {
    const evaluate = mockEval({ was_open: false, performed: 'opened' });
    const result = await openPanel({ panel: 'pine-editor', action: 'open', _deps: { evaluate } });
    assert.deepEqual(result, { success: true, panel: 'pine-editor', action: 'open', was_open: false, performed: 'opened' });
  });

  it('maps strategy-tester to the backtesting widget', async () => {
    const evaluate = mockEval({ was_open: true, performed: 'closed' });
    await openPanel({ panel: 'strategy-tester', action: 'close', _deps: { evaluate } });
    assert.ok(evaluate.calls[0].includes('var widgetName = "backtesting"'));
  });

  it('throws the page-side error for a bottom panel', async () => {
    const evaluate = mockEval({ error: 'bottomWidgetBar not available' });
    await assert.rejects(
      () => openPanel({ panel: 'pine-editor', action: 'toggle', _deps: { evaluate } }),
      /bottomWidgetBar not available/,
    );
  });

  it('uses current and legacy selectors for side panels', async () => {
    const evaluate = mockEval({ was_open: false, performed: 'already_closed' });
    const result = await openPanel({ panel: 'watchlist', action: 'close', _deps: { evaluate } });
    assert.equal(result.performed, 'already_closed');
    assert.ok(evaluate.calls[0].includes('"base-watchlist-widget-button","base"'));
  });

  it('defaults was_open/performed when the page returns nothing', async () => {
    const evaluate = mockEval(undefined);
    const result = await openPanel({ panel: 'alerts', action: 'open', _deps: { evaluate } });
    assert.equal(result.was_open, false);
    assert.equal(result.performed, 'unknown');
  });
});

// ── fullscreen() ─────────────────────────────────────────────────────────

describe('fullscreen()', () => {
  it('toggles when the button exists', async () => {
    const evaluate = mockEval({ found: true });
    assert.deepEqual(await fullscreen({ _deps: { evaluate } }), { success: true, action: 'fullscreen_toggled' });
  });

  it('throws when the button is missing', async () => {
    const evaluate = mockEval({ found: false });
    await assert.rejects(() => fullscreen({ _deps: { evaluate } }), /Fullscreen button not found/);
  });
});

// ── layoutList() / layoutSwitch() ────────────────────────────────────────

describe('layoutList()', () => {
  it('returns layouts and their count', async () => {
    const layouts = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const evaluateAsync = mockEval({ layouts, source: 'internal_api' });
    const result = await layoutList({ _deps: { evaluateAsync } });
    assert.equal(result.layout_count, 2);
    assert.deepEqual(result.layouts, layouts);
    assert.equal(result.source, 'internal_api');
  });

  it('degrades to an empty list when the API returns nothing', async () => {
    const evaluateAsync = mockEval(undefined);
    const result = await layoutList({ _deps: { evaluateAsync } });
    assert.equal(result.success, true);
    assert.equal(result.layout_count, 0);
    assert.deepEqual(result.layouts, []);
  });
});

describe('layoutSwitch()', () => {
  it('throws the API error without touching the page further', async () => {
    const evaluateAsync = mockEval({ success: false, error: 'Layout "X" not found.' });
    const evaluate = mockEval();
    await assert.rejects(
      () => layoutSwitch({ name: 'X', _deps: { evaluate, evaluateAsync } }),
      /Layout "X" not found\./,
    );
    assert.equal(evaluate.calls.length, 0, 'no dialog-dismiss attempt after a failed switch');
  });

  it('returns the matched layout and dialog status on success', async () => {
    const evaluateAsync = mockEval({ success: true, id: 42, name: 'Swing', source: 'internal_api' });
    const evaluate = mockEval(false);
    const result = await layoutSwitch({ name: 'swing', _deps: { evaluate, evaluateAsync } });
    assert.deepEqual(result, {
      success: true, layout: 'Swing', layout_id: 42, source: 'internal_api',
      action: 'switched', unsaved_dialog_dismissed: false,
    });
    assert.ok(evaluateAsync.calls[0].includes('var target = "swing"'), 'name is JSON-encoded');
  });
});

// ── keyboard() / typeText() ──────────────────────────────────────────────

describe('keyboard()', () => {
  it('maps named keys and combines modifier bits', async () => {
    const mc = mockClient();
    const result = await keyboard({ key: 'Enter', modifiers: ['ctrl', 'shift'], _deps: { getClient: mc.getClient } });
    assert.deepEqual(result, { success: true, key: 'Enter', modifiers: ['ctrl', 'shift'] });
    assert.equal(mc.events.key.length, 2);
    assert.deepEqual(mc.events.key[0], { type: 'keyDown', modifiers: 2 | 8, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.deepEqual(mc.events.key[1], { type: 'keyUp', key: 'Enter', code: 'Enter' });
  });

  it('derives code and virtual key for unmapped letters', async () => {
    const mc = mockClient();
    const result = await keyboard({ key: 'a', _deps: { getClient: mc.getClient } });
    assert.deepEqual(result.modifiers, []);
    assert.equal(mc.events.key[0].code, 'KeyA');
    assert.equal(mc.events.key[0].windowsVirtualKeyCode, 65);
    assert.equal(mc.events.key[0].modifiers, 0);
  });
});

describe('typeText()', () => {
  it('inserts the full text but reports a 100-char preview', async () => {
    const mc = mockClient();
    const text = 'x'.repeat(150);
    const result = await typeText({ text, _deps: { getClient: mc.getClient } });
    assert.deepEqual(mc.events.text, [{ text }]);
    assert.equal(result.typed.length, 100);
    assert.equal(result.length, 150);
  });
});

// ── hover() / scroll() / mouseClick() ────────────────────────────────────

describe('hover()', () => {
  it('moves the mouse to the element center', async () => {
    const mc = mockClient();
    const evaluate = mockEval({ x: 10, y: 20, tag: 'button' });
    const result = await hover({ by: 'data-name', value: 'save', _deps: { evaluate, getClient: mc.getClient } });
    assert.deepEqual(mc.events.mouse, [{ type: 'mouseMoved', x: 10, y: 20 }]);
    assert.deepEqual(result.hovered, { by: 'data-name', value: 'save', tag: 'button', x: 10, y: 20 });
  });

  it('throws before dispatching anything when the element is missing', async () => {
    const mc = mockClient();
    const evaluate = mockEval(null);
    await assert.rejects(
      () => hover({ by: 'text', value: 'Ghost', _deps: { evaluate, getClient: mc.getClient } }),
      /Element not found for text="Ghost"/,
    );
    assert.equal(mc.requested, 0);
    assert.equal(mc.events.mouse.length, 0);
  });
});

describe('scroll()', () => {
  it('scrolls up by the 300px default at the chart center', async () => {
    const mc = mockClient();
    const evaluate = mockEval({ x: 400, y: 300 });
    const result = await scroll({ direction: 'up', _deps: { evaluate, getClient: mc.getClient } });
    assert.deepEqual(result, { success: true, direction: 'up', amount: 300 });
    assert.deepEqual(mc.events.mouse, [{ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -300 }]);
  });

  it('scrolls horizontally with an explicit amount', async () => {
    const mc = mockClient();
    const evaluate = mockEval({ x: 1, y: 2 });
    await scroll({ direction: 'left', amount: 50, _deps: { evaluate, getClient: mc.getClient } });
    assert.equal(mc.events.mouse[0].deltaX, -50);
    assert.equal(mc.events.mouse[0].deltaY, 0);
  });
});

describe('mouseClick()', () => {
  it('sends move/press/release with the right-button mapping', async () => {
    const mc = mockClient();
    const result = await mouseClick({ x: 5, y: 6, button: 'right', _deps: { getClient: mc.getClient } });
    assert.deepEqual(result, { success: true, x: 5, y: 6, button: 'right', double_click: false });
    assert.deepEqual(mc.events.mouse.map(e => e.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(mc.events.mouse[1].buttons, 2);
  });

  it('defaults unknown buttons to left and adds a second click for double_click', async () => {
    const mc = mockClient();
    const result = await mouseClick({ x: 1, y: 1, button: 'bogus', double_click: true, _deps: { getClient: mc.getClient } });
    assert.equal(result.button, 'left');
    assert.equal(result.double_click, true);
    assert.deepEqual(mc.events.mouse.map(e => e.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
    assert.equal(mc.events.mouse[3].clickCount, 2);
    assert.equal(mc.events.mouse[1].buttons, 0);
  });
});

// ── findElement() / uiEvaluate() ─────────────────────────────────────────

describe('findElement()', () => {
  it('defaults to the text strategy and counts results', async () => {
    const evaluate = mockEval([{ tag: 'button' }, { tag: 'span' }]);
    const result = await findElement({ query: 'Buy', _deps: { evaluate } });
    assert.equal(result.strategy, 'text');
    assert.equal(result.count, 2);
    assert.ok(evaluate.calls[0].includes('var query = "Buy"'), 'query is JSON-encoded');
  });

  it('returns an empty list when the page returns nothing', async () => {
    const evaluate = mockEval(null);
    const result = await findElement({ query: '.x', strategy: 'css', _deps: { evaluate } });
    assert.deepEqual(result, { success: true, query: '.x', strategy: 'css', count: 0, elements: [] });
  });
});

describe('uiEvaluate()', () => {
  it('passes the expression through verbatim and returns its result', async () => {
    const evaluate = mockEval({ answer: 42 });
    const result = await uiEvaluate({ expression: 'window.__x', _deps: { evaluate } });
    assert.deepEqual(evaluate.calls, ['window.__x']);
    assert.deepEqual(result, { success: true, result: { answer: 42 } });
  });
});
