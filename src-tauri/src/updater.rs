// Self-update from a folder (a network share or a local path) or a web
// address (https://, e.g. a GitHub release download URL). The build machine
// publishes `latest.json` next to the installers:
//
//   { "version": "0.7.5", "nsis": "BananaConn_0.7.5_x64-setup.exe",
//     "msi": "BananaConn_0.7.5_x64_en-US.msi", "nsisSha256": "...",
//     "msiSha256": "...", "notes": "...", "signature": "<base64 Ed25519>" }
//
// The signature covers every other field (see `signed_message`) and is made
// with a key that exists only on the build machine, so a file someone else
// drops into the share is never installed. The installer is copied to a
// private temp folder and its SHA-256 checked there before it runs, so the
// share cannot swap it between the check and the launch.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Public half of the build machine's update signing key (Ed25519, raw).
const PUBLIC_KEY: &str = "85tBnC+F1YsQs3HfgZc5Ea2Ax0U/avzk1uTRCocnCbQ=";

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    pub nsis: String,
    pub nsis_sha256: String,
    #[serde(default)]
    pub msi: String,
    #[serde(default)]
    pub msi_sha256: String,
    /// Korean release notes (what versions before 0.7.25 show).
    #[serde(default)]
    pub notes: String,
    /// The release notes in other screen languages ("en", "ja", "zh-CN" …).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub notes_i18n: BTreeMap<String, String>,
    pub signature: String,
    /// Signature over everything `signature` covers plus `notes_i18n`; older
    /// versions ignore both fields and check `signature` alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_v2: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newer version, or None when up to date.
    pub available: Option<String>,
    pub notes: String,
    /// Signed translations of `notes` by screen language.
    pub notes_i18n: BTreeMap<String, String>,
}

/// The exact bytes the build machine signs.
pub(crate) fn signed_message(m: &Manifest) -> String {
    format!(
        "bananaxterm-update\n{}\n{}\n{}\n{}\n{}\n{}",
        m.version, m.nsis, m.nsis_sha256, m.msi, m.msi_sha256, m.notes
    )
}

/// What `signature_v2` covers: the first message, then the translations as
/// compact JSON with sorted keys (the publish script writes the same text).
pub(crate) fn signed_message_v2(m: &Manifest) -> String {
    format!("{}\nnotes-i18n\n{}", signed_message(m), serde_json::to_string(&m.notes_i18n).unwrap_or_default())
}

fn check(signature: &str, message: &str, public_key: &[u8]) -> Result<(), String> {
    let sig = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|_| "업데이트 서명 형식이 올바르지 않습니다".to_string())?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
        .verify(message.as_bytes(), &sig)
        .map_err(|_| "업데이트 서명이 맞지 않습니다. 공식 빌드가 아닌 파일은 설치하지 않습니다".to_string())
}

/// Both signatures must hold. Translations without `signature_v2` are not
/// trusted and are dropped (the Korean notes still show).
fn verify_with(m: &mut Manifest, public_key: &[u8]) -> Result<(), String> {
    check(&m.signature, &signed_message(m), public_key)?;
    match &m.signature_v2 {
        Some(sig) => check(sig, &signed_message_v2(m), public_key),
        None => {
            m.notes_i18n.clear();
            Ok(())
        }
    }
}

fn verify(m: &mut Manifest) -> Result<(), String> {
    let key = base64::engine::general_purpose::STANDARD.decode(PUBLIC_KEY).map_err(|e| e.to_string())?;
    verify_with(m, &key)
}

/// "0.7.10" > "0.7.9"; anything that is not numeric dotted is "not newer".
pub(crate) fn newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Option<Vec<u64>> { v.trim().trim_start_matches('v').split('.').map(|p| p.parse().ok()).collect() };
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// An installer name from the manifest must be a plain file name in the folder.
fn plain_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && (name.ends_with(".exe") || name.ends_with(".msi"));
    if ok { Ok(name) } else { Err("업데이트 정보의 파일 이름이 올바르지 않습니다".into()) }
}

