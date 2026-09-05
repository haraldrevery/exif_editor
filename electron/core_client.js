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
 * Prefix marking an error where **we do not know what the engine did**.
 *
 * The renderer used to treat every rejection as a pre-flight refusal and say
 * "Nothing was changed", reasoning that the backend validates the whole batch
 * before writing a single file. That is true of errors the *engine* returns.
 * It is not true of errors this module produces: a request that outran
 * `REQUEST_TIMEOUT_MS` — which a few hundred files will — or a child that died
 * mid-batch both reject here while the write may well be continuing.
 *
 * Telling someone their photos are untouched at the moment they are being
 * replaced is bad on its own. It is worse because the natural response is to
 * press the button again, and the date shift is cumulative (`-AllDates+=`).
 *
 * A string prefix rather than a property on the Error because Electron's
 * `ipcRenderer.invoke` serialises rejections down to their message and drops
 * everything else. `native_api.js` strips this and re-raises with a real flag
 * once the value is back in the renderer's own JavaScript context.
 */
const UNCONFIRMED = 'E_UNCONFIRMED:';

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
          // Unconfirmed, not failed: the engine is very likely still writing.
          reject(
            new Error(
              `${UNCONFIRMED} The metadata engine did not answer in time ` +
                `(over ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s).`
            )
          );
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

    /**
     * Fails everything still waiting — the child died.
     *
     * Always unconfirmed: a batch cut off halfway has written some of its
     * files, and nothing here can say which.
     */
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

/** Commands the sidecar answers without an open folder. */
const ROOTLESS_COMMANDS = ['engine_version', 'writable_tags', 'undo_available'];

/**
 * Starts the sidecar and returns `{ call, dispose }`.
 *
 * `call(cmd, args)` resolves with the command's result or rejects with the
 * engine's own error text, so the frontend shows the same message under either
 * shell.
 */
