//! ExifTool session layer — one persistent process, framed request/response.
//!
//! ExifTool is a Perl program with ~200 ms of interpreter startup. Spawning it
//! per file makes a 500-photo folder unusable, so the app keeps exactly one
//! process alive in `-stay_open` mode and streams requests to its stdin.
//!
//! # The protocol
//!
//! Arguments are written to stdin one per line. A batch is terminated by
//! `-execute<N>`, and ExifTool answers with `{ready<N>}` on **stdout** once it
//! has finished. `-echo4 {err<N>}` makes it emit a matching marker on
//! **stderr**, so both streams are framed by the same sequence number.
//!
//! Verified behaviour (see the tests, and `-echo4` empirically):
//!   * `{err<N>}` is emitted unconditionally — including when nothing went
//!     wrong — so waiting for it never hangs on a clean request.
//!   * Warning and error text for request N arrives *before* `{err<N>}`.
//!   * A request that fails outright produces **no stdout at all**, only the
//!     `{ready<N>}` terminator. Empty stdout is therefore not "success with no
//!     data"; the stderr channel is the only signal, which is why it is framed
//!     rather than merely drained.
//!
//! # Why the sequence number matters
//!
//! Responses could be matched by ordering alone, since ExifTool handles one
//! `-execute` at a time. They are matched by number instead so that a desync —
//! a marker appearing inside file *content*, a half-written request, a crashed
//! and silently restarted child — is detected and turned into an error rather
//! than returning one photo's metadata under another photo's name. Handing the
//! user the wrong file's tags is the failure that silently corrupts a library.
//!
//! Two things make that hold across a respawn, and both were once assumed
//! rather than arranged. The counter lives on the **session**, so a number is
//! never reused by a later child; and each child gets its **own** stderr
//! channel, so an outgoing reader thread cannot file a chunk — or an EOF —
//! against the child that replaced it. See `ExifToolSession::next_seq` and
//! `Inner::stderr`.
//!
//! # Threading
//!
//! stderr gets its own reader thread. This is not for speed: if stderr's pipe
//! buffer fills while the calling thread is blocked reading stdout, ExifTool
//! blocks writing to it and the whole session deadlocks. Draining both streams
//! concurrently is a correctness requirement, not an optimisation.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// Guard against a desynchronised stream wedging the app forever. ExifTool
/// finishes ordinary reads in milliseconds; a batch geotag of thousands of
/// files is the slow case, so this is generous rather than tight.
const RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// One completed request.
#[derive(Debug, Clone)]
pub struct ExifResponse {
    /// Everything ExifTool wrote to stdout, markers stripped.
    pub stdout: String,
    /// Everything it wrote to stderr, markers stripped. Warnings are common
    /// and harmless (`Warning: [minor] ...`); errors are not.
    pub stderr: String,
}

impl ExifResponse {
    /// True when stderr carries a hard `Error:` line. Warnings do not count —
    /// ExifTool warns about recoverable oddities on a great many perfectly
    /// good files, and treating those as failures would make the app refuse
    /// to open normal photo libraries.
    pub fn has_error(&self) -> bool {
        self.stderr
            .lines()
            .any(|line| line.trim_start().starts_with("Error:"))
    }

