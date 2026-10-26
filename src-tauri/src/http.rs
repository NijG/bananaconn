// HTTP(S) requests with WinHTTP: the system's certificate store and proxy
// settings (company networks inspect TLS and require their proxy), redirects
// followed. Used by the updater and by the AI providers (ai.rs). Loopback
// addresses (a local LLM) never go through a proxy.

use windows_sys::Win32::Networking::WinHttp::*;

pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a [(&'a str, String)],
    pub body: Option<&'a [u8]>,
    /// Longest wait for the next piece of the response (a local model may
    /// think for a while before its first token).
    pub receive_timeout_ms: u32,
}

struct Url<'a> {
    secure: bool,
    host: &'a str,
    port: u16,
    path: String,
}

fn parse(url: &str) -> Result<Url<'_>, String> {
    // `get` instead of indexing: the 7th/8th byte may fall inside a
    // multi-byte character ("http://서버" is fine, "가나다" must not panic).
    let scheme = |s: &str| url.get(..s.len()).filter(|head| head.eq_ignore_ascii_case(s)).map(|_| &url[s.len()..]);
    let (secure, rest) = match (scheme("https://"), scheme("http://")) {
        (Some(rest), _) if !rest.is_empty() => (true, rest),
        (_, Some(rest)) if !rest.is_empty() => (false, rest),
        _ => return Err(format!("http(s) 주소가 아닙니다: {url}")),
    };
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) if rest[i..].starts_with('/') => (&rest[..i], rest[i..].to_string()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_string()),
    };
    if authority.contains('@') {
        return Err("주소에 사용자 정보를 넣지 마세요 (API 키는 자격 증명으로 지정)".into());
    }
    let default = if secure { INTERNET_DEFAULT_HTTPS_PORT } else { INTERNET_DEFAULT_HTTP_PORT };
    // [::1]:8080, host:port, host
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']').ok_or("IPv6 주소가 올바르지 않습니다")?;
        (h, after.strip_prefix(':').map(|p| p.parse::<u16>().map_err(|_| "포트가 올바르지 않습니다")).transpose()?.unwrap_or(default))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "포트가 올바르지 않습니다")?),
            None => (authority, default),
        }
    };
    if host.is_empty() {
        return Err(format!("주소에 호스트가 없습니다: {url}"));
    }
    Ok(Url { secure, host, port, path })
}

fn loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// What a WinHTTP error code means for the user.
fn reason(code: i32) -> String {
    match code as u32 {
        ERROR_WINHTTP_NAME_NOT_RESOLVED => "이름을 찾을 수 없습니다".into(),
        ERROR_WINHTTP_CANNOT_CONNECT => "연결할 수 없습니다".into(),
        ERROR_WINHTTP_TIMEOUT => "응답 시간이 초과되었습니다".into(),
        ERROR_WINHTTP_SECURE_FAILURE => "보안 연결(TLS)을 만들 수 없습니다".into(),
        ERROR_WINHTTP_CONNECTION_ERROR => "연결이 끊어졌습니다".into(),
        _ => std::io::Error::from_raw_os_error(code).to_string(),
    }
}

/// Send a request; the response body is handed to `on_data` piece by piece
/// as it arrives, with the HTTP status (`false` stops reading). Returns the status.
pub fn send(req: &Request, on_data: &mut dyn FnMut(u16, &[u8]) -> bool) -> Result<u16, String> {
    let url = parse(req.url)?;
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let fail = |what: &str| format!("{} ({what}): {}", url.host, reason(std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: a handle WinHTTP returned, closed once.
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
    let open = |h: *mut core::ffi::c_void, what: &str| if h.is_null() { Err(fail(what)) } else { Ok(Handle(h)) };
    let headers: String = req.headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
    let (agent, host_w, verb, path_w, headers_w) = (wide("BananaConn"), wide(url.host), wide(req.method), wide(&url.path), wide(&headers));
    let access = if loopback(url.host) { WINHTTP_ACCESS_TYPE_NO_PROXY } else { WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY };
    let body = req.body.unwrap_or(&[]);
    // SAFETY: NUL-terminated buffers that outlive each call; the handles are
    // closed by Handle, in reverse order of creation.
    unsafe {
        let session = open(WinHttpOpen(agent.as_ptr(), access, std::ptr::null(), std::ptr::null(), 0), "open")?;
        WinHttpSetTimeouts(session.0, 15_000, 15_000, 60_000, req.receive_timeout_ms as i32);
        let conn = open(WinHttpConnect(session.0, host_w.as_ptr(), url.port, 0), "connect")?;
        let flags = if url.secure { WINHTTP_FLAG_SECURE } else { 0 };
        let r = open(WinHttpOpenRequest(conn.0, verb.as_ptr(), path_w.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), flags), "request")?;
        let sent = WinHttpSendRequest(
            r.0,
            if headers.is_empty() { std::ptr::null() } else { headers_w.as_ptr() },
            if headers.is_empty() { 0 } else { u32::MAX },
            if body.is_empty() { std::ptr::null() } else { body.as_ptr().cast() },
            body.len() as u32,
            body.len() as u32,
            0,
        );
        if sent == 0 || WinHttpReceiveResponse(r.0, std::ptr::null_mut()) == 0 {
            return Err(fail("응답 없음"));
        }
        let mut status = 0u32;
        let mut len = 4u32;
        WinHttpQueryHeaders(r.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, std::ptr::null(), (&mut status as *mut u32).cast(), &mut len, std::ptr::null_mut());
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let mut read = 0u32;
            if WinHttpReadData(r.0, buf.as_mut_ptr().cast(), buf.len() as u32, &mut read) == 0 {
                return Err(fail("읽기"));
            }
            if read == 0 || !on_data(status as u16, &buf[..read as usize]) {
                break;
            }
        }
        Ok(status as u16)
    }
}

