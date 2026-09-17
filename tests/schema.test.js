/**
 * Tests for the shared tool-parameter schemas in src/tools/_schema.js,
 * and for the tools that use them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { booleanParam, indexParam, numberParam } from '../src/tools/_schema.js';
import { registerAlertTools } from '../src/tools/alerts.js';
import { registerBatchTools } from '../src/tools/batch.js';
import { registerChartTools } from '../src/tools/chart.js';
import { registerDataTools } from '../src/tools/data.js';
import { registerDrawingTools } from '../src/tools/drawing.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerIndicatorTools } from '../src/tools/indicators.js';
import { registerPaneTools } from '../src/tools/pane.js';
import { registerReplayTools } from '../src/tools/replay.js';
import { registerUiTools } from '../src/tools/ui.js';
import { registerTabTools } from '../src/tools/tab.js';

const REGISTER = [
  registerAlertTools, registerBatchTools, registerChartTools, registerDataTools, registerDrawingTools,
  registerHealthTools, registerIndicatorTools, registerPaneTools, registerReplayTools, registerUiTools, registerTabTools,
];

/** Collects each tool's parameter shape without starting a server. */
function toolShapes() {
  const shapes = new Map();
  const server = { tool: (name, _description, shape) => { shapes.set(name, shape); } };
  for (const register of REGISTER) register(server);
  return shapes;
}

/** Looks up a tool parameter's schema; "point.time" reaches into an object parameter. */
function toolParam(tool, path) {
  const [name, field] = path.split('.');
  let schema = toolShapes().get(tool)[name];
  if (field) {
    if (schema instanceof z.ZodOptional) schema = schema.unwrap();
    schema = schema.shape[field];
  }
  return schema;
}

/** Lists the tools the way an MCP client sees them. */
async function listedTools() {
  const server = new McpServer({ name: 'schema-test', version: '0' });
  for (const register of REGISTER) register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'schema-test', version: '0' });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

/** Reads a parameter's JSON schema as advertised; "point.time" reaches into an object parameter. */
function advertised(tools, tool, path) {
  const [name, field] = path.split('.');
  const property = tools.find((t) => t.name === tool).inputSchema.properties[name];
  return field ? property.properties[field] : property;
}

// Every tool parameter that used z.coerce.number(), which read "", " ", null
// and false as 0 and true as 1.
const NUMBER_PARAMS = [
  ['alert_create', 'price'],
  ['batch_run', 'delay_ms'], ['batch_run', 'ohlcv_count'],
  ['chart_set_visible_range', 'from'], ['chart_set_visible_range', 'to'],
  ['data_get_ohlcv', 'count'], ['data_get_trades', 'max_trades'], ['data_get_pine_labels', 'max_labels'],
  ['draw_shape', 'point.time'], ['draw_shape', 'point.price'],
  ['draw_shape', 'point2.time'], ['draw_shape', 'point2.price'],
  ['tv_launch', 'port'],
  ['indicator_search', 'limit'],
  ['replay_autoplay', 'speed'],
  ['ui_scroll', 'amount'], ['ui_mouse_click', 'x'], ['ui_mouse_click', 'y'],
];
const INDEX_PARAMS = [
  ['alert_delete', 'alert_id'],
  ['pane_focus', 'index'], ['pane_set_symbol', 'index'],
  ['tab_switch', 'index'],
];

// ── booleanParam() ───────────────────────────────────────────────────────

describe('booleanParam()', () => {
  const schema = booleanParam();

  it('accepts booleans and the words true/false in any case', () => {
    for (const [input, expected] of [
      [true, true], [false, false],
      ['true', true], ['false', false],
      ['False', false], [' TRUE ', true],
    ]) {
      assert.equal(schema.parse(input), expected, `input ${JSON.stringify(input)}`);
    }
  });

  // The regression: z.coerce.boolean() used Boolean(value), so these all became true.
  it('rejects anything else instead of guessing', () => {
    for (const input of ['0', '1', 'yes', 'no', '', ' ', null, 0, 1, [], {}]) {
      assert.equal(schema.safeParse(input).success, false, `input ${JSON.stringify(input)}`);
    }
  });

  it('stays optional when wrapped with .optional()', () => {
    const optional = booleanParam().optional();
    assert.equal(optional.parse(undefined), undefined);
    assert.equal(optional.parse('false'), false);
  });
});

// ── indexParam() ─────────────────────────────────────────────────────────

describe('indexParam()', () => {
  const schema = indexParam();

  it('accepts non-negative integers and digit strings', () => {
    for (const [input, expected] of [[0, 0], [2, 2], ['0', 0], ['2', 2], [' 3 ', 3], ['01', 1]]) {
      assert.equal(schema.parse(input), expected, `input ${JSON.stringify(input)}`);
    }
  });

  // The regression: z.coerce.number() read the first four of these as 0.
  it('rejects blanks, null, booleans, negatives, fractions and other strings', () => {
    for (const input of ['', ' ', null, false, true, -1, 1.5, '-1', '1.5', '0x1', 'abc', NaN, []]) {
      assert.equal(schema.safeParse(input).success, false, `input ${JSON.stringify(input)}`);
    }
  });

  it('is what tab_switch uses for index', () => {
    const index = toolShapes().get('tab_switch').index;
    assert.equal(index.parse('1'), 1);
    assert.equal(index.safeParse('').success, false);
  });

  it('is what alert_delete uses for alert_id', () => {
    const alertId = toolShapes().get('alert_delete').alert_id;
    assert.equal(alertId.parse('123'), 123);
    assert.equal(alertId.parse(undefined), undefined);
    for (const input of ['', null, false, true, 'abc', 1.5, -1]) {
      assert.equal(alertId.safeParse(input).success, false, `input ${JSON.stringify(input)}`);
    }
  });
});

