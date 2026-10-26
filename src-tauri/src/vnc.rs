// Built-in VNC. The embedded noVNC client speaks RFB over WebSocket, so this
// module runs a loopback-only WebSocket listener that relays frames to the VNC
// server's TCP port. Each proxy requires a random path token, so other local
// processes cannot use it as an open relay.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

type Task = tauri::async_runtime::JoinHandle<()>;

/// The accept loop plus every relay it started, so closing a tab ends live
/// connections too, not just the listener.
struct Proxy {
    accept: Task,
    relays: Arc<Mutex<Vec<Task>>>,
    /// Bytes relayed from the VNC server to the page (for the status view).
    received: Arc<std::sync::atomic::AtomicU64>,
    /// Why the last relay could not reach the server (shown by the page,
    /// which only sees the WebSocket close).
    last_error: Arc<Mutex<Option<String>>>,
}

impl Proxy {
    fn stop(self) {
        self.accept.abort();
        for relay in self.relays.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
            relay.abort();
        }
    }
}

#[derive(Default)]
pub struct VncState {
    proxies: Mutex<HashMap<String, Proxy>>,
}

#[derive(Serialize)]
pub struct VncProxy {
    pub url: String,
}

use crate::wsutil::random_token;

#[tauri::command]
pub async fn vnc_proxy_start(state: State<'_, VncState>, id: String, host: String, port: u16) -> Result<VncProxy, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("VNC 중계를 시작할 수 없습니다: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token();
    // Connect by (host, port) so IPv6 literals work; accept "[::1]" as typed.
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    let target = (host, port);

    let path = format!("/{token}");
    let relays: Arc<Mutex<Vec<Task>>> = Arc::default();
    let tracked = relays.clone();
    let received: Arc<std::sync::atomic::AtomicU64> = Arc::default();
    let counter = received.clone();
    let last_error: Arc<Mutex<Option<String>>> = Arc::default();
    let errors = last_error.clone();
    let accept = tauri::async_runtime::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let path = path.clone();
            let target = target.clone();
            let counter = counter.clone();
            let errors = errors.clone();
            let relay = tauri::async_runtime::spawn(async move {
                if let Err(e) = bridge(stream, path, target, counter).await {
                    *errors.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                }
            });
            let mut list = tracked.lock().unwrap_or_else(|p| p.into_inner());
            list.retain(|t| !t.inner().is_finished());
            list.push(relay);
        }
    });
    if let Some(old) = state.proxies.lock().unwrap_or_else(|p| p.into_inner()).insert(id, Proxy { accept, relays, received, last_error }) {
        old.stop();
    }
    Ok(VncProxy {
        url: format!("ws://127.0.0.1:{local_port}/{token}"),
    })
}

/// Bytes the relay has passed from the VNC server to the page so far.
#[tauri::command]
pub fn vnc_proxy_stats(state: State<VncState>, id: String) -> u64 {
    state
        .proxies
        .lock()
        .unwrap()
        .get(&id)
        .map(|p| p.received.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(0)
}

/// Why the relay last failed to reach the VNC server, if it did.
#[tauri::command]
pub fn vnc_proxy_error(state: State<VncState>, id: String) -> Option<String> {
    state.proxies.lock().unwrap_or_else(|p| p.into_inner()).get(&id).and_then(|p| p.last_error.lock().unwrap_or_else(|p| p.into_inner()).clone())
}

#[tauri::command]
pub fn vnc_proxy_stop(state: State<VncState>, id: String) {
    if let Some(proxy) = state.proxies.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
        proxy.stop();
    }
}

/// Test helper: start a bridge to 127.0.0.1:port without Tauri state.
#[cfg(test)]
pub async fn test_start(port: u16) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_port = listener.local_addr().unwrap().port();
    let token = random_token();
    let path = format!("/{token}");
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let path = path.clone();
            tokio::spawn(async move {
                let _ = bridge(stream, path, ("127.0.0.1".to_string(), port), Arc::default()).await;
            });
        }
    });
    format!("ws://127.0.0.1:{local_port}/{token}")
}

#[allow(clippy::result_large_err)] // tungstenite fixes the handshake error type
async fn bridge(
    stream: TcpStream,
    expected_path: String,
    target: (String, u16),
    received: Arc<std::sync::atomic::AtomicU64>,
) -> Result<(), String> {
    let check = move |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        // Token path, and only the app's own page may connect.
        crate::wsutil::check(req, &expected_path)?;
        let wants_binary = req
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|p| p.trim() == "binary"));
        if wants_binary {
            resp.headers_mut()
                .insert("Sec-WebSocket-Protocol", HeaderValue::from_static("binary"));
        }
        Ok(resp)
    };
    // Small screen updates must not wait for Nagle on the way to the page.
    let _ = stream.set_nodelay(true);
    let ws = tokio_tungstenite::accept_hdr_async(stream, check)
        .await
        .map_err(|e| e.to_string())?;
    // Bounded: Windows would otherwise wait about 21 s for a silent host.
    let tcp = match tokio::time::timeout(std::time::Duration::from_secs(15), TcpStream::connect((target.0.as_str(), target.1))).await {
        Ok(Ok(tcp)) => tcp,
        Ok(Err(e)) => return Err(format!("{}:{} 에 연결할 수 없습니다: {e}", target.0, target.1)),
        Err(_) => return Err(format!("{}:{} 이(가) 15초 동안 응답하지 않습니다", target.0, target.1)),
    };
    let _ = tcp.set_nodelay(true);

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rx, mut tcp_tx) = tcp.into_split();

    let to_server = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    if tcp_tx.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    let to_client = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    received.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                    if ws_tx.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
    };
    tokio::select! {
        _ = to_server => {}
        _ = to_client => {}
    }
    Ok(())
}
