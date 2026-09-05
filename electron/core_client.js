/**
 * core_client.js — talks to the `revery-exif-core` sidecar.
 *
 * The Tauri shell links the Rust core directly. Electron cannot, so it spawns
 * the same code as a child process and speaks JSON lines to it. This module is
 * the whole of that conversation, and is pure logic so it can be unit-tested
 * without spawning anything (see `test/core_client.test.js`).
 *
 * Requests are matched to responses by `id`, never by ordering — the same rule
 * the ExifTool session follows, for the same reason: a response attributed to
 * the wrong request means showing one photo's metadata under another's name.
 */

'use strict';

const { spawn } = require('node:child_process');

/** How long a single request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Splits a stream of bytes into complete lines.
 *
 * A chunk boundary can fall anywhere, including mid-object, so partial lines
 * are carried over rather than parsed. Without this a large metadata response
 * arrives as two chunks and both halves fail to parse.
 */
function createLineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Routes framed responses back to their callers.
 *
 * Separated from the process handling so the matching logic is testable on its
 * own; `attach` returns the function to feed stdout chunks into.
 */
function createDispatcher() {
  const pending = new Map();
  let nextId = 1;

  return {
    /** Registers a request and returns its id plus a promise for the answer. */
    open(onTimeout) {
      const id = nextId++;
      let settle;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The metadata engine did not answer request ${id} in time.`));
          if (onTimeout) onTimeout();
        }, REQUEST_TIMEOUT_MS);
        // A request still in flight must not keep the process alive. Without
        // this, quitting during a long batch leaves Electron running invisibly
        // until the timeout expires two minutes later.
        if (typeof timer.unref === 'function') timer.unref();
        settle = { resolve, reject, timer };
      });
      pending.set(id, settle);
      return { id, promise };
    },

    /** Handles one line of output. Returns false if it could not be routed. */
    accept(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        return false;
      }
      const entry = pending.get(message.id);
      if (!entry) return false;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error || 'The metadata engine failed.'));
      return true;
    },

    /** Fails everything still waiting — the child died. */
    abortAll(reason) {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      pending.clear();
    },

    get outstanding() {
      return pending.size;
    },
  };
}

/**
 * Starts the sidecar and returns `{ call, dispose }`.
 *
 * `call(cmd, args)` resolves with the command's result or rejects with the
 * engine's own error text, so the frontend shows the same message under either
 * shell.
 */
function createCoreClient(executablePath) {
  const dispatcher = createDispatcher();
  let child = null;
  let stderrTail = '';

  function start() {
    child = spawn(executablePath, ['--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell: the path may contain spaces, and a shell would also make the
      // argument list vulnerable to whatever is in it.
      shell: false,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', createLineReader((line) => dispatcher.accept(line)));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Kept so a startup failure — a missing ExifTool, say — can be reported
      // instead of surfacing as an unexplained closed pipe.
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('exit', (code) => {
      const detail = stderrTail.trim();
      dispatcher.abortAll(
        `The metadata engine stopped (exit ${code}).` + (detail ? ` ${detail}` : '')
      );
      child = null;
    });
  }

  start();

  return {
    call(cmd, args = {}) {
      if (!child) {
        // Restart on demand: a crashed engine should cost one failed action,
        // not the rest of the session.
        start();
      }
      const { id, promise } = dispatcher.open();
      try {
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      } catch (error) {
        dispatcher.abortAll(`Could not reach the metadata engine: ${error.message}`);
        return Promise.reject(error);
      }
      return promise;
    },

    dispose() {
      if (child) {
        child.stdin.end();
        child.kill();
        child = null;
      }
      dispatcher.abortAll('Shutting down.');
    },
  };
}

module.exports = { createCoreClient, createDispatcher, createLineReader };
