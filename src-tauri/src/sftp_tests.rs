// SFTP folder transfers against an in-process SFTP server (a local folder),
// reached through a proxy that adds network latency: several files at once
// must arrive complete and be clearly faster than one after another.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// One-way delay added by the proxy (a WAN round trip is twice this).
const LATENCY: Duration = Duration::from_millis(15);

#[derive(Clone)]
struct SshServer {
    root: PathBuf,
    /// Most files open at the same time (proves transfers overlap).
    open_now: Arc<AtomicUsize>,
    open_max: Arc<AtomicUsize>,
}

impl russh::server::Handler for SshServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(if user == "sf" && password == "sf-pass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let fs = Fs { root: self.root.clone(), handles: HashMap::new(), next: 0, open_now: self.open_now.clone(), open_max: self.open_max.clone() };
        tokio::spawn(async move {
            // The client asks for the "sftp" subsystem first; serve it on the channel.
            russh_sftp::server::run(channel.into_stream(), fs).await;
        });
        Ok(())
    }

    async fn subsystem_request(&mut self, channel: russh::ChannelId, name: &str, session: &mut russh::server::Session) -> Result<(), Self::Error> {
        if name == "sftp" {
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }
}

enum Open {
    File(tokio::fs::File),
    Dir(Option<Vec<File>>),
}

struct Fs {
    root: PathBuf,
    handles: HashMap<String, Open>,
    next: u64,
    open_now: Arc<AtomicUsize>,
    open_max: Arc<AtomicUsize>,
}

impl Fs {
    fn local(&self, path: &str) -> PathBuf {
        self.root.join(path.trim_start_matches('/'))
    }
    fn handle(&mut self, open: Open) -> String {
        self.next += 1;
        let h = self.next.to_string();
        if matches!(open, Open::File(_)) {
            let now = self.open_now.fetch_add(1, Ordering::SeqCst) + 1;
            self.open_max.fetch_max(now, Ordering::SeqCst);
        }
        self.handles.insert(h.clone(), open);
        h
    }
    fn ok(id: u32) -> Status {
        Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() }
    }
}

fn io(e: std::io::Error) -> StatusCode {
    if e.kind() == std::io::ErrorKind::NotFound { StatusCode::NoSuchFile } else { StatusCode::Failure }
}

