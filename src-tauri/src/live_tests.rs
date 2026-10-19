// Network tests against real servers. Ignored by default; run with
//   cargo test --lib -- --ignored --nocapture
// test.rebex.net is a public read-only SFTP/FTP test server (demo / password).

use std::io::Read;
use std::net::TcpStream;
use std::time::Duration;

use crate::remote::ConnectRequest;

fn rebex(protocol: &str, port: u16) -> ConnectRequest {
    ConnectRequest {
        id: "t".into(),
        protocol: protocol.into(),
        host: "test.rebex.net".into(),
        port: Some(port),
        username: "demo".into(),
        credential_id: None,
        password: Some("password".into()),
        trusted_fingerprint: None,
        active_mode: false,
        ftps_mode: None,
        allow_invalid_cert: false,
    }
}

#[tokio::test]
#[ignore]
async fn sftp_unknown_host_key_is_reported_then_trusted() {
    let req = rebex("sftp", 22);
    let fp = match crate::remote::test_connect_sftp(&req).await {
        Err(e) if e.starts_with("HOSTKEY_UNKNOWN::SHA256:") => e["HOSTKEY_UNKNOWN::".len()..].to_string(),
        other => panic!("unexpected: {:?}", other.map(|v| v.len())),
    };
    println!("unknown host key surfaced: {fp}");

    // Approving a different fingerprint must not trust the real key (MITM case).
    let mut wrong = rebex("sftp", 22);
    wrong.trusted_fingerprint = Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into());
    let refused = crate::remote::test_connect_sftp(&wrong).await;
    assert!(matches!(&refused, Err(e) if e.starts_with("HOSTKEY_UNKNOWN::")), "{:?}", refused.map(|v| v.len()));

    let mut trusted = rebex("sftp", 22);
    trusted.trusted_fingerprint = Some(fp);
    let entries = crate::remote::test_connect_sftp(&trusted).await.expect("sftp list");
    println!("sftp entries: {:?}", entries.iter().map(|e| &e.name).collect::<Vec<_>>());
    assert!(entries.iter().any(|e| e.name == "pub"));
}