    /// The error lines only, for surfacing to the user.
    pub fn error_text(&self) -> String {
        self.stderr
            .lines()
            .filter(|line| line.trim_start().starts_with("Error:"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Framed stderr, filled by the reader thread and drained by the caller.
#[derive(Default)]
struct StderrChannel {
    /// Completed chunks by sequence number, awaiting collection.
    ready: HashMap<u64, String>,
    /// Lines seen since the last marker — i.e. belonging to the next number.
    pending: Vec<String>,
    /// Set when the stream hits EOF, so a waiter fails instead of hanging.
    closed: bool,
}

struct Inner {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    /// **This child's own channel, not the session's.**
    ///
    /// It used to be one channel shared for the life of the session, reset by
    /// `spawn`. The reset was not enough: the previous child's reader thread is
    /// still alive at that moment and takes the lock per line, so after the
    /// reset it could still file a chunk under a number the *new* child was
    /// about to use, or reach EOF and set `closed` on the fresh channel — at
    /// which point `take_stderr` returns `Ok("")`, `has_error()` is false, and
    /// a write ExifTool refused reads as one that succeeded.
    ///
    /// Giving each child its own channel retires that whole class: an orphaned
    /// reader writes into an `Arc` nothing will ever read again, and drops it
    /// when it exits.
    stderr: Arc<(Mutex<StderrChannel>, Condvar)>,
}

pub struct ExifToolSession {
    exe: PathBuf,
    /// `None` until first use and after a crash; respawned on demand.
    inner: Mutex<Option<Inner>>,
    /// Monotonic **for the life of the session**, which is what the desync
    /// check needs and what this field used to only claim.
    ///
    /// It lived on `Inner` and was initialised to 1 there, so every respawn
    /// restarted the numbering — after a crash, or after `execute`'s own retry
    /// calls `discard_child`. The doc comment said "never reused within a
    /// session" while the code guaranteed only "never reused by one child".
    next_seq: AtomicU64,
}

impl ExifToolSession {
    /// Wraps an ExifTool executable. Does not spawn — the process starts on
    /// the first request, so app launch is not blocked by Perl startup.
    pub fn new(exe: impl Into<PathBuf>) -> Self {
        Self {
            exe: exe.into(),
            inner: Mutex::new(None),
            next_seq: AtomicU64::new(1),
        }
    }

    /// Locates the vendored ExifTool for the current platform.
    ///
    /// `resource_dir` is the app's bundled-resource root at runtime, or the
    /// repo root in development.
    pub fn locate(resource_dir: &Path) -> Result<PathBuf, String> {
        let candidate = if cfg!(windows) {
            resource_dir.join("vendor/exiftool-windows/exiftool.exe")
        } else {
            resource_dir.join("vendor/exiftool-unix/exiftool")
        };
        if candidate.is_file() {
            return Ok(candidate);
        }
        Err(format!(
            "The bundled ExifTool is missing (looked in {}). \
             Run `python3 build_tools/fetch_exiftool.py --all` to restore it.",
            candidate.display()
        ))
    }

    /// Runs one request. `args` are ExifTool arguments, one per element,
    /// exactly as they would appear in an `-@` argument file.
    ///
    /// Blocks until the response is framed. Requests are serialised: ExifTool
    /// handles one `-execute` at a time regardless, so there is nothing to win
    /// by pipelining, and serialising keeps the desync check meaningful.
    pub fn execute(&self, args: &[String]) -> Result<ExifResponse, String> {
        // One retry, because the interesting failure is a child that died
        // between requests (OOM killer, user killed it, upgrade swapped the
        // binary). Respawning and retrying turns that into a hiccup. A second
        // failure is real and is reported.
        match self.execute_once(args) {
            Ok(response) => Ok(response),
            Err(first) => {
                self.discard_child();
                self.execute_once(args)
                    .map_err(|second| format!("{first}; retry also failed: {second}"))
            }
        }
    }

    fn execute_once(&self, args: &[String]) -> Result<ExifResponse, String> {
        let mut guard = self.inner.lock().map_err(|_| poisoned())?;
        if guard.is_none() {
            *guard = Some(self.spawn()?);
        }
        let inner = guard.as_mut().expect("just populated");

        // From the session, not the child: a number is never reused even
        // across a respawn, so a marker from an abandoned request can never be
        // mistaken for a current one.
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);

        // Build the batch. -echo4 frames stderr with the same number stdout
        // gets from -execute, so both streams can be attributed to this call.
        let mut batch = String::new();
        batch.push_str("-echo4\n");
        batch.push_str(&format!("{{err{seq}}}\n"));
        for arg in args {
            // A newline inside an argument would be read as an argument
            // separator and silently reinterpret the request — for a path,
            // that could mean editing a different file than intended.
            if arg.contains('\n') || arg.contains('\r') {
                return Err(format!("Argument contains a line break: {arg:?}"));
            }
            batch.push_str(arg);
            batch.push('\n');
        }
        batch.push_str(&format!("-execute{seq}\n"));

        inner
            .stdin
            .write_all(batch.as_bytes())
            .and_then(|_| inner.stdin.flush())
            .map_err(|e| format!("ExifTool stdin write failed: {e}"))?;

        let stdout = read_until_marker(&mut inner.stdout, &format!("{{ready{seq}}}"), seq)?;
        // Cloned after the read, so the mutable borrow of `inner.stdout` above
        // has ended. Still under the `inner` lock, so this is the channel
        // belonging to the child that just answered.
        let channel = Arc::clone(&inner.stderr);
        let stderr = take_stderr(&channel, seq)?;

        Ok(ExifResponse { stdout, stderr })
    }

    fn spawn(&self) -> Result<Inner, String> {
        let mut command = Command::new(&self.exe);
        command
            .arg("-stay_open")
            .arg("True")
            .arg("-@")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // `exiftool.exe` is a console application and the release build is a
        // GUI one (`windows_subsystem = "windows"`), so Windows would allocate
        // a console for the child — a blank black window that stays for the
        // life of the app, because the `-stay_open` process deliberately never
        // exits. The flag suppresses the console without touching the pipes.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start ExifTool at {}: {e}", self.exe.display()))?;

        let stdin = child.stdin.take().ok_or("ExifTool stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("ExifTool stdout unavailable")?);
        let child_stderr = child.stderr.take().ok_or("ExifTool stderr unavailable")?;

        // A channel of this child's own. See the field's comment: resetting a
        // shared one left the outgoing reader thread able to write into it.
        let channel: Arc<(Mutex<StderrChannel>, Condvar)> =
            Arc::new((Mutex::new(StderrChannel::default()), Condvar::new()));

        let stderr_state = Arc::clone(&channel);
        std::thread::Builder::new()
            .name("exiftool-stderr".into())
            .spawn(move || drain_stderr(child_stderr, stderr_state))
            .map_err(|e| format!("Cannot start ExifTool stderr reader: {e}"))?;

        Ok(Inner {
            child,
            stdin,
            stdout,
            stderr: channel,
        })
    }

}

/// Collects the stderr chunk for `seq` from one child's channel.
///
/// A free function taking the channel, rather than a method reaching for a
/// session-wide one: the channel belongs to the child that just answered on
/// stdout, so there is no way for this to wait on — or read from — a different
/// child's framing. See `Inner::stderr`.
fn take_stderr(
    channel: &Arc<(Mutex<StderrChannel>, Condvar)>,
    seq: u64,
) -> Result<String, String> {
    let (lock, condvar) = &**channel;
    {
        let mut channel = lock.lock().map_err(|_| poisoned())?;
        let deadline = std::time::Instant::now() + RESPONSE_TIMEOUT;
        loop {
            if let Some(text) = channel.ready.remove(&seq) {
                return Ok(text);
            }
            if channel.closed {
                // stdout already framed successfully, so the request itself
                // completed; the child then exited. Report no stderr rather
                // than failing a request whose output we have.
                return Ok(String::new());
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "ExifTool did not frame stderr for request {seq} within {}s",
                    RESPONSE_TIMEOUT.as_secs()
                ));
            }
            let (next, timeout) = condvar
                .wait_timeout(channel, remaining)
                .map_err(|_| poisoned())?;
            channel = next;
            if timeout.timed_out() && !channel.ready.contains_key(&seq) && !channel.closed {
                return Err(format!(
                    "ExifTool did not frame stderr for request {seq} within {}s",
                    RESPONSE_TIMEOUT.as_secs()
                ));
            }
        }
    }
}

impl ExifToolSession {
    /// Drops the current child so the next request spawns a fresh one.
    fn discard_child(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut inner) = guard.take() {
                let _ = inner.stdin.write_all(b"-stay_open\nFalse\n");
                let _ = inner.stdin.flush();
                let _ = inner.child.kill();
                let _ = inner.child.wait();
            }
        }
    }

