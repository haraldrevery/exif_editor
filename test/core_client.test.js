/**
 * The Electron↔sidecar RPC framing.
 *
 * Pure logic, tested without spawning anything. The two failure modes that
 * matter are a response reaching the wrong caller, and a chunk boundary
 * falling inside a JSON object.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher, createLineReader } = require('../electron/core_client.js');

/* ── Line framing ────────────────────────────────────────────────────────── */

test('a JSON object split across chunks is reassembled', () => {
  const lines = [];
  const feed = createLineReader((line) => lines.push(line));
  // A large metadata response arrives as several chunks, and the boundary can
  // fall anywhere — including mid-key. Parsing each chunk would fail on both
  // halves and lose the response entirely.
  feed('{"id":1,"ok":tr');
  assert.deepEqual(lines, [], 'emitted an incomplete line');
  feed('ue,"result":42}\n');
  assert.deepEqual(lines, ['{"id":1,"ok":true,"result":42}']);
});

test('several objects in one chunk all come through', () => {
  const lines = [];
  createLineReader((line) => lines.push(line))('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(lines.length, 3);
});

test('blank lines are ignored', () => {
  const lines = [];
  createLineReader((line) => lines.push(line))('\n\n{"a":1}\n\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

/* ── Response matching ───────────────────────────────────────────────────── */

test('responses reach their own caller, whatever order they arrive in', async () => {
  const d = createDispatcher();
  const first = d.open();
  const second = d.open();
  assert.notEqual(first.id, second.id, 'ids must be unique');

  // Answered out of order on purpose. Matching by arrival would hand the
  // second caller the first one's metadata — one photo's tags shown under
  // another photo's name.
  d.accept(JSON.stringify({ id: second.id, ok: true, result: 'second' }));
  d.accept(JSON.stringify({ id: first.id, ok: true, result: 'first' }));

  assert.equal(await first.promise, 'first');
  assert.equal(await second.promise, 'second');
  assert.equal(d.outstanding, 0);
});

test('an error response rejects with the engine wording', async () => {
  const d = createDispatcher();
  const request = d.open();
  d.accept(JSON.stringify({ id: request.id, ok: false, error: 'No folder is open' }));
  // The user must see the same message under either shell, so it is passed
  // through rather than replaced with something generic.
  await assert.rejects(request.promise, /No folder is open/);
});

test('an unknown or malformed response is ignored, not routed', () => {
  const d = createDispatcher();
  const request = d.open();
  assert.equal(d.accept('not json at all'), false);
  assert.equal(d.accept(JSON.stringify({ id: 9999, ok: true })), false);
  // The real request is still waiting rather than resolved with nothing.
  assert.equal(d.outstanding, 1);
  d.accept(JSON.stringify({ id: request.id, ok: true, result: 1 }));
  assert.equal(d.outstanding, 0);
});

test('a dead engine fails everything waiting instead of hanging', async () => {
  const d = createDispatcher();
  const a = d.open();
  const b = d.open();
  d.abortAll('The metadata engine stopped (exit 1).');
  // Silence here would leave the UI spinning forever on a write the user
  // needs to know did not happen.
  await assert.rejects(a.promise, /engine stopped/);
  await assert.rejects(b.promise, /engine stopped/);
  assert.equal(d.outstanding, 0);
});

test('ids are never reused within a session', async () => {
  const d = createDispatcher();
  const seen = new Set();
  const waiting = [];
  for (let i = 0; i < 50; i += 1) {
    const { id, promise } = d.open();
    assert.ok(!seen.has(id), `id ${id} was reused`);
    seen.add(id);
    // Settled below; an unhandled rejection would fail the run.
    waiting.push(promise.catch(() => {}));
  }
  d.abortAll('test over');
  await Promise.all(waiting);
});