#[test]
#[ignore]
fn ftp_lists_and_downloads() {
    for (port, security) in [(21, "plain"), (21, "explicit"), (990, "implicit")] {
        let (entries, readme) =
            crate::remote::test_connect_ftp("test.rebex.net", port, security).unwrap_or_else(|e| panic!("{security}: {e}"));
        println!("ftp[{security}] entries: {:?}", entries.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert!(entries.iter().any(|e| e.name == "pub" && e.is_dir), "{security}");
        assert!(readme.contains("Welcome"), "{security} readme: {readme}");
    }
}

#[test]
#[ignore]
fn telnet_negotiates_and_receives_text() {
    let mut s = TcpStream::connect("telehack.com:23").expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut parser = crate::telnet::Parser::new();
    let mut text = Vec::new();
    let mut buf = [0u8; 4096];
    let mut replies = 0;
    for _ in 0..20 {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let feed = parser.feed(&buf[..n]);
                if !feed.replies.is_empty() {
                    replies += 1;
                    use std::io::Write;
                    s.write_all(&feed.replies).unwrap();
                }
                text.extend_from_slice(&feed.data);
                if text.len() > 200 {
                    break;
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&text);
    println!("negotiation replies: {replies}\n{text}");
    assert!(!text.contains('\u{FFFD}') || text.len() > 50);
    assert!(text.len() > 50);
}

/// Time to list a 5000-file folder through the built-in server (prints the
/// figure; asserts only a generous bound). `cargo test --release -- --ignored
/// builtin_ftp_server_lists_big_folders --nocapture` for a real number.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing"]
async fn builtin_ftp_server_lists_big_folders() {
    use crate::ftpserver::{ServerConfig, test_start};
    use suppaftp::FtpStream;
    let root = std::env::temp_dir().join(format!("bx-ftpd-big-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("big")).unwrap();
    for i in 0..5000 {
        std::fs::write(root.join("big").join(format!("보고서_{i:04}.txt")), b"x").unwrap();
    }
    let cfg = ServerConfig { root: root.to_string_lossy().into_owned(), port: 21925, lan: false, username: "t".into(), password: "pa55word".into(), anonymous: false, read_only: true };
    let (stop, _) = test_start(cfg).await;
    let took = tokio::task::spawn_blocking(|| {
        let mut ftp = FtpStream::connect("127.0.0.1:21925").unwrap();
        ftp.login("t", "pa55word").unwrap();
        let t0 = std::time::Instant::now();
        let lines = ftp.list(Some("/big")).unwrap();
        let took = t0.elapsed();
        assert_eq!(lines.len(), 5000);
        took
    })
    .await
    .unwrap();
    println!("LIST of 5000 entries: {took:?}");
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(&root);
    assert!(took < std::time::Duration::from_secs(10));
}

#[tokio::test(flavor = "multi_thread")]
async fn builtin_ftp_server_auth_confinement_and_read_only() {
    use crate::ftpserver::{ServerConfig, test_start};
    use std::io::Cursor;
    use suppaftp::FtpStream;

    let root = std::env::temp_dir().join(format!("bx-ftpd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("hello.txt"), "hello from bananaconn").unwrap();
    // A file outside the shared folder that must stay unreachable.
    let outside = root.parent().unwrap().join(format!("bx-ftpd-secret-{}.txt", std::process::id()));
    std::fs::write(&outside, "secret").unwrap();

    let cfg = |port: u16, read_only: bool, anonymous: bool| ServerConfig {
        root: root.to_string_lossy().into_owned(),
        port,
        lan: false,
        username: "tester".into(),
        password: "pa55word".into(),
        anonymous,
        read_only,
    };

    // --- read/write server -------------------------------------------------------
    let (stop, _) = test_start(cfg(21921, false, false)).await;
    let root_s = root.clone();
    let outside_name = outside.file_name().unwrap().to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || {
        let mut bad = FtpStream::connect("127.0.0.1:21921").unwrap();
        assert!(bad.login("tester", "wrong").is_err(), "wrong password must fail");
        assert!(FtpStream::connect("127.0.0.1:21921").unwrap().login("anonymous", "x@y").is_err(), "anonymous disabled");

        let mut ftp = FtpStream::connect("127.0.0.1:21921").unwrap();
        ftp.login("tester", "pa55word").unwrap();
        let names = ftp.nlst(None).unwrap();
        assert!(names.iter().any(|n| n.ends_with("hello.txt")), "{names:?}");
        let got = ftp.retr_as_buffer("hello.txt").unwrap().into_inner();
        assert_eq!(got, b"hello from bananaconn");
        ftp.put_file("upload.txt", &mut Cursor::new(b"uploaded".to_vec())).unwrap();
        assert_eq!(std::fs::read(root_s.join("upload.txt")).unwrap(), b"uploaded");
        ftp.mkdir("newdir").unwrap();
        assert!(root_s.join("newdir").is_dir());
        // Escapes above the shared folder are refused.
        for p in [format!("../{outside_name}"), format!("/../{outside_name}"), format!("..\\{outside_name}")] {
            assert!(ftp.retr_as_buffer(&p).is_err(), "escaped with {p}");
        }
        let _ = ftp.cwd("../..");
        let after = ftp.nlst(None).unwrap();
        assert!(after.iter().all(|n| !n.contains("bx-ftpd-secret")), "listing escaped: {after:?}");
        let _ = ftp.quit();
    })
    .await
    .unwrap();
    let _ = stop.send(());

    // --- read-only + anonymous server ---------------------------------------------
    let (stop, _) = test_start(cfg(21922, true, true)).await;
    let root_s = root.clone();
    tokio::task::spawn_blocking(move || {
        let mut ftp = FtpStream::connect("127.0.0.1:21922").unwrap();
        ftp.login("anonymous", "guest@").unwrap();
        assert_eq!(ftp.retr_as_buffer("hello.txt").unwrap().into_inner(), b"hello from bananaconn");
        assert!(ftp.put_file("nope.txt", &mut Cursor::new(b"x".to_vec())).is_err(), "upload must be refused");
        assert!(ftp.rm("hello.txt").is_err(), "delete must be refused");
        assert!(ftp.mkdir("nope").is_err(), "mkdir must be refused");
        assert!(ftp.rename("hello.txt", "x.txt").is_err(), "rename must be refused");
        assert!(!root_s.join("nope.txt").exists() && root_s.join("hello.txt").exists());
        let _ = ftp.quit();
    })
    .await
    .unwrap();
    let _ = stop.send(());

    // --- stopping ends a transfer already in progress ---------------------------------
    std::fs::write(root.join("big.bin"), vec![7u8; 64 * 1024 * 1024]).unwrap();
    let (stop, stopped) = test_start(cfg(21923, true, false)).await;
    let reader = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut ftp = FtpStream::connect("127.0.0.1:21923").unwrap();
        ftp.login("tester", "pa55word").unwrap();
        let mut s = ftp.retr_as_stream("big.bin").unwrap();
        let mut buf = [0u8; 8192];
        let mut got = 0usize;
        loop {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
            std::thread::sleep(Duration::from_millis(2)); // a slow client
        }
        got
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    stopped.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = stop.send(());
    let got = tokio::time::timeout(Duration::from_secs(20), reader).await.expect("transfer kept running after stop").unwrap();
    assert!(got < 64 * 1024 * 1024, "the whole file was sent after stop ({got} bytes)");

    // --- after stop every data port is free again (restart on the same ports) -------------
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let base = 50200 + (21923 % 10) * 20;
    for p in base..=base + 19 {
        assert!(std::net::TcpListener::bind(("127.0.0.1", p)).is_ok(), "data port {p} still held after stop");
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_file(&outside);
}

#[tokio::test]
async fn vnc_bridge_relays_binary_frames_and_checks_token() {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message;

    // Fake VNC server: echoes bytes back.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = echo.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        loop {
            let n = s.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            s.write_all(&buf[..n]).await.unwrap();
        }
    });

    let url = crate::vnc::test_start(echo_port).await;

    // Only the app's page (Origin) with the right token gets through.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let from_page = |url: &str| {
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert("Origin", "http://tauri.localhost".parse().unwrap());
        req
    };
    let bad = url.rsplit_once('/').unwrap().0.to_string() + "/wrong";
    assert!(tokio_tungstenite::connect_async(from_page(&bad)).await.is_err());
    assert!(tokio_tungstenite::connect_async(url.clone()).await.is_err(), "no Origin: another local program");

    let (mut ws, _) = tokio_tungstenite::connect_async(from_page(&url)).await.expect("ws connect");
    ws.send(Message::Binary(b"RFB 003.008\n".to_vec())).await.unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert_eq!(reply, Message::Binary(b"RFB 003.008\n".to_vec()));
}

#[tokio::test(flavor = "multi_thread")]
async fn ftp_client_active_mode_transfers_large_files() {
    use crate::ftpserver::{test_start, ServerConfig};
    let root = std::env::temp_dir().join(format!("bx-active-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let data: Vec<u8> = (0..400_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(root.join("big.bin"), &data).unwrap();
    let (stop, _) = test_start(ServerConfig {
        root: root.to_string_lossy().into_owned(),
        port: 21924,
        lan: false,
        username: "a".into(),
        password: "active-pw".into(),
        anonymous: false,
        read_only: false,
    })
    .await;
    let r = root.clone();
    tokio::task::spawn_blocking(move || {
        // Larger than the Windows socket buffers: a non-blocking data socket
        // failed here with WouldBlock.
        let (down, up) = crate::remote::test_active_ftp(21924, "a", "active-pw", "big.bin", &data).unwrap();
        assert_eq!(down, data, "download in active mode");
        assert_eq!(std::fs::read(r.join("up.bin")).unwrap(), up);
    })
    .await
    .unwrap();
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(&root);
}

// ---- SSH gateway tunnel through an in-process SSH server --------------------------------

#[derive(Clone)]
struct GatewayServer;

/// What the test SSH server prints for the monitor script: two Linux samples,
/// then the channel closes.
const FAKE_PROC: &str = "cpu  100 0 100 800 0 0 0 0 0 0\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n.\n\
cpu  200 0 150 850 0 0 0 0 0 0\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n/dev/sda1 2000 500 1500 25% /\n.\n";
const FAKE_TOP: &str = "@@CPU\n  PID USER %CPU COMMAND\n  42 root 93.0 stress\n@@MEM\n  PID USER %MEM RSS COMMAND\n  42 root 1.0 900 stress\n\
@@DISK\nFilesystem Size Used Avail Use% Mounted on\n/dev/sda1 2.0M 500K 1.5M 25% /\n@@END\n";

impl russh::server::Handler for GatewayServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(if user == "gw" && password == "gw-pass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        // Only the monitor's read-only /proc loop is "supported" here.
        let cmd = String::from_utf8_lossy(data);
        let out = if cmd.contains("/proc/stat") {
            FAKE_PROC
        } else if cmd.contains("@@C''PU") {
            FAKE_TOP
        } else {
            ""
        };
        session.channel_success(channel)?;
        session.data(channel, out.as_bytes().to_vec())?;
        session.close(channel)?;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        // Only the test's own echo server may be reached.
        let Ok(mut tcp) = tokio::net::TcpStream::connect((host.to_string(), port as u16)).await else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut ch = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
        });
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ssh_gateway_tunnel_forwards_after_host_key_approval() {
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Target: an echo server only reachable "behind" the gateway.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    // Gateway SSH server.
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut rand::rngs::ThreadRng::default(), russh::keys::Algorithm::Ed25519).unwrap()],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });
    let gw = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gw_port = gw.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((s, _)) = gw.accept().await {
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, s, GatewayServer).await {
                    let _ = running.await;
                }
            });
        }
    });

    let kh = std::env::temp_dir().join(format!("bx-gw-known_hosts-{}", std::process::id()));
    let _ = std::fs::remove_file(&kh);
    let login = |fp: Option<String>, pw: &str| crate::remote::SshLogin {
        host: "127.0.0.1".into(),
        port: gw_port,
        username: "gw".into(),
        password: Some(pw.into()),
        cred: None,
        trusted_fingerprint: fp,
        known_hosts: kh.clone(),
    };

    // Unknown host key is reported, never silently trusted.
    let fp = match crate::tunnel::test_forward(login(None, "gw-pass"), "127.0.0.1", echo_port).await {
        Err(e) if e.starts_with("HOSTKEY_UNKNOWN::") => e["HOSTKEY_UNKNOWN::".len()..].to_string(),
        Err(e) => panic!("unexpected error: {e}"),
        Ok(_) => panic!("connected without approving the host key"),
    };
    // Wrong password is refused.
    assert!(crate::tunnel::test_forward(login(Some(fp.clone()), "nope"), "127.0.0.1", echo_port).await.is_err());

    let (local, stop) = crate::tunnel::test_forward(login(Some(fp), "gw-pass"), "127.0.0.1", echo_port).await.expect("tunnel");
    for round in 0..2 {
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        let msg = format!("hello through the gateway #{round}");
        c.write_all(msg.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; msg.len()];
        tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut buf)).await.expect("echo timed out").unwrap();
        assert_eq!(buf, msg.as_bytes());
    }
    stop();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_err(), "listener still open after stop");

    // The resource monitor over the same kind of SSH login.
    // The host key was learned above, so no fingerprint approval is needed now.
    let handle = crate::remote::ssh_login(login(None, "gw-pass")).await.expect("monitor login (key already trusted)");
    let events = crate::monitor::test_pump(&handle, 3).await;
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[0]["warmup"], true);
    let cpu = events[1]["stats"]["cpu"].as_f64().unwrap();
    assert!((cpu - 75.0).abs() < 0.01, "{events:?}");
    assert_eq!(events[1]["stats"]["memUsed"], 500 * 1024);
    assert_eq!(events[1]["stats"]["diskUsed"], 500 * 1024);
    assert_eq!(events[1]["stats"]["diskTotal"], 2000 * 1024);
    assert_eq!(events[2]["closed"], true);
    // Top processes over another channel of the same connection.
    let top = crate::monitor::ssh_top(&handle).await.expect("top");
    assert_eq!(top.len(), 3, "{top:?}");
    assert!(top[0].lines[1].contains("stress") && top[2].lines[1].contains("/dev/sda1"), "{top:?}");
    let _ = std::fs::remove_file(&kh);
}

