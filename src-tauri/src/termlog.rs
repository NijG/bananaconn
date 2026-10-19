// Terminal session logs, SecureCRT style: the file name is a template with
// substitutions, the file can be appended to, overwritten or made unique,
// every line can carry a timestamp, a new file can start at midnight, and
// custom text is written when logging starts and when it ends.
//
// The frontend fills in the session tokens (%S name, %H host, %U user,
// %P port; '%' inside those values arrives escaped as "%%"). The time tokens
// are filled in here, at the moment a file is opened or a line is written:
// %Y year, %M month, %D day, %h hour, %m minute, %s second, %t millisecond.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, NaiveDate, Timelike};
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    /// File path template; relative paths go to the default logs folder.
    pub path: String,
    /// "append", "overwrite" or "unique" (add -2, -3, ... when the file exists).
    #[serde(default)]
    pub mode: String,
    /// Text put in front of every line (template, e.g. "[%h:%m:%s] ").
    #[serde(default)]
    pub line_prefix: String,
    /// Start a new file when the date changes (the path should contain %D).
    #[serde(default)]
    pub midnight: bool,
    #[serde(default)]
    pub on_connect: String,
    #[serde(default)]
    pub on_disconnect: String,
}

/// Fill in the time tokens; unknown tokens are kept as written.
pub fn expand_time(template: &str, now: &DateTime<Local>) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&format!("{:04}", now.year())),
            Some('M') => out.push_str(&format!("{:02}", now.month())),
            Some('D') => out.push_str(&format!("{:02}", now.day())),
            Some('h') => out.push_str(&format!("{:02}", now.hour())),
            Some('m') => out.push_str(&format!("{:02}", now.minute())),
            Some('s') => out.push_str(&format!("{:02}", now.second())),
            Some('t') => out.push_str(&format!("{:03}", now.timestamp_subsec_millis() % 1000)),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Windows refuses these in a file name; replace them in the name part only
/// (the folder part is the user's chosen path, drive letter included).
fn safe_file_name(path: &Path) -> PathBuf {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { return path.to_path_buf() };
    let clean: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let clean = clean.trim_end_matches([' ', '.']).to_string();
    path.with_file_name(if clean.is_empty() { "log.txt".to_string() } else { clean })
}

/// Buffered output reaches the file at least this often.
const FLUSH_EVERY: Duration = Duration::from_millis(250);

pub struct LogSink {
    /// Buffered: a flood is not one write per read (slow on network shares).
    file: BufWriter<File>,
    flushed: Instant,
    path: PathBuf,
    opts: LogOptions,
    /// Where relative paths go (the default logs folder).
    dir: PathBuf,
    day: NaiveDate,
    line_start: bool,
}