    /// Asks the child to exit cleanly. Call on app shutdown.
    pub fn shutdown(&self) {
        self.discard_child();
    }
}

impl Drop for ExifToolSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Reads stdout lines until `marker`, returning everything before it.
fn read_until_marker(
    stdout: &mut BufReader<std::process::ChildStdout>,
    marker: &str,
    seq: u64,
) -> Result<String, String> {
    let mut collected = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout
            .read_line(&mut line)
            .map_err(|e| format!("ExifTool stdout read failed: {e}"))?;
        if read == 0 {
            return Err(format!(
                "ExifTool exited before answering request {seq} \
                 (partial output: {} bytes)",
                collected.len()
            ));
        }
        let trimmed = strip_eol(&line);
        if trimmed == marker {
            return Ok(collected);
        }
        // A marker for a *different* number means the stream is desynchronised
        // — output is no longer reliably attributable to a request. Failing
        // loudly beats returning another file's metadata.
        if is_ready_marker(trimmed) {
            return Err(format!(
                "ExifTool stream desynchronised: expected {marker}, got {trimmed}"
            ));
        }
        collected.push_str(&line);
    }
}

/// Strips the line terminator, whichever the platform's ExifTool uses.
///
/// The Unix distribution ends lines with LF; the standalone Windows build —
/// which carries its own Perl — ends them with **CRLF**. A marker compared
/// without stripping the CR never matches, so on Windows every single request
/// would run to its timeout and the app would appear to hang on launch.
/// Verified against `exiftool.exe` under wine.
fn strip_eol(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

/// True for `{ready}` / `{ready<N>}` exactly — not for a line that merely
/// contains one, since metadata values can legitimately hold such text.
fn is_ready_marker(line: &str) -> bool {
    line.strip_prefix("{ready")
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|digits| digits.chars().all(|c| c.is_ascii_digit()))
}