// ---- resource monitor against a real shell over SSH -------------------------------------------

/// An SSH server that runs exec commands in a real POSIX shell (Git for
/// Windows' sh), with /proc replaced by a folder of sample files, and feeds
/// the channel's data to the command's stdin — as sshd does.
#[derive(Clone)]
struct ShellServer {
    fake_proc: String,
    stdin: std::sync::Arc<std::sync::Mutex<Option<std::process::ChildStdin>>>,
}

impl russh::server::Handler for ShellServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, channel: russh::ChannelId, data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).replace("/proc/", &self.fake_proc);
        session.channel_success(channel)?;
        let mut child = std::process::Command::new(r"C:\Program Files\Git\usr\bin\sh.exe")
            .arg("-c")
            .arg(cmd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("sh");
        *self.stdin.lock().unwrap() = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            let _ = child.wait();
        });
        let handle = session.handle();
        tokio::spawn(async move {
            while let Some(chunk) = rx.recv().await {
                if handle.data(channel, chunk).await.is_err() {
                    break;
                }
            }
            let _ = handle.close(channel).await;
        });
        Ok(())
    }

    async fn data(&mut self, _channel: russh::ChannelId, data: &[u8], _session: &mut russh::server::Session) -> Result<(), Self::Error> {
        use std::io::Write;
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let _ = stdin.write_all(data).and_then(|_| stdin.flush());
        }
        Ok(())
    }
}