/// The whole body of a request (at most `limit` bytes) and its status.
pub fn fetch(req: &Request, limit: usize) -> Result<(u16, Vec<u8>), String> {
    let mut body = Vec::new();
    let mut over = false;
    let status = send(req, &mut |_, d| {
        body.extend_from_slice(d);
        over = body.len() > limit;
        !over
    })?;
    if over {
        return Err(format!("{} 의 응답이 너무 큽니다", req.url));
    }
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_addresses() {
        let u = parse("https://api.example.com/v1/messages?x=1").unwrap();
        assert_eq!((u.secure, u.host, u.port, u.path.as_str()), (true, "api.example.com", 443, "/v1/messages?x=1"));
        let u = parse("http://127.0.0.1:11434").unwrap();
        assert_eq!((u.secure, u.host, u.port, u.path.as_str()), (false, "127.0.0.1", 11434, "/"));
        let u = parse("http://[::1]:1234/v1/models").unwrap();
        assert_eq!((u.host, u.port, u.path.as_str()), ("::1", 1234, "/v1/models"));
        assert!(parse("ftp://x").is_err());
        assert!(parse("https://user:pw@host/").is_err());
        // Multi-byte text where the scheme should be is an error, not a panic.
        assert!(parse("가나다라마").is_err() && parse("http가://x").is_err() && parse("https://").is_err());
        assert_eq!(parse("HTTP://서버:8080/경로").map(|u| (u.host, u.port)).ok(), Some(("서버", 8080)));
        assert!(loopback("localhost") && loopback("127.0.0.1") && loopback("::1") && !loopback("10.0.0.1"));
    }

    /// A POST with headers and a body to a local server, the reply streamed back.
    #[test]
    fn posts_and_streams_the_reply() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            while !String::from_utf8_lossy(&got).contains("\r\n\r\n{\"q\":1}") {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for part in ["data: one\n\n", "data: two\n\n"] {
                s.write_all(format!("{:x}\r\n{part}\r\n", part.len()).as_bytes()).unwrap();
                s.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            s.write_all(b"0\r\n\r\n").unwrap();
            String::from_utf8_lossy(&got).into_owned()
        });
        let url = format!("http://127.0.0.1:{port}/v1/chat");
        let mut parts = Vec::new();
        let status = send(
            &Request { method: "POST", url: &url, headers: &[("Content-Type", "application/json".into()), ("x-api-key", "k-123".into())], body: Some(b"{\"q\":1}"), receive_timeout_ms: 5000 },
            &mut |_, d| {
                parts.push(String::from_utf8_lossy(d).into_owned());
                true
            },
        )
        .unwrap();
        let request = server.join().unwrap();
        assert_eq!(status, 200);
        assert_eq!(parts.concat(), "data: one\n\ndata: two\n\n");
        assert!(request.starts_with("POST /v1/chat HTTP/1.1\r\n"), "{request}");
        assert!(request.contains("x-api-key: k-123\r\n") && request.contains("Content-Type: application/json\r\n"), "{request}");
    }

    #[test]
    fn a_closed_port_is_reported_plainly() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = fetch(&Request { method: "GET", url: &format!("http://127.0.0.1:{port}/"), headers: &[], body: None, receive_timeout_ms: 2000 }, 1024).unwrap_err();
        assert!(err.contains("연결할 수 없습니다"), "{err}");
    }
}