// ── numberParam() ────────────────────────────────────────────────────────

describe('numberParam()', () => {
  const schema = numberParam();

  it('accepts finite numbers and numeric strings', () => {
    for (const [input, expected] of [[0, 0], [4500.25, 4500.25], [-3, -3], ['4500.25', 4500.25], [' 12 ', 12], ['1e3', 1000]]) {
      assert.equal(schema.parse(input), expected, `input ${JSON.stringify(input)}`);
    }
  });

  // The regression: z.coerce.number() read the first four of these as 0.
  it('rejects blanks, null, booleans, non-finite values and other strings', () => {
    for (const input of ['', ' ', null, false, true, 'abc', '1; alert(1)', NaN, Infinity, 'Infinity', [], [5], {}]) {
      assert.equal(schema.safeParse(input).success, false, `input ${String(input)}`);
    }
  });

  it('is what alert_create uses for price', () => {
    const price = toolShapes().get('alert_create').price;
    assert.equal(price.parse('4500.5'), 4500.5);
    assert.equal(price.safeParse('').success, false);
    assert.equal(price.safeParse(null).success, false);
  });
});

// ── Tools that take booleans ─────────────────────────────────────────────

describe('boolean tool parameters', () => {
  it('alert_delete reads delete_all: "false" as false', () => {
    const params = z.object(toolShapes().get('alert_delete')).parse({ alert_id: 123, delete_all: 'false' });
    assert.equal(params.delete_all, false);
  });

  it('tv_launch reads kill_existing: "false" as false', () => {
    const params = z.object(toolShapes().get('tv_launch')).parse({ kill_existing: 'false' });
    assert.equal(params.kill_existing, false);
  });

  it('indicator_toggle_visibility reads visible: "false" as false', () => {
    const shape = toolShapes().get('indicator_toggle_visibility');
    assert.ok(shape.visible, 'expected a visible parameter');
    assert.equal(shape.visible.parse('false'), false);
  });

  it('no tool file uses z.coerce.boolean()', () => {
    const toolsDir = fileURLToPath(new URL('../src/tools/', import.meta.url));
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(toolsDir + file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*'))
        .join('\n');
      assert.doesNotMatch(source, /z\.coerce\.boolean\(/, `${file} should use booleanParam()`);
    }
  });

  it('advertises the parameters as plain booleans to MCP clients', async () => {
    const tools = await listedTools();
    for (const [tool, name] of [
      ['alert_delete', 'delete_all'],
      ['tv_launch', 'kill_existing'],
      ['indicator_toggle_visibility', 'visible'],
      ['data_get_ohlcv', 'summary'],
      ['ui_mouse_click', 'double_click'],
    ]) {
      assert.equal(advertised(tools, tool, name).type, 'boolean', `${tool}.${name}`);
    }
  });
});

// ── Tools that take numbers ──────────────────────────────────────────────

describe('number tool parameters', () => {
  it('accept numbers and numeric strings', () => {
    for (const [tool, path] of NUMBER_PARAMS) {
      assert.equal(toolParam(tool, path).parse('12.5'), 12.5, `${tool}.${path}`);
      assert.equal(toolParam(tool, path).parse(-3), -3, `${tool}.${path}`);
    }
    for (const [tool, path] of INDEX_PARAMS) {
      assert.equal(toolParam(tool, path).parse('12'), 12, `${tool}.${path}`);
      assert.equal(toolParam(tool, path).parse(0), 0, `${tool}.${path}`);
    }
  });

  it('reject blanks, null and booleans instead of reading them as 0 or 1', () => {
    for (const [tool, path] of [...NUMBER_PARAMS, ...INDEX_PARAMS]) {
      for (const input of ['', ' ', null, false, true, 'abc']) {
        assert.equal(toolParam(tool, path).safeParse(input).success, false, `${tool}.${path} with ${JSON.stringify(input)}`);
      }
    }
  });

  it('reject negative and fractional indexes', () => {
    for (const [tool, path] of INDEX_PARAMS) {
      for (const input of [-1, 1.5, '-1', '1.5']) {
        assert.equal(toolParam(tool, path).safeParse(input).success, false, `${tool}.${path} with ${JSON.stringify(input)}`);
      }
    }
  });

  it('no tool file uses z.coerce.number()', () => {
    const toolsDir = fileURLToPath(new URL('../src/tools/', import.meta.url));
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(toolsDir + file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*'))
        .join('\n');
      assert.doesNotMatch(source, /z\.coerce\.number\(/, `${file} should use numberParam() or indexParam()`);
    }
  });

  it('advertises numbers as numbers and indexes as non-negative integers to MCP clients', async () => {
    const tools = await listedTools();
    for (const [tool, path] of NUMBER_PARAMS) {
      assert.equal(advertised(tools, tool, path).type, 'number', `${tool}.${path}`);
    }
    for (const [tool, path] of INDEX_PARAMS) {
      assert.equal(advertised(tools, tool, path).type, 'integer', `${tool}.${path}`);
      assert.equal(advertised(tools, tool, path).minimum, 0, `${tool}.${path}`);
    }
  });
});
