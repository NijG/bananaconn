// The network tools' certificate check: a TLS handshake with host:port that
// reads the certificate the server offers (who it names, who issued it, when
// it expires) and whether this PC's trust store accepts it for that name.
// Nothing is sent after the handshake; the connection is then dropped. The
// handshake accepts any certificate (signatures are still verified), so an
// expired or self-signed one is shown rather than refused: the check reports
// trust, it does not enforce it.

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The whole check, name lookup to the end of the handshake.
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// The certificate's subject and issuer, as RFC 4514 writes a name ("CN=example.com, O=…").
    pub subject: String,
    pub issuer: String,
    /// Its subjectAltName DNS names and addresses.
    pub names: Vec<String>,
    /// Validity, as Unix seconds.
    pub not_before: i64,
    pub not_after: i64,
    /// SHA-256 of the certificate, colon hex.
    pub fingerprint: String,
    /// It names itself as its issuer (a device's own certificate).
    pub self_signed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsInfo {
    pub cert: CertInfo,
    /// Why this PC's trust store would refuse it for the name connected to;
    /// None when it accepts it.
    pub untrusted: Option<String>,
    /// Certificates the server sent in all (its own and intermediates).
    pub chain: usize,
    /// "TLSv1_3", the negotiated suite.
    pub version: String,
    pub cipher: String,
    pub ms: u64,
}

/// What a certificate says about itself, read from its DER bytes.
pub fn read_cert(der: &[u8]) -> Result<CertInfo, String> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).map_err(|e| format!("인증서를 읽을 수 없습니다: {e}"))?;
    let mut names = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            match name {
                x509_parser::extensions::GeneralName::DNSName(d) => names.push(crate::servertext::shown(d)),
                x509_parser::extensions::GeneralName::IPAddress(b) => match b.len() {
                    4 => names.push(std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string()),
                    16 => {
                        let mut a = [0u8; 16];
                        a.copy_from_slice(b);
                        names.push(std::net::Ipv6Addr::from(a).to_string());
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }
    let d = ring::digest::digest(&ring::digest::SHA256, der);
    // The names are whoever made the certificate's text (a device's own one
    // anyone can make): what would turn the text around them shown as a mark.
    // Whether it names itself is decided on the names as they are.
    Ok(CertInfo {
        subject: crate::servertext::shown(&cert.subject().to_string()),
        issuer: crate::servertext::shown(&cert.issuer().to_string()),
        names,
        not_before: cert.validity().not_before.timestamp(),
        not_after: cert.validity().not_after.timestamp(),
        fingerprint: d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"),
        self_signed: cert.subject() == cert.issuer(),
    })
}

/// Why a chain is not trusted, in the user's terms; the rest by rustls' words.
fn trust_text(e: &rustls::Error) -> String {
    use rustls::CertificateError as C;
    match e {
        rustls::Error::InvalidCertificate(C::Expired | C::ExpiredContext { .. }) => "만료된 인증서입니다".into(),
        rustls::Error::InvalidCertificate(C::NotValidYet | C::NotValidYetContext { .. }) => "아직 유효 기간이 시작되지 않은 인증서입니다".into(),
        rustls::Error::InvalidCertificate(C::NotValidForName | C::NotValidForNameContext { .. }) => "접속한 이름과 인증서의 이름이 맞지 않습니다".into(),
        rustls::Error::InvalidCertificate(C::UnknownIssuer) => "이 PC가 신뢰하지 않는 발급자입니다 (자체 서명이거나 중간 인증서가 빠짐)".into(),
        rustls::Error::InvalidCertificate(C::Revoked) => "폐기된 인증서입니다".into(),
        other => format!("신뢰할 수 없는 인증서입니다: {other}"),
    }
}

/// What the handshake showed: the server's certificate (DER), how many it
/// sent, and why this PC would not trust it (None: it would).
type Seen = Arc<Mutex<Option<(Vec<u8>, usize, Option<String>)>>>;

/// Accepts any certificate, recording the chain and what the native
/// verifier says of it; handshake signatures are verified as usual.
#[derive(Debug)]
struct Recorder {
    native: Option<Arc<rustls::client::WebPkiServerVerifier>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
    seen: Seen,
}

impl rustls::client::danger::ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let untrusted = match &self.native {
            Some(v) => v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now).err().map(|e| trust_text(&e)),
            None => Some("Windows 인증서 저장소를 읽을 수 없습니다".into()),
        };
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some((end_entity.as_ref().to_vec(), 1 + intermediates.len(), untrusted));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// One step of the handshake: what is to be sent, sent; one read of what came,
/// and its records processed. End of stream is an error (the server closed).
fn handshake_step(conn: &mut rustls::ClientConnection, tcp: &mut TcpStream) -> std::io::Result<()> {
    while conn.wants_write() {
        conn.write_tls(tcp)?;
    }
    if conn.is_handshaking() && conn.wants_read() {
        if conn.read_tls(tcp)? == 0 {
            return Err(std::io::Error::from(ErrorKind::UnexpectedEof));
        }
        conn.process_new_packets().map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    }
    // A final flight to send (a TLS 1.3 client's Finished).
    while conn.wants_write() {
        conn.write_tls(tcp)?;
    }
    Ok(())
}

