// SSH tunnels (local port forwarding) without an external ssh process: a
// loopback listener whose connections are carried to a target host through an
// authenticated SSH connection (direct-tcpip channels).
//
// Used two ways:
// - as an "SSH gateway" for RDP, VNC and Telnet sessions (random local port,
//   closed with the tab), and
// - by the tunnel manager (fixed local port, started and stopped by the user).
//
// The SSH login reuses remote.rs (known_hosts check, approved fingerprint,
// vault credentials), so the UI handles HOSTKEY_*/NEED_PASSWORD the same way.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpListener;

use crate::remote::{known_hosts_path, ssh_login, HostCheck, SshLogin};
use crate::vault;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRequest {
    /// Caller-chosen id (a tab id, or a saved tunnel's id).
    pub id: String,
    /// The SSH server the traffic goes through.
    pub gateway_host: String,
    #[serde(default)]
    pub gateway_port: Option<u16>,
    #[serde(default)]
    pub gateway_username: String,
    #[serde(default)]
    pub gateway_credential_id: Option<String>,
    /// Typed at connect time; never stored.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub trusted_fingerprint: Option<String>,
    /// Where connections are forwarded to, as seen from the gateway.
    pub target_host: String,
    pub target_port: u16,
    /// Local port to listen on; 0 picks a free one.
    #[serde(default)]
    pub local_port: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub local_port: u16,
    pub target: String,
    pub gateway: String,
    /// Connections currently open through the tunnel.
    pub active: u32,
    /// Connections carried since the tunnel started.
    pub total: u64,
}

struct Tunnel {
    info: TunnelInfo,
    active: Arc<AtomicU32>,
    total: Arc<AtomicU64>,
    accept: JoinHandle<()>,
    /// Relays of open connections, stopped with the tunnel.
    relays: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Tunnel {
    fn stop(self) {
        self.accept.abort();
        for r in self.relays.lock().unwrap().drain(..) {
            r.abort();
        }
    }

    fn snapshot(&self) -> TunnelInfo {
        TunnelInfo {
            active: self.active.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            ..self.info.clone()
        }
    }
}

#[derive(Default)]
pub struct TunnelState {
    tunnels: Mutex<HashMap<String, Tunnel>>,
}

/// Decrements the active count when a relay ends, however it ends.
struct ActiveGuard(Arc<AtomicU32>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn tunnel_open(app: AppHandle, state: State<'_, TunnelState>, req: TunnelRequest) -> Result<TunnelInfo, String> {
    if req.target_host.trim().is_empty() || req.target_port == 0 {
        return Err("터널 대상 주소가 올바르지 않습니다".into());
    }
    let cred = match req.gateway_credential_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(vault::resolve(&app, id)?),
        None => None,
    };
    let username = if req.gateway_username.is_empty() {
        cred.as_ref().map(|c| c.username.clone()).unwrap_or_default()
    } else {
        req.gateway_username.clone()
    };
    if username.is_empty() {
        return Err("게이트웨이 SSH 사용자 이름이 필요합니다".into());
    }
    let password = req.password.clone().filter(|p| !p.is_empty()).or_else(|| cred.as_ref().and_then(|c| c.password.clone()));
    let gw_port = req.gateway_port.unwrap_or(22);

    // Restarting a tunnel on a fixed port: the old one holds that port, so it
    // stops first instead of making the bind fail with "port in use".
    let restarting = req.local_port != 0 && {
        let old = state.tunnels.lock().unwrap().remove(&req.id);
        old.map(|old| old.stop()).is_some()
    };
    // Bind first: a taken fixed port should fail before logging in anywhere.
    // A restarted tunnel's own listener may take a moment to close.
    let mut bound = TcpListener::bind(("127.0.0.1", req.local_port)).await;
    for _ in 0..10 {
        match &bound {
            Err(e) if restarting && e.kind() == std::io::ErrorKind::AddrInUse => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                bound = TcpListener::bind(("127.0.0.1", req.local_port)).await;
            }
            _ => break,
        }
    }
    let listener = bound.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("로컬 포트 {}을(를) 이미 다른 프로그램이 사용 중입니다", req.local_port)
        } else {
            format!("로컬 포트를 열 수 없습니다: {e}")
        }
    })?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let handle = ssh_login(SshLogin {
        host: req.gateway_host.clone(),
        port: gw_port,
        username: username.clone(),
        password,
        cred,
        trusted_fingerprint: req.trusted_fingerprint.clone(),
        known_hosts: known_hosts_path(),
    })
    .await?;
    let info = TunnelInfo {
        id: req.id.clone(),
        local_port,
        target: format!("{}:{}", req.target_host, req.target_port),
        gateway: format!("{username}@{}:{gw_port}", req.gateway_host),
        active: 0,
        total: 0,
    };
    let tunnel = start(handle, listener, info.clone(), req.target_host.clone(), req.target_port, Some(app));
    let replaced = state.tunnels.lock().unwrap().insert(req.id.clone(), tunnel);
    if let Some(old) = replaced {
        old.stop();
    }
    Ok(info)
}