/// The Linux monitor script run by a real shell: a sample for each line the
/// app sends (every 2 s), none while paused, one at once when resumed.
#[tokio::test(flavor = "multi_thread")]
async fn linux_monitor_samples_on_request_and_pauses() {
    use std::sync::Arc;
    let base = std::env::temp_dir().join(format!("bx-shell-mon-{}", std::process::id()));
    let proc_dir = base.join("proc");
    std::fs::create_dir_all(&proc_dir).unwrap();
    std::fs::write(proc_dir.join("stat"), "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3\n").unwrap();
    std::fs::write(proc_dir.join("meminfo"), "MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:    6000000 kB\nBuffers: 1 kB\nCached: 2 kB\n").unwrap();
    let fake_proc = format!("{}/", proc_dir.to_string_lossy().replace('\\', "/"));

    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut rand::rngs::ThreadRng::default(), russh::keys::Algorithm::Ed25519).unwrap()],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = ShellServer { fake_proc, stdin: Arc::default() };
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            let (config, server) = (config.clone(), server.clone());
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, s, server).await {
                    let _ = running.await;
                }
            });
        }
    });
    let kh = base.join("known_hosts");
    let login = |fp: Option<String>| crate::remote::SshLogin {
        host: "127.0.0.1".into(),
        port,
        username: "mon".into(),
        password: Some("pw".into()),
        cred: None,
        trusted_fingerprint: fp,
        known_hosts: kh.clone(),
    };
    let fp = match crate::remote::ssh_login(login(None)).await {
        Err(e) if e.starts_with("HOSTKEY_UNKNOWN::") => e["HOSTKEY_UNKNOWN::".len()..].to_string(),
        other => panic!("expected a host key prompt: {:?}", other.err()),
    };
    let handle = crate::remote::ssh_login(login(Some(fp))).await.expect("login");
    let (samples, pause) = crate::monitor::test_pump_live(&handle).await;
    let count = || samples.lock().unwrap().len();
    // Samples arrive: one at once, the next after 2 s (with room for a busy
    // machine: the whole test suite runs in parallel).
    tokio::time::sleep(Duration::from_millis(3200)).await;
    let first = count();
    assert!(first >= 2, "samples while shown: {first} {:?}", samples.lock().unwrap());
    let s = samples.lock().unwrap()[0].clone();
    assert_eq!(s["stats"]["memTotal"].as_u64(), Some(8000000 * 1024), "{s}");
    assert!(s["stats"]["diskTotal"].as_u64().is_some(), "df ran on the first sample: {s}");
    // Paused: nothing for 5 s.
    pause.send_replace(true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = count();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(count(), before, "sampled while paused");
    // Resumed: a sample at once.
    pause.send_replace(false);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(count(), before + 1, "no sample right after resuming");
    let _ = std::fs::remove_dir_all(&base);
}