fn sha256_hex(data: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, data).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

const EXPLORER: &str = r"C:\Windows\explorer.exe";

/// Where updates are published.
enum Source {
    Folder(PathBuf),
    /// Base address ending in "/"; files are fetched as base + name.
    Web(String),
}

fn source_of(source: &str) -> Result<Source, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("설정에서 업데이트 폴더를 먼저 지정하세요".into());
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(Source::Web(if s.ends_with('/') { s.to_string() } else { format!("{s}/") }));
    }
    if lower.starts_with("http://") {
        return Err("업데이트 주소는 https:// 로 시작해야 합니다".into());
    }
    Ok(Source::Folder(PathBuf::from(s)))
}

/// Test and development builds never update from the public release: what
/// they find there would depend on what was last published.
fn released_only(app: &AppHandle, src: Source) -> Result<Source, String> {
    match src {
        Source::Web(_) if !crate::legacy::is_release(&app.config().identifier) => Err("공식 빌드가 아니어서 GitHub 업데이트를 건너뜁니다".into()),
        src => Ok(src),
    }
}

/// Largest file fetched from the web (installers are about 10 MB).
const WEB_LIMIT: usize = 512 * 1024 * 1024;

/// GET over HTTPS with WinHTTP: the system's certificate store and proxy
/// settings, redirects followed (GitHub serves release files from another host).
fn https_get(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !url.get(..8).is_some_and(|s| s.eq_ignore_ascii_case("https://")) {
        return Err("https 주소가 아닙니다".into());
    }
    let req = crate::http::Request { method: "GET", url, headers: &[], body: None, receive_timeout_ms: 60_000 };
    let (status, body) = crate::http::fetch(&req, limit).map_err(|e| format!("{url} 에서 받을 수 없습니다: {e}"))?;
    if status != 200 {
        return Err(format!("{url} 에서 받을 수 없습니다(HTTP {status})"));
    }
    Ok(body)
}

/// Windows errors meaning the share refused this account (it is not offline).
/// Windows logs in to a share with the user's own Windows account first and
/// blocks guest logins by default, so a share open to guests still says
/// "the password is incorrect" (86) or "logon failure" (1326).
const AUTH_ERRORS: [i32; 6] = [5, 86, 1244, 1272, 1326, 2202];

enum ReadFail {
    /// The share refused the account; the OS message.
    Auth(String),
    Other(String),
}

/// One published file, from the folder or the web.
fn fetch(src: &Source, name: &str, limit: usize) -> Result<Vec<u8>, ReadFail> {
    match src {
        Source::Folder(dir) => {
            let path = dir.join(name);
            std::fs::read(&path).map_err(|e| match e.raw_os_error() {
                Some(code) if AUTH_ERRORS.contains(&code) => ReadFail::Auth(e.to_string()),
                _ => ReadFail::Other(format!("{} 을(를) 읽을 수 없습니다: {e}", path.display())),
            })
        }
        Source::Web(base) => https_get(&format!("{base}{name}"), limit).map_err(ReadFail::Other),
    }
}

fn read_manifest(src: &Source) -> Result<Manifest, ReadFail> {
    let bytes = fetch(src, "latest.json", 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|_| ReadFail::Other("업데이트 정보가 올바르지 않습니다(UTF-8 아님)".into()))?;
    let mut m: Manifest = serde_json::from_str(&text).map_err(|e| ReadFail::Other(format!("업데이트 정보가 올바르지 않습니다: {e}")))?;
    verify(&mut m).map_err(ReadFail::Other)?;
    Ok(m)
}

/// `\\server\share` of a UNC folder path.
fn share_root(dir: &Path) -> Option<String> {
    let s = dir.to_str()?;
    let rest = s.strip_prefix(r"\\").or_else(|| s.strip_prefix("//"))?;
    let mut parts = rest.split(['\\', '/']).filter(|p| !p.is_empty());
    let (server, share) = (parts.next()?, parts.next()?);
    // \\?\ and \\.\ are local device paths, not shares.
    (!server.starts_with('?') && !server.starts_with('.')).then(|| format!(r"\\{server}\{share}"))
}