/// Serve `listener`: every accepted connection becomes a direct-tcpip channel
/// to the target through the logged-in SSH connection.
fn start(
    handle: russh::client::Handle<HostCheck>,
    listener: TcpListener,
    info: TunnelInfo,
    target_host: String,
    target_port: u16,
    app: Option<AppHandle>,
) -> Tunnel {
    let handle = Arc::new(handle);
    let active = Arc::new(AtomicU32::new(0));
    let total = Arc::new(AtomicU64::new(0));
    let relays: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
    let emit = move |id: &str, kind: &str, detail: String| {
        if let Some(app) = &app {
            let _ = app.emit("tunnel-event", json!({ "id": id, "kind": kind, "detail": detail }));
        }
    };
    let emit = Arc::new(emit);
    let (a, t, r, id) = (active.clone(), total.clone(), relays.clone(), info.id.clone());
    let accept = tauri::async_runtime::spawn(async move {
        loop {
            // Wake up regularly so a dead gateway ends the tunnel right away,
            // not only when the next connection arrives.
            let accepted = tokio::select! {
                r = listener.accept() => Some(r),
                () = tokio::time::sleep(std::time::Duration::from_secs(2)) => None,
            };
            if handle.is_closed() {
                emit(&id, "closed", "게이트웨이 SSH 연결이 끊어졌습니다".into());
                break;
            }
            let Some(Ok((mut local, peer))) = accepted else { continue };
            let (handle, target_host, a, t, emit, id) = (handle.clone(), target_host.clone(), a.clone(), t.clone(), emit.clone(), id.clone());
            let relay = tauri::async_runtime::spawn(async move {
                a.fetch_add(1, Ordering::Relaxed);
                t.fetch_add(1, Ordering::Relaxed);
                let _guard = ActiveGuard(a);
                let channel = match handle
                    .channel_open_direct_tcpip(target_host.clone(), u32::from(target_port), peer.ip().to_string(), u32::from(peer.port()))
                    .await
                {
                    Ok(c) => c,
                    Err(e) => {
                        emit(&id, "error", format!("{target_host}:{target_port} 로 연결할 수 없습니다: {e}"));
                        return;
                    }
                };
                let mut remote = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
            });
            let mut list = r.lock().unwrap();
            list.retain(|h| !h.inner().is_finished());
            list.push(relay);
        }
    });
    Tunnel { info, active, total, accept, relays }
}

/// Test helper: forward a free local port to the target through `login`.
#[cfg(test)]
pub(crate) async fn test_forward(login: SshLogin, target_host: &str, target_port: u16) -> Result<(u16, impl FnOnce()), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let handle = ssh_login(login).await?;
    let info = TunnelInfo { id: "t".into(), local_port: port, target: String::new(), gateway: String::new(), active: 0, total: 0 };
    let tunnel = start(handle, listener, info, target_host.to_string(), target_port, None);
    Ok((port, move || tunnel.stop()))
}

#[tauri::command]
pub fn tunnel_close(state: State<TunnelState>, id: String) {
    if let Some(t) = state.tunnels.lock().unwrap().remove(&id) {
        t.stop();
    }
}

#[tauri::command]
pub fn tunnel_list(state: State<TunnelState>) -> Vec<TunnelInfo> {
    let mut tunnels = state.tunnels.lock().unwrap();
    // A tunnel whose gateway connection died has stopped accepting: drop it,
    // so callers see it as closed and open a fresh one.
    tunnels.retain(|_, t| !t.accept.inner().is_finished());
    tunnels.values().map(Tunnel::snapshot).collect()
}