// ---- built-in TFTP and HTTP servers ----------------------------------------------------------

/// Minimal TFTP client for the tests: RRQ with blksize, or WRQ of `upload`.
fn tftp_client(port: u16, op: u16, file: &str, upload: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let s = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut req = vec![0, op as u8];
    req.extend_from_slice(file.as_bytes());
    req.extend_from_slice(b"\0octet\0");
    if op == 1 {
        req.extend_from_slice(b"blksize\x001024\0");
    }
    s.send_to(&req, ("127.0.0.1", port)).unwrap();
    let mut buf = vec![0u8; 70000];
    let mut out = Vec::new();
    let mut blksize = 512;
    let mut next: u16 = 1;
    let mut sent = 0usize;
    loop {
        let (n, from) = s.recv_from(&mut buf).map_err(|e| e.to_string())?;
        let p = &buf[..n];
        match u16::from_be_bytes([p[0], p[1]]) {
            5 => return Err(String::from_utf8_lossy(&p[4..]).trim_end_matches('\0').to_string()),
            6 => {
                // OACK: take blksize, acknowledge with block 0
                let fields: Vec<&[u8]> = p[2..].split(|b| *b == 0).collect();
                if let Some(i) = fields.iter().position(|f| *f == b"blksize") {
                    blksize = std::str::from_utf8(fields[i + 1]).unwrap().parse().unwrap();
                }
                s.send_to(&[0, 4, 0, 0], from).unwrap();
            }
            3 => {
                let block = u16::from_be_bytes([p[2], p[3]]);
                if block == next {
                    out.extend_from_slice(&p[4..]);
                    next = next.wrapping_add(1);
                }
                s.send_to(&[0, 4, p[2], p[3]], from).unwrap();
                if n - 4 < blksize {
                    return Ok(out);
                }
            }
            4 => {
                let data = upload.unwrap();
                let block = u16::from_be_bytes([p[2], p[3]]);
                if sent > data.len() || (block > 0 && sent == data.len() && !sent.is_multiple_of(512)) {
                    return Ok(Vec::new());
                }
                let end = (sent + 512).min(data.len());
                let mut d = vec![0, 3];
                d.extend_from_slice(&(block.wrapping_add(1)).to_be_bytes());
                d.extend_from_slice(&data[sent..end]);
                s.send_to(&d, from).unwrap();
                let last = end - sent < 512;
                sent = end + usize::from(last);
                if last {
                    // wait for the final ACK
                    let _ = s.recv_from(&mut buf);
                    return Ok(Vec::new());
                }
            }
            other => return Err(format!("unexpected opcode {other}")),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn builtin_tftp_and_http_servers_confine_and_serve() {
    use crate::fileservers::{test_start, FileServerConfig};
    let root = std::env::temp_dir().join(format!("bx-fsrv-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(root.join("firmware.bin"), &big).unwrap();
    std::fs::write(root.join("sub").join("한글 파일.txt"), "hello http").unwrap();
    let secret = root.parent().unwrap().join(format!("bx-fsrv-secret-{}.txt", std::process::id()));
    std::fs::write(&secret, "secret").unwrap();
    let cfg = |kind: &str, port: u16, read_only: bool, user: &str, pw: &str| FileServerConfig {
        kind: kind.into(),
        root: root.to_string_lossy().into_owned(),
        port,
        lan: false,
        read_only,
        username: user.into(),
        password: pw.into(),
    };

    // TFTP read-only: download (multi-block, blksize option), refuse upload and escapes.
    let t = test_start(cfg("tftp", 26969, true, "", "")).await;
    let secret_name = secret.file_name().unwrap().to_string_lossy().into_owned();
    let r = root.clone();
    tokio::task::spawn_blocking(move || {
        assert_eq!(tftp_client(26969, 1, "firmware.bin", None).unwrap(), big);
        assert!(tftp_client(26969, 1, &format!("../{secret_name}"), None).is_err());
        assert!(tftp_client(26969, 1, r"C:\Windows\win.ini", None).is_err());
        assert!(tftp_client(26969, 2, "new.cfg", Some(b"x")).is_err(), "read-only must refuse WRQ");
        // A truncated ERROR packet from the peer must only end that transfer.
        let s = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.send_to(b"\0\x01firmware.bin\0octet\0", ("127.0.0.1", 26969)).unwrap();
        let mut b = [0u8; 600];
        let (_, from) = s.recv_from(&mut b).unwrap();
        s.send_to(&[0, 5], from).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(tftp_client(26969, 1, "firmware.bin", None).unwrap().len(), 300_000, "server died");
        assert!(!r.join("new.cfg").exists());
    })
    .await
    .unwrap();
    t.abort();

    // TFTP with uploads allowed.
    let t = test_start(cfg("tftp", 26970, false, "", "")).await;
    let r = root.clone();
    tokio::task::spawn_blocking(move || {
        let cfgdata: Vec<u8> = b"hostname sw1\n".repeat(100);
        tftp_client(26970, 2, "backup/../switch.cfg", Some(&cfgdata)).unwrap_err();
        for empty in ["", ".", "/"] {
            assert!(tftp_client(26970, 2, empty, Some(b"x")).is_err(), "write to {empty:?}");
        }
        tftp_client(26970, 2, "switch.cfg", Some(&cfgdata)).unwrap();
        assert_eq!(std::fs::read(r.join("switch.cfg")).unwrap(), cfgdata);
    })
    .await
    .unwrap();
    t.abort();

    // HTTP with Basic auth.
    let t = test_start(cfg("http", 28080, true, "u", "pass1")).await;
    let get = |path: &str, auth: Option<&str>| {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", 28080)).unwrap();
        use std::io::{Read, Write};
        let auth = auth
            .map(|a| format!("Authorization: Basic {}\r\n", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, a)))
            .unwrap_or_default();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n{auth}\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    };
    tokio::task::spawn_blocking(move || {
        assert!(get("/", None).starts_with("HTTP/1.1 401"));
        assert!(get("/", Some("u:wrong")).starts_with("HTTP/1.1 401"));
        let listing = get("/sub/", Some("u:pass1"));
        assert!(listing.starts_with("HTTP/1.1 200") && listing.contains("%ED%95%9C%EA%B8%80"), "{listing}");
        let file = get("/sub/%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.txt", Some("u:pass1"));
        assert!(file.starts_with("HTTP/1.1 200") && file.ends_with("hello http"), "{file}");
        for bad in ["/../", "/..%2F..%2FWindows/win.ini", "/%2e%2e/x", "/C:/Windows/win.ini"] {
            let r = get(bad, Some("u:pass1"));
            assert!(r.starts_with("HTTP/1.1 404") || r.starts_with("HTTP/1.1 400"), "{bad}: {r}");
        }
        assert!(get("/sub", Some("u:pass1")).starts_with("HTTP/1.1 301"));
    })
    .await
    .unwrap();
    t.abort();
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_file(&secret);
}
