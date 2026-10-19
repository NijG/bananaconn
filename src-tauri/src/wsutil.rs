// Loopback WebSocket endpoints for the page (VNC relay, RDP screen updates).
// Other local processes can reach a loopback port, so every endpoint needs a
// random path token, and the handshake must come from the app's own page.

use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request};
use tokio_tungstenite::tungstenite::http::StatusCode;

/// 128-bit token from the OS-seeded CSPRNG.
pub fn random_token() -> String {
    use rand::Rng as _;
    let mut bytes = [0u8; 16];
    rand::rngs::ThreadRng::default().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The page's origin: the bundled app, or the dev server in debug builds.
fn page_origin(origin: &str) -> bool {
    matches!(origin, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost")
        || (cfg!(debug_assertions) && origin == "http://localhost:1420")
}

/// Accept the handshake only on `/token` from the app's page.
// The error type is fixed by tungstenite's handshake callback.
#[allow(clippy::result_large_err)]
pub fn check(req: &Request, expected_path: &str) -> Result<(), ErrorResponse> {
    let origin_ok = req.headers().get("Origin").and_then(|v| v.to_str().ok()).is_some_and(page_origin);
    if req.uri().path() == expected_path && origin_ok {
        return Ok(());
    }
    let mut deny = ErrorResponse::new(None);
    *deny.status_mut() = StatusCode::FORBIDDEN;
    Err(deny)
}