/// Same shape for the `{err<N>}` markers on stderr.
fn parse_err_marker(line: &str) -> Option<u64> {
    let digits = line.strip_prefix("{err")?.strip_suffix('}')?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Reader thread: frames stderr into per-request chunks until EOF.
fn drain_stderr(
    stderr: std::process::ChildStderr,
    state: Arc<(Mutex<StderrChannel>, Condvar)>,
) {
    let (lock, condvar) = &*state;
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = strip_eol(&line).to_string();
        let Ok(mut channel) = lock.lock() else { return };
        match parse_err_marker(&trimmed) {
            Some(seq) => {
                let text = std::mem::take(&mut channel.pending).join("\n");
                channel.ready.insert(seq, text);
                condvar.notify_all();
            }
            None => channel.pending.push(trimmed),
        }
    }
    if let Ok(mut channel) = lock.lock() {
        channel.closed = true;
        condvar.notify_all();
    }
}

fn poisoned() -> String {
    "ExifTool session lock was poisoned by a panic in another thread".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolves the vendored ExifTool from the repo, skipping the test when it
    /// has not been fetched (a fresh clone has no vendor tree).
    ///
    /// **A skip here is a silent pass** — a Rust test that returns has passed —
    /// so `REVERY_EXIF_REQUIRE_ENGINE` exists to take that away. CI sets it
    /// after vendoring, which is the one environment where "no engine" must be
    /// a failure rather than a shrug. See `tests/common` for the full
    /// reasoning; it is duplicated here because a unit test cannot reach the
    /// integration suites' shared module.
    fn session() -> Option<ExifToolSession> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
        match ExifToolSession::locate(root) {
            Ok(exe) => Some(ExifToolSession::new(exe)),
            Err(why) => {
                if std::env::var_os("REVERY_EXIF_REQUIRE_ENGINE").is_some() {
                    panic!(
                        "REVERY_EXIF_REQUIRE_ENGINE is set, so a missing engine is a \
                         failure: {why}"
                    );
                }
                eprintln!("SKIPPING (no vendored ExifTool): {why}");
                None
            }
        }
    }

    macro_rules! require_exiftool {
        () => {
            match session() {
                Some(s) => s,
                None => return,
            }
        };
    }

    #[test]
    fn windows_line_endings_are_stripped() {
        // The standalone Windows ExifTool ends every line with CRLF. Left in
        // place, the CR makes each marker comparison fail, every request runs
        // to its two-minute timeout, and the app looks hung on Windows while
        // working perfectly everywhere else.
        assert_eq!(strip_eol("{ready1}\r\n"), "{ready1}");
        assert_eq!(strip_eol("{ready1}\n"), "{ready1}");
        assert_eq!(strip_eol("{ready1}"), "{ready1}");
        assert!(is_ready_marker(strip_eol("{ready1}\r\n")));
        assert_eq!(parse_err_marker(strip_eol("{err7}\r\n")), Some(7));
        // Content before the terminator is untouched.
        assert_eq!(strip_eol("13.59\r\n"), "13.59");
        assert_eq!(
            strip_eol("Error: File not found - Z:/x.jpg\r\n"),
            "Error: File not found - Z:/x.jpg"
        );
    }

    #[test]
    fn marker_recognition_is_exact() {
        assert!(is_ready_marker("{ready1}"));
        assert!(is_ready_marker("{ready}"));
        assert!(is_ready_marker("{ready1234}"));
        // Metadata values can contain anything, including marker-like text.
        // Only a line that is *exactly* a marker may terminate a response.
        assert!(!is_ready_marker("  {ready1}"));
        assert!(!is_ready_marker("{ready1} trailing"));
        assert!(!is_ready_marker("prefix {ready1}"));
        assert!(!is_ready_marker("{readyX}"));
        assert!(!is_ready_marker("{err1}"));

        assert_eq!(parse_err_marker("{err7}"), Some(7));
        assert_eq!(parse_err_marker("{err}"), None);
        assert_eq!(parse_err_marker("Error: {err7}"), None);
    }

    #[test]
    fn rejects_arguments_containing_newlines() {
        let s = require_exiftool!();
        // A newline would be read as an argument separator, silently turning
        // one request into another — for a path, editing the wrong file.
        let err = s
            .execute(&["-ver".into(), "/tmp/a\n-delete_original!".into()])
            .unwrap_err();
        assert!(err.contains("line break"), "unexpected error: {err}");
    }

    #[test]
    fn returns_version_and_frames_cleanly() {
        let s = require_exiftool!();
        let r = s.execute(&["-ver".into()]).unwrap();
        assert!(!r.has_error(), "stderr: {}", r.stderr);
        assert!(
            r.stdout.trim().starts_with("13."),
            "unexpected version output: {:?}",
            r.stdout
        );
        // -echo4 fires even with nothing to report, so a clean request must
        // frame stderr as empty rather than block waiting for it.
        assert_eq!(r.stderr, "");
    }

    #[test]
    fn sequential_requests_stay_attributed() {
        let s = require_exiftool!();
        // Ten round trips on one process: if framing drifted by even one
        // marker, a later response would carry an earlier one's payload.
        for _ in 0..10 {
            let r = s.execute(&["-ver".into()]).unwrap();
            assert!(r.stdout.trim().starts_with("13."), "drifted: {:?}", r.stdout);
        }
    }

    #[test]
    fn error_on_one_request_does_not_poison_the_next() {
        let s = require_exiftool!();

        let bad = s
            .execute(&["-j".into(), "/nonexistent/definitely-not-here.jpg".into()])
            .unwrap();
        assert!(bad.has_error(), "expected an error, stderr: {:?}", bad.stderr);
        assert!(bad.error_text().contains("File not found"));
        // A failed request yields no stdout at all — verified against the real
        // binary. Empty stdout must therefore never be read as success.
        assert_eq!(bad.stdout.trim(), "");

        // The session must remain usable: the failure is per-request, and the
        // next call must not inherit the previous one's stderr.
        let good = s.execute(&["-ver".into()]).unwrap();
        assert!(!good.has_error(), "leaked stderr: {:?}", good.stderr);
        assert!(good.stdout.trim().starts_with("13."));
    }

    /// The invariant the module header states, checked rather than assumed.
    ///
    /// `next_seq` used to live on `Inner` and start at 1 there, so every
    /// respawn restarted the numbering — which `execute`'s own retry path
    /// triggers on any transient failure. Numbers were per-child while the
    /// comment promised per-session.
    #[test]
    fn sequence_numbers_are_not_reused_after_a_respawn() {
        let s = require_exiftool!();
        s.execute(&["-ver".into()]).unwrap();
        let before = s.next_seq.load(Ordering::Relaxed);
        assert!(before > 1, "the first request should have consumed a number");

        // What a crashed child, or `execute`'s retry, does.
        s.discard_child();
        s.execute(&["-ver".into()]).unwrap();

        assert!(
            s.next_seq.load(Ordering::Relaxed) > before,
            "numbering restarted across the respawn: {before} then {}",
            s.next_seq.load(Ordering::Relaxed)
        );
    }

    /// A dead child's reader thread must not be able to answer for its
    /// replacement.
    ///
    /// The channel was shared for the life of the session and merely reset on
    /// spawn, which left the outgoing thread free to set `closed` on the fresh
    /// one — and `take_stderr` reads `closed` as "no stderr", so an ExifTool
    /// error would read as a clean run. Each child now owns its channel.
    #[test]
    fn a_respawned_child_does_not_inherit_the_previous_ones_stderr() {
        let s = require_exiftool!();

        // Leave a real error on the old child's channel, then replace it.
        let bad = s
            .execute(&["-j".into(), "/nonexistent/definitely-not-here.jpg".into()])
            .unwrap();
        assert!(bad.has_error(), "expected an error to be framed");
        s.discard_child();

        // The new child must report its own state, and must still be able to
        // surface an error — not return empty stderr because a dead thread
        // marked the channel closed.
        let good = s.execute(&["-ver".into()]).unwrap();
        assert!(!good.has_error(), "inherited stderr: {:?}", good.stderr);
        assert_eq!(good.stderr, "", "inherited stderr: {:?}", good.stderr);

        let bad_again = s
            .execute(&["-j".into(), "/nonexistent/still-not-here.jpg".into()])
            .unwrap();
        assert!(
            bad_again.has_error(),
            "the respawned child stopped reporting errors: {:?}",
            bad_again.stderr
        );
    }

    #[test]
    fn survives_the_child_being_killed() {
        let s = require_exiftool!();
        s.execute(&["-ver".into()]).unwrap();

        // Simulate the child dying between requests — OOM killer, a user with
        // a task manager, an upgrade swapping the binary underneath us.
        s.discard_child();

        let r = s
            .execute(&["-ver".into()])
            .expect("session should respawn after the child dies");
        assert!(r.stdout.trim().starts_with("13."));
    }

    #[test]
    fn concurrent_callers_each_get_their_own_response() {
        let s = require_exiftool!();
        let s = Arc::new(s);
        // Requests are serialised internally, but the app calls from many
        // threads (thumbnail generation fans out). Each caller must receive
        // its own response, never another thread's.
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let s = Arc::clone(&s);
                std::thread::spawn(move || {
                    let arg = if i % 2 == 0 { "-ver" } else { "-listf" };
                    let r = s.execute(&[arg.into()]).unwrap();
                    (arg, r.stdout)
                })
            })
            .collect();
        for handle in handles {
            let (arg, stdout) = handle.join().unwrap();
            match arg {
                "-ver" => assert!(
                    stdout.trim().starts_with("13."),
                    "-ver got the wrong response: {stdout:?}"
                ),
                // -listf prints supported file extensions; it must never come
                // back looking like a version string.
                _ => assert!(
                    stdout.contains("JPEG") || stdout.contains("jpg") || stdout.contains("JPG"),
                    "-listf got the wrong response: {stdout:?}"
                ),
            }
        }
    }
}