impl russh_sftp::server::Handler for Fs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _ext: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let p = if path == "." || path.is_empty() { "/".to_string() } else { path };
        Ok(Name { id, files: vec![File::dummy(p)] })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = tokio::fs::metadata(self.local(&path)).await.map_err(io)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&meta) })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let Some(Open::File(f)) = self.handles.get(&handle) else { return Err(StatusCode::Failure) };
        let meta = f.metadata().await.map_err(io)?;
        Ok(Attrs { id, attrs: FileAttributes::from(&meta) })
    }

    async fn setstat(&mut self, id: u32, _path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        Ok(Self::ok(id))
    }

    async fn fsetstat(&mut self, id: u32, _handle: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        Ok(Self::ok(id))
    }

    async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, _attrs: FileAttributes) -> Result<Handle, Self::Error> {
        let path = self.local(&filename);
        let mut o = tokio::fs::OpenOptions::new();
        o.read(pflags.contains(OpenFlags::READ))
            .write(pflags.contains(OpenFlags::WRITE))
            .create(pflags.contains(OpenFlags::CREATE))
            .truncate(pflags.contains(OpenFlags::TRUNCATE));
        let f = o.open(&path).await.map_err(io)?;
        Ok(Handle { id, handle: self.handle(Open::File(f)) })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        if let Some(Open::File(mut f)) = self.handles.remove(&handle) {
            let _ = f.flush().await;
            self.open_now.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(Self::ok(id))
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let Some(Open::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
        f.seek(std::io::SeekFrom::Start(offset)).await.map_err(io)?;
        let mut buf = vec![0u8; len.min(64 * 1024) as usize];
        let n = f.read(&mut buf).await.map_err(io)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        let Some(Open::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
        f.seek(std::io::SeekFrom::Start(offset)).await.map_err(io)?;
        f.write_all(&data).await.map_err(io)?;
        Ok(Self::ok(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = self.local(&path);
        let mut rd = tokio::fs::read_dir(&dir).await.map_err(io)?;
        let mut files = Vec::new();
        while let Some(e) = rd.next_entry().await.map_err(io)? {
            let meta = e.metadata().await.map_err(io)?;
            files.push(File::new(e.file_name().to_string_lossy().into_owned(), FileAttributes::from(&meta)));
        }
        Ok(Handle { id, handle: self.handle(Open::Dir(Some(files))) })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(Open::Dir(list)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
        match list.take() {
            Some(files) => Ok(Name { id, files }),
            None => Err(StatusCode::Eof),
        }
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        tokio::fs::create_dir_all(self.local(&path)).await.map_err(io)?;
        Ok(Self::ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        tokio::fs::remove_file(self.local(&filename)).await.map_err(io)?;
        Ok(Self::ok(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        let to = self.local(&newpath);
        if tokio::fs::metadata(&to).await.is_ok() {
            return Err(StatusCode::Failure); // like OpenSSH: no overwrite
        }
        tokio::fs::rename(self.local(&oldpath), to).await.map_err(io)?;
        Ok(Self::ok(id))
    }
}

/// Forward bytes both ways, each chunk delivered LATENCY after it arrived
/// (later chunks are not held up behind earlier ones: like a real link).
async fn delayed_proxy(server_port: u16) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let server = tokio::net::TcpStream::connect(("127.0.0.1", server_port)).await.unwrap();
            let _ = client.set_nodelay(true);
            let _ = server.set_nodelay(true);
            let (cr, cw) = client.into_split();
            let (sr, sw) = server.into_split();
            tokio::spawn(pipe(cr, sw));
            tokio::spawn(pipe(sr, cw));
        }
    });
    port
}

async fn pipe(mut from: tokio::net::tcp::OwnedReadHalf, mut to: tokio::net::tcp::OwnedWriteHalf) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    tokio::spawn(async move {
        while let Some((due, data)) = rx.recv().await {
            tokio::time::sleep_until(due.into()).await;
            if to.write_all(&data).await.is_err() {
                break;
            }
        }
    });
    let mut buf = vec![0u8; 64 * 1024];
    while let Ok(n) = from.read(&mut buf).await {
        if n == 0 || tx.send((Instant::now() + LATENCY, buf[..n].to_vec())).is_err() {
            break;
        }
    }
}

fn files_in(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files_in(&p).into_iter().map(|(n, d)| (format!("{}/{n}", e.file_name().to_string_lossy()), d)));
        } else {
            out.push((e.file_name().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()));
        }
    }
    out.sort();
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_folder_transfers_copy_several_files_at_once() {
    let base = std::env::temp_dir().join(format!("bx-sftp-par-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (served, source, back) = (base.join("server"), base.join("source"), base.join("back"));
    for d in [&served, &source] {
        std::fs::create_dir_all(d).unwrap();
    }
    // 40 small files in two folders, plus one larger file.
    std::fs::create_dir_all(source.join("conf")).unwrap();
    for i in 0..40 {
        let dir = if i % 2 == 0 { source.clone() } else { source.join("conf") };
        std::fs::write(dir.join(format!("f{i:02}.txt")), format!("line {i}\n").repeat(50 + i)).unwrap();
    }
    std::fs::write(source.join("big.bin"), (0..600_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();

    let open_max = Arc::new(AtomicUsize::new(0));
    let ssh = SshServer { root: served.clone(), open_now: Arc::default(), open_max: open_max.clone() };
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut rand::rngs::ThreadRng::default(), russh::keys::Algorithm::Ed25519).unwrap()],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            let (config, ssh) = (config.clone(), ssh.clone());
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, s, ssh).await {
                    let _ = running.await;
                }
            });
        }
    });
    let port = delayed_proxy(server_port).await;

    let kh = base.join("known_hosts");
    let fp = match crate::remote::test_sftp_folder(port, None, &kh, "/up", &source, true).await {
        Err(e) if e.starts_with("HOSTKEY_UNKNOWN::") => e["HOSTKEY_UNKNOWN::".len()..].to_string(),
        other => panic!("expected a host key prompt: {other:?}"),
    };
    let (up_files, up_bytes, up_time) = crate::remote::test_sftp_folder(port, Some(fp.clone()), &kh, "/up", &source, true).await.expect("upload");
    let (down_files, down_bytes, down_time) = crate::remote::test_sftp_folder(port, Some(fp), &kh, "/up", &back, false).await.expect("download");
    println!("upload {up_files} files {up_bytes} B in {up_time:?}; download {down_files} files {down_bytes} B in {down_time:?}; most open at once: {}", open_max.load(Ordering::SeqCst));

    assert_eq!(files_in(&served.join("up")), files_in(&source), "uploaded tree");
    assert_eq!(files_in(&back), files_in(&source), "downloaded tree");
    assert_eq!((up_files, down_files), (41, 41));
    assert!(open_max.load(Ordering::SeqCst) >= 2, "files overlapped");
    // One after another, each small file costs several round trips (2 x LATENCY
    // each): 41 files x ~5 round trips x 30 ms is about 6 s per direction.
    assert!(down_time < Duration::from_secs(4) && up_time < Duration::from_secs(4), "{up_time:?} {down_time:?}");
    let _ = std::fs::remove_dir_all(&base);
}
