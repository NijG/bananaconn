// The port check's banner: the first line a service sends on its own when a
// connection opens (SSH's identification string, RFC 4253 4.2; an FTP,
// SMTP, POP3 or IMAP greeting), read and the connection closed. Nothing is
// sent: the line tells which server and version answers on the port.

use std::io::{ErrorKind, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// The whole read, name lookup to the first line.
const TIMEOUT: Duration = Duration::from_secs(5);
/// More than any greeting line (SSH's is at most 255 characters).
const MAX: usize = 512;

/// The first line with something in it: lines end at LF, CR or CRLF (some
/// servers send blank or control-only lines before their greeting; RFC 4253
/// 4.2 lets an SSH server send other lines first). The line and whether it
/// was ended (a line still being sent when time ran out is not).
pub fn first_line(bytes: &[u8]) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    let mut rest = text.as_ref();
    while !rest.is_empty() {
        let end = rest.find(['\r', '\n']);
        let raw = end.map_or(rest, |i| &rest[..i]);
        // A line of escapes or bells alone is passed over, not shown as marks.
        if !crate::servertext::blank(raw) {
            return (crate::servertext::shown(raw).trim().to_string(), end.is_some());
        }
        match end {
            Some(i) => rest = &rest[i + 1..],
            None => break,
        }
    }
    (String::new(), false)
}

fn read_banner(host: &str, port: u16) -> Result<String, String> {
    let deadline = Instant::now() + TIMEOUT;
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?.collect();
    let mut last = format!("{host} 주소를 찾을 수 없습니다");
    for (i, addr) in addrs.iter().enumerate() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        // Each address its share of what is left: a silent one (::1 taking
        // the connection, the service on 127.0.0.1) leaves time for the next.
        let mine = Instant::now() + left / (addrs.len() - i) as u32;
        let mut tcp = match TcpStream::connect_timeout(addr, mine.saturating_duration_since(Instant::now())) {
            Ok(t) => t,
            Err(e) => {
                last = format!("{host}:{port} 에 연결할 수 없습니다: {e}");
                continue;
            }
        };
        let mut got = Vec::new();
        let mut read_error = None;
        let mut buf = [0u8; 256];
        // The server closed the connection: what it sent is all of its line.
        let mut closed = false;
        loop {
            let left = mine.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let _ = tcp.set_read_timeout(Some(left));
            match tcp.read(&mut buf) {
                Ok(0) => {
                    closed = true;
                    break;
                }
                Ok(n) => {
                    got.extend_from_slice(&buf[..n]);
                    if first_line(&got).1 || got.len() >= MAX {
                        break;
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => break,
                Err(e) => {
                    read_error = Some(format!("{host}:{port} 에서 읽을 수 없습니다: {e}"));
                    break;
                }
            }
        }
        let (line, ended) = first_line(&got);
        if !line.is_empty() {
            // Not ended within the time or the size (and the server still
            // sending): what came is shown as cut.
            return Ok(if ended || closed { line } else { format!("{line} …") });
        }
        // This address said nothing in time (a service that waits for the
        // client to speak first, as HTTP does): the next one is tried.
        last = read_error.unwrap_or_else(|| format!("{host}:{port} 이(가) 먼저 보내는 내용이 없습니다 (클라이언트가 먼저 말하는 서비스일 수 있음)"));
    }
    Err(last)
}

#[tauri::command]
pub async fn net_banner(host: String, port: u16) -> Result<String, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if host.is_empty() || port == 0 {
        return Err("호스트와 포트를 입력하세요".into());
    }
    tauri::async_runtime::spawn_blocking(move || read_banner(&host, port)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{first_line, read_banner};
    use std::io::Write;

    #[test]
    fn the_first_line_is_kept_without_control_characters() {
        assert_eq!(first_line(b"SSH-2.0-OpenSSH_9.6\r\n"), ("SSH-2.0-OpenSSH_9.6".into(), true));
        assert_eq!(first_line(b"220 ftp ready\r\n230 more\r\n").0, "220 ftp ready");
        let m = crate::servertext::MARK;
        assert_eq!(first_line(b"\x1b[31mred\x07 text\n").0, format!("{m}[31mred{m} text"));
        assert_eq!(first_line(b""), (String::new(), false));
        // Blank and control-only lines before the greeting are passed over.
        assert_eq!(first_line(b"\r\nSSH-2.0-X\r\n").0, "SSH-2.0-X");
        assert_eq!(first_line(b"\x1b\x07\r\n220 real\r\n").0, "220 real");
        // A bare CR ends a line too.
        assert_eq!(first_line(b"220 a\r230 b\n").0, "220 a");
        // A line not yet ended is said so.
        assert_eq!(first_line(b"220 still comi"), ("220 still comi".into(), false));
        // Bidi overrides and zero-width characters are shown as marks.
        let tricky = String::from("SSH-2.0-\u{202E}evil\u{200B}x\n");
        assert_eq!(first_line(tricky.as_bytes()).0, format!("SSH-2.0-{m}evil{m}x"));
    }

    #[test]
    fn a_greeting_is_read_and_silence_is_said_so() {
        let talker = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = talker.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = talker.accept() {
                let _ = s.write_all(b"SSH-2.0-Test_1.0\r\n");
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        });
        assert_eq!(read_banner("127.0.0.1", port).unwrap(), "SSH-2.0-Test_1.0");

        // A greeting without a line ending, the connection then closed: whole, not cut.
        let closer = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closer.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = closer.accept() {
                let _ = s.write_all(b"220 bye");
            }
        });
        assert_eq!(read_banner("127.0.0.1", port).unwrap(), "220 bye");

        // A service that waits for the client (HTTP): nothing within the time.
        let quiet = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = quiet.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((_s, _)) = quiet.accept() {
                std::thread::sleep(std::time::Duration::from_secs(7));
            }
        });
        let started = std::time::Instant::now();
        let err = read_banner("127.0.0.1", port).unwrap_err();
        assert!(err.contains("먼저 보내는 내용이 없습니다"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(7));
    }
}