function createCoreClient(executablePath, options = {}) {
  // Injectable so the tests can hold on to the child and kill it, rather than
  // this module carrying a `_killForTest` method on the object the app uses.
  // Defaults to the real thing, so no caller outside the tests passes it.
  const spawnProcess = options.spawn || spawn;
  const dispatcher = createDispatcher();
  let child = null;
  let stderrTail = '';
  /**
   * The folder the *current* child has been told about.
   *
   * The sidecar keeps the open library root in its own process memory, so a
   * restarted engine starts with no folder open and every path-taking command
   * fails with "No folder is open" — for the rest of the session, with nothing
   * on screen explaining why and no way back short of re-picking the folder.
   *
   * So the last successful `open_library` is remembered and replayed before
   * the next command whenever the child has been replaced. Undo does not
   * survive it: `open_library` sweeps the undo store, and after an engine
   * crash it was unreachable anyway — the root it is keyed to went with the
   * process. The button disappears on the next `undo_available` poll, which is
   * the honest answer.
   */
  let openFolder = null;
  let needsReopen = false;
  /** Set by `dispose`, so a late call cannot resurrect the engine after quit. */
  let disposed = false;

  function start() {
    // **Bound to `mine`, never to `child`.** Every listener below outlives the
    // process it was attached to, and a dead child can still emit: EPIPE on
    // stdin is queued asynchronously and can arrive *after* 'exit', by which
    // time a replacement may already be running. A listener that acted on
    // whatever was current would then drop the new engine and abort its
    // in-flight requests, turning one crash into a cascade.
    const mine = spawnProcess(executablePath, ['--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell: the path may contain spaces, and a shell would also make the
      // argument list vulnerable to whatever is in it.
      shell: false,
    });
    child = mine;

    // **Both of these are required, not defensive.** An 'error' event with no
    // listener is an uncaught exception, and Node delivers EPIPE on a closed
    // pipe *asynchronously* — so the try/catch around `stdin.write` below
    // never sees it. Without these, an engine crash during a write took the
    // whole app down, along with every unapplied draft in the renderer.
    mine.on('error', (error) => {
      failChild(mine, `could not be started or was lost: ${error.message}`);
    });
    mine.stdin.on('error', (error) => {
      failChild(mine, `stopped accepting requests: ${error.message}`);
    });

    mine.stdout.setEncoding('utf8');
    // Safe to feed in even from a superseded child: ids are monotonic for the
    // life of the client, so a late response can only carry one that has
    // already been settled, and the dispatcher drops what it cannot route.
    mine.stdout.on('data', createLineReader((line) => dispatcher.accept(line)));

    mine.stderr.setEncoding('utf8');
    mine.stderr.on('data', (chunk) => {
      // Kept so a startup failure — a missing ExifTool, say — can be reported
      // instead of surfacing as an unexplained closed pipe. Ignored once this
      // child is no longer the current one, or a dead engine's last words
      // would be appended to its replacement's first error.
      if (child === mine) stderrTail = (stderrTail + chunk).slice(-2000);
    });

    mine.on('exit', (code) => {
      failChild(mine, `stopped (exit ${code}).`);
    });
  }

  /**
   * Drops `which` and fails everything waiting on it — if it is still current.
   *
   * The identity check is the whole point; see `start`. Reached from three
   * events that can fire in any order and more than once, so it is also
   * written to be idempotent.
   */
  function failChild(which, what) {
    if (child !== which) return;
    child = null;
    // The next call re-opens the folder before anything else it is asked to do.
    needsReopen = openFolder !== null;
    const detail = stderrTail.trim();
    stderrTail = '';
    dispatcher.abortAll(
      `${UNCONFIRMED} The metadata engine ${what}` + (detail ? ` ${detail}` : '')
    );
  }

  /**
   * Sends one framed request, starting the engine if it is not running.
   *
   * The liveness check is here rather than at the call site because `call`
   * awaits in the middle — the replay below — and the child can die during
   * that await. Reading `child.stdin` on a dead one is a TypeError, which is
   * not something any caller is prepared for.
   */
  function send(cmd, args) {
    if (disposed) {
      return Promise.reject(new Error('The metadata engine has shut down.'));
    }
    if (!child) start();
    const { id, promise } = dispatcher.open();
    try {
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    } catch (error) {
      // Synchronous failures only; EPIPE arrives on the stream listener above.
      failChild(child, `could not be reached: ${error.message}`);
    }
    return promise;
  }

  start();

  return {
    async call(cmd, args = {}) {
      // Re-open before anything that needs a root. `open_library` itself is
      // excluded or this would recurse; the commands that need no root are
      // excluded because failing them on an unrelated re-open would be worse
      // than letting them through. `send` starts the engine if it is down.
      if (needsReopen && cmd !== 'open_library' && !ROOTLESS_COMMANDS.includes(cmd)) {
        try {
          await send('open_library', { path: openFolder });
          // Cleared only on success, so a re-open that fails is tried again on
          // the next command rather than leaving the session rootless for good.
          needsReopen = false;
        } catch (error) {
          throw new Error(
            `The metadata engine restarted and could not re-open ${openFolder}: ` +
              `${error.message}`
          );
        }
      }

      const result = await send(cmd, args);
      if (cmd === 'open_library') {
        openFolder = (args && args.path) || null;
        needsReopen = false;
      }
      return result;
    },

    dispose() {
      disposed = true;
      if (child) {
        const dying = child;
        child = null;
        // Asked to leave before being killed, so the sidecar can shut its own
        // ExifTool child down rather than leaving a `-stay_open` process
        // behind. SIGTERM skips Rust's Drop, and that process never exits on
        // its own by design.
        try {
          dying.stdin.end();
        } catch (_) {
          /* already gone */
        }
        dying.kill();
      }
      openFolder = null;
      needsReopen = false;
      dispatcher.abortAll('Shutting down.');
    },
  };
}

module.exports = { createCoreClient, createDispatcher, createLineReader, UNCONFIRMED };