/// Log in to the share with an explicit account for this Windows session
/// (not remembered across sign-outs; the vault keeps the password).
fn connect_share(root: &str, user: &str, password: &str) -> Result<(), i32> {
    use windows_sys::Win32::NetworkManagement::WNet::{CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK, WNetAddConnection2W};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (mut remote, pass, name) = (wide(root), wide(password), wide(user));
    let res = NETRESOURCEW { dwType: RESOURCETYPE_DISK, lpRemoteName: remote.as_mut_ptr(), ..Default::default() };
    // SAFETY: NUL-terminated buffers that outlive the call.
    let status = unsafe { WNetAddConnection2W(&res, pass.as_ptr(), name.as_ptr(), CONNECT_TEMPORARY) };
    if status == 0 { Ok(()) } else { Err(status as i32) }
}

/// Read the manifest; when the share refuses the Windows account and a vault
/// credential is set for the update folder, log in with it and read again.
/// Errors starting with `UPDATE_AUTH::<share>::` are for the app's guide.
fn open_manifest(app: &AppHandle, src: &Source, credential: Option<&str>) -> Result<Manifest, String> {
    let detail = match read_manifest(src) {
        Ok(m) => return Ok(m),
        Err(ReadFail::Other(e)) => return Err(e),
        Err(ReadFail::Auth(e)) => e,
    };
    let root = match src {
        Source::Folder(dir) => share_root(dir),
        Source::Web(_) => None,
    }
    .ok_or_else(|| format!("업데이트 폴더에 접근할 수 없습니다: {detail}"))?;
    let Some(id) = credential.filter(|id| !id.is_empty()) else {
        return Err(format!("UPDATE_AUTH::{root}::{detail}"));
    };
    let c = crate::vault::resolve(app, id)?;
    let Some(password) = c.password else {
        return Err("업데이트 폴더 계정에는 비밀번호 방식 자격 증명을 고르세요".into());
    };
    connect_share(&root, &c.username, &password).map_err(|code| match code {
        86 | 1326 | 2202 => format!("UPDATE_AUTH::{root}::선택한 NAS 계정({})의 이름이나 비밀번호가 맞지 않습니다", c.username),
        // Windows allows one account per server and user session.
        1219 => format!("UPDATE_AUTH::{root}::이 PC가 이미 다른 계정으로 {root} 에 연결되어 있습니다. 탐색기에서 연결을 끊거나 로그아웃한 뒤 다시 시도하세요"),
        _ => format!("{root} 에 연결할 수 없습니다: {}", std::io::Error::from_raw_os_error(code)),
    })?;
    read_manifest(src).map_err(|f| match f {
        ReadFail::Auth(e) => format!("UPDATE_AUTH::{root}::{e}"),
        ReadFail::Other(e) => e,
    })
}