impl LogSink {
    /// Open the log described by `opts`; `default_dir` takes relative paths.
    pub fn open(opts: LogOptions, default_dir: &Path) -> Result<Self, String> {
        let now = Local::now();
        let (file, path) = open_file(&opts, default_dir, &now)?;
        let mut sink = Self { file: BufWriter::with_capacity(64 * 1024, file), flushed: Instant::now(), path, opts, dir: default_dir.to_path_buf(), day: now.date_naive(), line_start: true };
        if !sink.opts.on_connect.is_empty() {
            let text = expand_time(&sink.opts.on_connect, &now);
            let _ = sink.file.write_all(format!("{text}\r\n").as_bytes());
            let _ = sink.file.flush();
        }
        Ok(sink)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write terminal output (ANSI already removed).
    pub fn write(&mut self, data: &[u8], idle: bool) {
        let now = Local::now();
        if self.opts.midnight && now.date_naive() != self.day {
            // New day: continue in the file the template names now.
            if let Ok((file, path)) = open_file(&self.opts, &self.dir, &now) {
                let _ = self.file.flush();
                self.file = BufWriter::with_capacity(64 * 1024, file);
                self.path = path;
            }
            self.day = now.date_naive();
        }
        if self.opts.line_prefix.is_empty() {
            let _ = self.file.write_all(data);
            self.settle(idle);
            return;
        }
        let prefix = expand_time(&self.opts.line_prefix, &now);
        let mut out = Vec::with_capacity(data.len() + prefix.len() * 4);
        for &b in data {
            if self.line_start && b != b'\r' && b != b'\n' {
                out.extend_from_slice(prefix.as_bytes());
                self.line_start = false;
            }
            out.push(b);
            if b == b'\n' {
                self.line_start = true;
            }
        }
        let _ = self.file.write_all(&out);
        self.settle(idle);
    }

    /// Written out whenever the output pauses (so the file can be followed
    /// live and nothing waits in the buffer), during a flood every quarter second.
    fn settle(&mut self, idle: bool) {
        if idle || self.flushed.elapsed() >= FLUSH_EVERY {
            let _ = self.file.flush();
            self.flushed = Instant::now();
        }
    }
}

impl Drop for LogSink {
    fn drop(&mut self) {
        if !self.opts.on_disconnect.is_empty() {
            let text = expand_time(&self.opts.on_disconnect, &Local::now());
            let lead = if self.line_start { "" } else { "\r\n" };
            let _ = self.file.write_all(format!("{lead}{text}\r\n").as_bytes());
        }
        let _ = self.file.flush();
    }
}

fn open_file(opts: &LogOptions, default_dir: &Path, now: &DateTime<Local>) -> Result<(File, PathBuf), String> {
    let expanded = expand_time(opts.path.trim(), now);
    if expanded.is_empty() {
        return Err("로그 파일 이름이 비어 있습니다".into());
    }
    let mut path = PathBuf::from(&expanded);
    if path.is_relative() {
        path = default_dir.join(path);
    }
    let path = safe_file_name(&path);
    // A log is text: a name Windows would run (.bat in the Startup folder,
    // say, from an imported session file) is refused.
    if path.file_name().is_some_and(|n| crate::remote::runs_when_opened(&n.to_string_lossy())) {
        return Err(format!("실행되는 파일 형식으로는 로그를 쓸 수 없습니다: {}", path.display()));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("로그 폴더를 만들 수 없습니다 ({}): {e}", dir.display()))?;
    }
    let open_err = |e: std::io::Error| format!("로그 파일을 열 수 없습니다 ({}): {e}", path.display());
    match opts.mode.as_str() {
        "overwrite" => Ok((File::create(&path).map_err(open_err)?, path.clone())),
        "unique" => {
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            for n in 1..1000 {
                let candidate = if n == 1 { path.clone() } else { path.with_file_name(format!("{stem}-{n}{ext}")) };
                match OpenOptions::new().write(true).create_new(true).open(&candidate) {
                    Ok(f) => return Ok((f, candidate)),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(format!("로그 파일을 열 수 없습니다 ({}): {e}", candidate.display())),
                }
            }
            Err("로그 파일 이름을 정할 수 없습니다".into())
        }
        _ => Ok((OpenOptions::new().create(true).append(true).open(&path).map_err(open_err)?, path.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn expands_time_tokens() {
        let now = Local.with_ymd_and_hms(2026, 3, 7, 9, 5, 2).unwrap();
        assert_eq!(expand_time("%Y%M%D_%h%m%s", &now), "20260307_090502");
        assert_eq!(expand_time("100%% %S %x %", &now), "100% %S %x %");
    }

    #[test]
    fn modes_prefix_and_custom_text() {
        let dir = std::env::temp_dir().join(format!("bx-termlog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let opts = |mode: &str| LogOptions {
            path: "sub\\router: <A>_%Y.log".into(),
            mode: mode.into(),
            line_prefix: "[%Y] ".into(),
            midnight: false,
            on_connect: "== start %Y ==".into(),
            on_disconnect: "== end ==".into(),
        };
        let year = Local::now().year();
        {
            let mut log = LogSink::open(opts("append"), &dir).unwrap();
            assert!(log.path().starts_with(dir.join("sub")), "relative paths go to the default folder");
            assert_eq!(log.path().file_name().unwrap().to_string_lossy(), format!("router_ _A__{year}.log"));
            log.write(b"line1\r\nline2\r\npartial", false);
            log.write(b" more\r\n", false);
        }
        let first = fs::read_to_string(dir.join("sub").join(format!("router_ _A__{year}.log"))).unwrap();
        assert_eq!(first, format!("== start {year} ==\r\n[{year}] line1\r\n[{year}] line2\r\n[{year}] partial more\r\n== end ==\r\n"));

        // append keeps, overwrite replaces, unique makes a second file.
        drop(LogSink::open(opts("append"), &dir).unwrap());
        let appended = fs::read_to_string(dir.join("sub").join(format!("router_ _A__{year}.log"))).unwrap();
        assert!(appended.starts_with(&first) && appended.len() > first.len());
        let unique = LogSink::open(opts("unique"), &dir).unwrap();
        assert!(unique.path().to_string_lossy().ends_with(&format!("router_ _A__{year}-2.log")));
        drop(unique);
        drop(LogSink::open(opts("overwrite"), &dir).unwrap());
        let replaced = fs::read_to_string(dir.join("sub").join(format!("router_ _A__{year}.log"))).unwrap();
        assert_eq!(replaced, format!("== start {year} ==\r\n== end ==\r\n"));
        let _ = fs::remove_dir_all(&dir);
    }
}