/// The handshake with host:port and what it showed.
fn check(host: &str, port: u16) -> Result<TlsInfo, String> {
    let started = Instant::now();
    // One limit for the whole check: a server trickling its handshake a byte
    // at a time would otherwise keep each read just inside its timeout.
    let deadline = started + TIMEOUT;
    // Every address the name has, as the port check tries them ("localhost"
    // is ::1 first; a service may listen on 127.0.0.1 only). The address
    // keeps its zone ("fe80::1%12").
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|e| format!("{host} 주소를 찾을 수 없습니다: {e}"))?.collect();
    if addrs.is_empty() {
        return Err(format!("{host} 주소를 찾을 수 없습니다"));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let native = (!roots.is_empty())
        .then(|| rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().ok())
        .flatten();
    let seen = Arc::new(Mutex::new(None));
    let verifier = Recorder { native, provider: provider.clone(), seen: seen.clone() };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS를 초기화할 수 없습니다: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let config = Arc::new(config);
    // A name is sent as SNI and checked against the certificate; an address
    // is checked against its IP names (no SNI is sent for one).
    // The name without an address's zone, which no certificate names.
    let bare = host.split_once('%').map_or(host, |(a, _)| a);
    let name = rustls::pki_types::ServerName::try_from(bare.to_string()).map_err(|_| "호스트 이름이 올바르지 않습니다".to_string())?;
    let timed_out = || format!("{host}:{port} 이(가) TLS로 응답하지 않습니다 (시간 초과)");
    // Each address in turn until one shows a certificate: the first to take
    // the connection may be another service (::1 answering, the TLS service
    // on 127.0.0.1 only). What went wrong with the last one is told.
    let mut last_error: Option<String> = None;
    for addr in &addrs {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            last_error = Some(timed_out());
            break;
        }
        let mut tcp = match TcpStream::connect_timeout(addr, left) {
            Ok(t) => t,
            Err(e) => {
                last_error = Some(format!("{host}:{port} 에 연결할 수 없습니다: {e}"));
                continue;
            }
        };
        if let Ok(mut slot) = seen.lock() {
            *slot = None;
        }
        let mut conn = rustls::ClientConnection::new(config.clone(), name.clone()).map_err(|e| format!("TLS를 초기화할 수 없습니다: {e}"))?;
        // Why the handshake did not finish, when it did not.
        let mut failed: Option<String> = None;
        while conn.is_handshaking() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                failed = Some(timed_out());
                break;
            }
            let _ = tcp.set_read_timeout(Some(left));
            let _ = tcp.set_write_timeout(Some(left));
            // One step at a time (complete_io keeps reading while bytes come, so
            // a deadline set around it would never be looked at again).
            if let Err(e) = handshake_step(&mut conn, &mut tcp) {
                failed = Some(match e.kind() {
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => timed_out(),
                    ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted => format!("{host}:{port} 이(가) TLS 연결을 끊었습니다 (TLS 포트가 아닐 수 있음)"),
                    _ => format!("{host}:{port} 와 TLS 연결에 실패했습니다: {e}"),
                });
                break;
            }
        }
        let recorded = seen.lock().ok().and_then(|s| s.clone());
        let (der, chain, untrusted) = match (recorded, failed) {
            (Some(r), None) => r,
            // The certificate was read but the handshake did not finish (an old
            // protocol only, a client certificate required, or a signature that
            // failed: a server showing a certificate it holds no key for). It is
            // still shown, never as trusted: the server proved nothing.
            (Some((der, chain, _)), Some(why)) => (der, chain, Some(format!("TLS 핸드셰이크를 마치지 못해 신뢰할 수 없습니다: {why}"))),
            // No certificate from this address: the next one is tried.
            (None, why) => {
                last_error = Some(why.unwrap_or_else(|| format!("{host}:{port} 이(가) 인증서를 보내지 않았습니다")));
                continue;
            }
        };
        return Ok(TlsInfo {
            cert: read_cert(&der)?,
            untrusted,
            chain,
            version: conn.protocol_version().map(|v| format!("{v:?}")).unwrap_or_default(),
            cipher: conn.negotiated_cipher_suite().map(|c| format!("{:?}", c.suite())).unwrap_or_default(),
            ms: started.elapsed().as_millis() as u64,
        });
    }
    Err(last_error.unwrap_or_else(timed_out))
}