/// Open the update folder in Explorer: Windows then asks for the share's
/// account itself and can remember it.
#[tauri::command]
pub fn update_open_folder(source: String) -> Result<(), String> {
    // Explorer opens a web address in the default browser.
    let target: std::ffi::OsString = match source_of(&source)? {
        Source::Folder(dir) => dir.into_os_string(),
        Source::Web(base) => base.into(),
    };
    std::process::Command::new(EXPLORER).arg(&target).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// How this copy was installed: per-user NSIS (no admin) or per-machine MSI.
fn installed_by_msi(exe: &Path) -> bool {
    let program_files = [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")];
    program_files.iter().flatten().any(|pf| exe.starts_with(pf))
}

#[tauri::command]
pub async fn update_check(app: AppHandle, source: String, credential_id: Option<String>) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let src = released_only(&app, source_of(&source)?)?;
    // A network share or the web can be slow to answer; keep it off the async runtime.
    let handle = app.clone();
    let m = tauri::async_runtime::spawn_blocking(move || open_manifest(&handle, &src, credential_id.as_deref())).await.map_err(|e| e.to_string())??;
    let available = newer(&m.version, &current).then(|| m.version.clone());
    Ok(UpdateInfo { current, available, notes: m.notes, notes_i18n: m.notes_i18n })
}

/// Removes the installers of earlier updates (one folder per version under
/// `downloads`): each is a full installer, and nothing needs it once that
/// update ran. Done before a new download, the only time the app writes
/// there; a folder still in use (an installer running) simply stays.
fn remove_other_versions(downloads: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(downloads) else { return };
    for entry in entries.flatten() {
        if entry.file_name() != keep && entry.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Copy the verified installer locally, start it after this app exits, and
/// relaunch the app when it finishes.
#[tauri::command]
pub async fn update_install(app: AppHandle, source: String, credential_id: Option<String>) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let src = released_only(&app, source_of(&source)?)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let msi = installed_by_msi(&exe);
    let handle = app.clone();
    let script = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let m = open_manifest(&handle, &src, credential_id.as_deref())?;
        if !newer(&m.version, &current) {
            return Err("이미 최신 버전입니다".into());
        }
        let (name, sha) = if msi && !m.msi.is_empty() { (m.msi.as_str(), m.msi_sha256.as_str()) } else { (m.nsis.as_str(), m.nsis_sha256.as_str()) };
        let name = plain_name(name)?;
        let data = fetch(&src, name, WEB_LIMIT).map_err(|f| match f {
            ReadFail::Auth(e) | ReadFail::Other(e) => format!("설치 파일을 읽을 수 없습니다: {e}"),
        })?;
        if !sha.eq_ignore_ascii_case(&sha256_hex(&data)) {
            return Err("설치 파일이 업데이트 정보와 다릅니다(SHA-256 불일치). 다시 게시된 뒤에 시도하세요".into());
        }
        let downloads = std::env::temp_dir().join("BananaConn").join("update");
        remove_other_versions(&downloads, &m.version);
        let work = downloads.join(&m.version);
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let installer = work.join(name);
        std::fs::write(&installer, &data).map_err(|e| format!("설치 파일을 저장할 수 없습니다: {e}"))?;
        // PowerShell single-quoted strings: double any quote in the paths.
        let q = |p: &Path| p.display().to_string().replace('\'', "''");
        let run = if name.ends_with(".msi") {
            format!("Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', '\"{}\"', '/passive', '/norestart') -Wait", q(&installer))
        } else {
            format!("Start-Process -FilePath '{}' -ArgumentList '/S' -Wait", q(&installer))
        };
        let ps = format!(
            "$ErrorActionPreference = 'Continue'\r\n\
             Start-Sleep -Milliseconds 1500\r\n\
             {run}\r\n\
             Start-Process -FilePath '{}'\r\n",
            q(&exe)
        );
        let script = work.join("update.ps1");
        // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code
        // page, which garbles non-ASCII paths (a Korean user name in %TEMP%).
        std::fs::write(&script, format!("\u{feff}{ps}")).map_err(|e| e.to_string())?;
        Ok(script)
    })
    .await
    .map_err(|e| e.to_string())??;

    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
        .arg(&script)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("업데이트를 시작할 수 없습니다: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earlier_update_downloads_are_removed() {
        let downloads = std::env::temp_dir().join(format!("bx-update-dl-{}", std::process::id()));
        for v in ["0.6.0", "0.7.0", "0.7.1"] {
            std::fs::create_dir_all(downloads.join(v)).unwrap();
            std::fs::write(downloads.join(v).join("setup.exe"), b"x").unwrap();
        }
        std::fs::write(downloads.join("note.txt"), b"not a version folder").unwrap();
        remove_other_versions(&downloads, "0.7.1");
        assert!(!downloads.join("0.6.0").exists() && !downloads.join("0.7.0").exists());
        assert!(downloads.join("0.7.1").join("setup.exe").exists() && downloads.join("note.txt").exists());
        let _ = std::fs::remove_dir_all(&downloads);
        remove_other_versions(&downloads, "0.7.1");
    }

    fn signed(key: &ring::signature::Ed25519KeyPair, mut m: Manifest) -> Manifest {
        m.signature = base64::engine::general_purpose::STANDARD.encode(key.sign(signed_message(&m).as_bytes()).as_ref());
        if !m.notes_i18n.is_empty() {
            m.signature_v2 = Some(base64::engine::general_purpose::STANDARD.encode(key.sign(signed_message_v2(&m).as_bytes()).as_ref()));
        }
        m
    }

    /// Signed on the build machine by scripts/publish-update.mjs with the real
    /// key: the script's message format and this file's must stay identical.
    #[test]
    fn accepts_a_manifest_signed_by_the_publish_script() {
        let json = r#"{"version":"0.7.5","nsis":"BananaXterm_0.7.5_x64-setup.exe","nsisSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","msi":"BananaXterm_0.7.5_x64_en-US.msi","msiSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","notes":"- RDP 수정\n- 로그","signature":"KB5yr6+lGTdlLhpF65u3Q2zaPym8y0WBWvXcsP9aClcQSI10McUsqPL6bImmigIR1paX+A5XsOkcNj3TlFB8AQ=="}"#;
        let mut m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(verify(&mut m), Ok(()));
        let mut changed = m.clone();
        changed.notes.push('!');
        assert!(verify(&mut changed).is_err());
    }

    /// signatureV2 as scripts/publish-update.mjs makes it (a throwaway key):
    /// the translations' JSON must be byte-identical on both sides.
    #[test]
    fn accepts_translated_notes_signed_by_the_publish_script() {
        let public = base64::engine::general_purpose::STANDARD.decode("DNhIRmVTG3+NroKmfMgMNdjLKo0GYeRLUvZb/rytJoI=").unwrap();
        let json = r#"{"version":"0.7.25","nsis":"BananaXterm_0.7.25_x64-setup.exe","nsisSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","msi":"BananaXterm_0.7.25_x64_en-US.msi","msiSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","notes":"- 스니펫 추가\n- \"따옴표\" 와  역슬래시","signature":"SBMz/lX2AJB1EQNkDSUGIdBFLZU9e7NQZKAl8QxOgx1XiE3LVskhJybZSfJDma5Z7HXZeZTnQn67oEVLpPxXDw==","notesI18n":{"en":"- Snippets added\n- \"quotes\" and  backslash","ja":"- スニペット追加","zh-CN":"- 新增代码片段\n- \"引号\""},"signatureV2":"JWMKqbNke/AsgfDCYu5oKAYC+Kp3BtET8OymRozLqwU4uVqVyG43Sbf1yTzOpmXkHoUeX9pUjg5sAj61T3F0AA=="}"#;
        let mut m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(verify_with(&mut m, &public), Ok(()));
        assert_eq!(m.notes_i18n.len(), 3);
        assert_eq!(m.notes_i18n["ja"], "- スニペット追加");
    }

    #[test]
    fn share_root_of_update_folders() {
        use std::path::Path;
        assert_eq!(share_root(Path::new(r"\\nas01\bananaxterm\updates")).as_deref(), Some(r"\\nas01\bananaxterm"));
        assert_eq!(share_root(Path::new(r"\\nas\share")).as_deref(), Some(r"\\nas\share"));
        assert_eq!(share_root(Path::new("//nas/share/x")).as_deref(), Some(r"\\nas\share"));
        assert_eq!(share_root(Path::new(r"D:\updates")), None);
        assert_eq!(share_root(Path::new(r"\\nas")), None);
        assert_eq!(share_root(Path::new(r"\\?\C:\updates")), None);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.7.10", "0.7.9"));
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("0.7.4", "0.7.4"));
        assert!(!newer("0.7.3", "0.7.4"));
        assert!(!newer("0.8.0-beta", "0.7.4"));
    }

    #[test]
    fn only_signed_manifests_with_plain_names_pass() {
        use ring::signature::KeyPair as _;
        let rng = ring::rand::SystemRandom::new();
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap().as_ref()).unwrap();
        let public = key.public_key().as_ref().to_vec();
        let m = signed(
            &key,
            Manifest {
                version: "0.7.5".into(),
                nsis: "BananaConn_0.7.5_x64-setup.exe".into(),
                nsis_sha256: sha256_hex(b"installer"),
                msi: String::new(),
                msi_sha256: String::new(),
                notes: "RDP 수정".into(),
                notes_i18n: BTreeMap::new(),
                signature: String::new(),
                signature_v2: None,
            },
        );
        assert_eq!(verify_with(&mut m.clone(), &public), Ok(()));
        // Any change after signing is rejected.
        let mut tampered = m.clone();
        tampered.nsis_sha256 = sha256_hex(b"evil");
        assert!(verify_with(&mut tampered, &public).is_err());
        let mut tampered = m.clone();
        tampered.version = "9.9.9".into();
        assert!(verify_with(&mut tampered, &public).is_err());
        // The build machine's real key does not accept a manifest signed by another key.
        assert!(verify(&mut m.clone()).is_err());

        // Translated notes: covered by signature_v2; altered or unsigned ones never show.
        let mut with = m.clone();
        with.notes_i18n = BTreeMap::from([("en".to_string(), "RDP fix".to_string()), ("ja".to_string(), "RDP の修正".to_string())]);
        let with = signed(&key, with);
        let mut ok = with.clone();
        assert_eq!(verify_with(&mut ok, &public), Ok(()));
        assert_eq!(ok.notes_i18n.get("ja").map(String::as_str), Some("RDP の修正"));
        let mut tampered = with.clone();
        tampered.notes_i18n.insert("en".into(), "Install me".into());
        assert!(verify_with(&mut tampered, &public).is_err());
        let mut unsigned = with.clone();
        unsigned.signature_v2 = None;
        assert_eq!(verify_with(&mut unsigned, &public), Ok(()));
        assert!(unsigned.notes_i18n.is_empty(), "translations without signature_v2 are dropped");

        assert!(plain_name("BananaConn_0.7.5_x64-setup.exe").is_ok());
        for bad in ["..\\evil.exe", "C:evil.exe", "sub/evil.exe", "evil.bat", ""] {
            assert!(plain_name(bad).is_err(), "{bad}");
        }
    }
}

#[cfg(test)]
mod web_tests {
    /// Needs internet access: a GitHub release download answers with a
    /// redirect to another host, which WinHTTP follows.
    #[test]
    #[ignore]
    fn fetches_a_github_release_file_through_its_redirect() {
        let body = super::https_get("https://github.com/microsoft/fluentui-emoji/archive/refs/heads/main.zip", 1).err();
        // Larger than the 1-byte limit: the request itself went through.
        assert!(body.as_deref().is_some_and(|e| e.contains("너무 큽니다")), "{body:?}");
        assert!(super::https_get("https://github.com/this-owner-does-not-exist-bc/x/releases/latest/download/latest.json", 1024).unwrap_err().contains("HTTP 404"));
    }

    /// Needs internet access: the published release reads and verifies the way the app does it.
    #[test]
    #[ignore]
    fn the_published_release_verifies() {
        let src = super::source_of("https://github.com/NijG/bananaconn/releases/latest/download/").unwrap();
        let m = match super::read_manifest(&src) {
            Ok(m) => m,
            Err(super::ReadFail::Auth(e) | super::ReadFail::Other(e)) => panic!("{e}"),
        };
        assert!(!m.version.is_empty() && !m.notes_i18n.is_empty(), "{m:?}");
    }
}