#[tauri::command]
pub async fn net_tls(host: String, port: u16) -> Result<TlsInfo, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if host.is_empty() || port == 0 {
        return Err("호스트와 포트를 입력하세요".into());
    }
    tauri::async_runtime::spawn_blocking(move || check(&host, port)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{check, read_cert, trust_text};

    #[test]
    fn what_is_not_a_certificate_is_said_so() {
        assert!(read_cert(b"not a certificate").unwrap_err().starts_with("인증서를 읽을 수 없습니다"));
    }

    #[test]
    fn untrusted_reasons_are_the_users_words() {
        use rustls::CertificateError as C;
        assert_eq!(trust_text(&rustls::Error::InvalidCertificate(C::Expired)), "만료된 인증서입니다");
        assert_eq!(trust_text(&rustls::Error::InvalidCertificate(C::NotValidForName)), "접속한 이름과 인증서의 이름이 맞지 않습니다");
        assert!(trust_text(&rustls::Error::InvalidCertificate(C::UnknownIssuer)).contains("신뢰하지 않는 발급자"));
    }

    /// A server that answers one byte at a time (each read just inside its
    /// timeout) is given up on at the one deadline for the whole check.
    #[test]
    fn a_trickling_server_is_given_up_on() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                // A TLS handshake record's header, never finished.
                for b in [0x16u8, 0x03, 0x03, 0x40, 0x00].iter().cycle().take(60) {
                    if s.write_all(&[*b]).is_err() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
            }
        });
        let started = std::time::Instant::now();
        let err = check("127.0.0.1", port).err().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(13), "{:?}", started.elapsed());
        assert!(err.contains("시간 초과"), "{err}");
    }

    /// "localhost" is tried at each of its addresses: a server on 127.0.0.1
    /// only is reached although ::1 comes first.
    #[test]
    fn every_address_of_a_name_is_tried() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || drop(listener.accept()));
        // Reached (the connection then closes: not a TLS port), not "cannot connect".
        let err = check("localhost", port).err().unwrap();
        assert!(!err.contains("연결할 수 없습니다"), "{err}");
    }

    /// An address that takes the connection but shows no certificate (another
    /// service on ::1) does not end the check: the next address is tried.
    #[test]
    fn an_address_without_tls_gives_way_to_the_next() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let Ok(v6) = std::net::TcpListener::bind("[::1]:0") else { return };
        let port = v6.local_addr().unwrap().port();
        let Ok(v4) = std::net::TcpListener::bind(("127.0.0.1", port)) else { return };
        let reached = std::sync::Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || drop(v6.accept()));
        let flag = reached.clone();
        std::thread::spawn(move || {
            // Bound, so the connection stays open until the flag is set.
            if let Ok(_conn) = v4.accept() {
                flag.store(true, Ordering::SeqCst);
            }
        });
        assert!(check("localhost", port).is_err());
        assert!(reached.load(Ordering::SeqCst), "127.0.0.1 was never tried");
    }

    /// A public server's certificate, read and trusted; an expired one read
    /// and said to be expired. Needs the internet, so not run by default.
    #[test]
    #[ignore]
    fn a_servers_certificate_is_read() {
        let ok = check("example.com", 443).unwrap();
        assert!(ok.untrusted.is_none(), "{:?}", ok.untrusted);
        assert!(ok.cert.names.iter().any(|n| n.contains("example")), "{:?}", ok.cert.names);
        assert!(ok.cert.not_after > ok.cert.not_before && ok.chain >= 1 && !ok.version.is_empty());
        // That public server answers in under a second to over ten: tried again when slow.
        let expired = (0..3).find_map(|_| check("expired.badssl.com", 443).ok()).expect("expired.badssl.com did not answer");
        assert_eq!(expired.untrusted.as_deref(), Some("만료된 인증서입니다"));
        assert!(check("example.com", 80).is_err());
    }
}

