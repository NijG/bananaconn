// The DNS tool's record lookup: a name's A, AAAA, MX, TXT, CNAME, NS, SOA or
// SRV records, as Windows' own resolver (DnsQuery_W) answers them, the way
// nslookup -type=… would show them. The plain address lookup (A · AAAA
// without TTLs) and names of addresses (PTR) stay with net_dns; A and AAAA
// here are for the every-kind lookup. A query reads; nothing is changed.

use serde::Serialize;

/// One record of the answer (a CNAME on the way to the one asked for too).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    /// "A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "SRV" (or the number of another).
    pub kind: String,
    pub name: String,
    pub ttl: u32,
    /// The record's data as nslookup shows it: "10 mail.example.com" (MX),
    /// the text (TXT, its strings joined), "0 5 5060 sip.example.com" (SRV:
    /// priority weight port target), "ns1. hostmaster. 2024010101 7200 3600
    /// 1209600 300" (SOA: primary, mailbox, serial, refresh, retry, expire,
    /// minimum).
    pub data: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecords {
    pub records: Vec<DnsRecord>,
    pub ms: u64,
}

/// The record types this looks up, by the name the dialog sends.
fn type_of(kind: &str) -> Option<u16> {
    use windows_sys::Win32::NetworkManagement::Dns::{DNS_TYPE_A, DNS_TYPE_AAAA, DNS_TYPE_CNAME, DNS_TYPE_MX, DNS_TYPE_NS, DNS_TYPE_SOA, DNS_TYPE_SRV, DNS_TYPE_TEXT};
    Some(match kind {
        // With their TTLs, for the dialog's every-kind lookup.
        "A" => DNS_TYPE_A,
        "AAAA" => DNS_TYPE_AAAA,
        "MX" => DNS_TYPE_MX,
        "TXT" => DNS_TYPE_TEXT,
        "CNAME" => DNS_TYPE_CNAME,
        "NS" => DNS_TYPE_NS,
        "SOA" => DNS_TYPE_SOA,
        "SRV" => DNS_TYPE_SRV,
        _ => return None,
    })
}

fn name_of_type(t: u16) -> String {
    match t {
        15 => "MX".into(),
        16 => "TXT".into(),
        5 => "CNAME".into(),
        2 => "NS".into(),
        6 => "SOA".into(),
        33 => "SRV".into(),
        1 => "A".into(),
        28 => "AAAA".into(),
        other => format!("TYPE{other}"),
    }
}

/// A NUL-terminated UTF-16 string from the resolver ("" for a null pointer).
///
/// # Safety
/// `p` is null or points to a NUL-terminated UTF-16 string.
unsafe fn wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while unsafe { *p.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
}

fn lookup(name: &str, kind: u16) -> Result<Vec<DnsRecord>, String> {
    use windows_sys::Win32::Foundation::DNS_ERROR_RCODE_NAME_ERROR;
    use windows_sys::Win32::NetworkManagement::Dns::{DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA, DNS_RECORDW};
    const DNS_INFO_NO_RECORDS: u32 = 9501;
    let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut first: *mut DNS_RECORDA = std::ptr::null_mut();
    let status = unsafe { DnsQuery_W(wide_name.as_ptr(), kind, DNS_QUERY_STANDARD, std::ptr::null_mut(), &mut first, std::ptr::null_mut()) };
    if status == DNS_ERROR_RCODE_NAME_ERROR {
        return Err(format!("{name} 이름이 DNS에 없습니다"));
    }
    if status == DNS_INFO_NO_RECORDS {
        return Ok(Vec::new());
    }
    if status != 0 {
        return Err(format!("{name} 조회에 실패했습니다 (오류 {status})"));
    }
    let mut out = Vec::new();
    // DnsQuery_W fills DNS_RECORDW (its declared out type is the ANSI one).
    let mut rec = first as *const DNS_RECORDW;
    while !rec.is_null() {
        let r = unsafe { &*rec };
        let data = unsafe {
            match r.wType {
                15 => format!("{} {}", r.Data.MX.wPreference, wide(r.Data.MX.pNameExchange)),
                16 => {
                    // The strings follow the record (a variable-length array
                    // declared with one element): read through the record's own
                    // pointer, not through a reference to that one element.
                    let count = r.Data.TXT.dwStringCount as usize;
                    let first = std::ptr::addr_of!((*rec).Data.TXT.pStringArray) as *const windows_sys::core::PWSTR;
                    let parts = std::slice::from_raw_parts(first, count);
                    // The domain owner's text: what would act on the screen or
                    // turn the text around it (a bidi override in an SPF
                    // record) shown as a mark. A NUL in a string ends it: DnsQuery_W
                    // hands each one over NUL-terminated.
                    crate::servertext::shown(&parts.iter().map(|p| wide(*p)).collect::<Vec<_>>().join(""))
                }
                5 | 2 => wide(r.Data.PTR.pNameHost),
                6 => {
                    let s = &r.Data.SOA;
                    format!(
                        "{} {} {} {} {} {} {}",
                        wide(s.pNamePrimaryServer),
                        wide(s.pNameAdministrator),
                        s.dwSerialNo,
                        s.dwRefresh,
                        s.dwRetry,
                        s.dwExpire,
                        s.dwDefaultTtl
                    )
                }
                33 => {
                    let s = &r.Data.SRV;
                    format!("{} {} {} {}", s.wPriority, s.wWeight, s.wPort, wide(s.pNameTarget))
                }
                1 => std::net::Ipv4Addr::from(u32::from_be(r.Data.A.IpAddress)).to_string(),
                28 => std::net::Ipv6Addr::from(r.Data.AAAA.Ip6Address.IP6Byte).to_string(),
                _ => String::new(),
            }
        };
        // The answer section only (not the additional records a server adds).
        let section = unsafe { r.Flags.DW } & 0x3;
        if section == 1 {
            out.push(DnsRecord { kind: name_of_type(r.wType), name: unsafe { wide(r.pName) }, ttl: r.dwTtl, data });
        }
        rec = r.pNext;
    }
    unsafe { DnsFree(first as *const core::ffi::c_void, DnsFreeRecordList) };
    Ok(out)
}

#[tauri::command]
pub async fn net_dns_records(host: String, kind: String) -> Result<DnsRecords, String> {
    // As typed, a final dot too: "com." is the top-level name (Windows refuses
    // a bare "com"), and a dot also keeps this PC's DNS suffix from being
    // added to a name that does not exist. The root (".") is not asked:
    // DnsQuery_W refuses it (error 13).
    let name = host.trim().to_string();
    let labels = name.strip_suffix('.').unwrap_or(&name);
    let valid = !labels.is_empty() && labels.len() <= 253 && !labels.split('.').any(str::is_empty) && labels.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valid {
        return Err("호스트 이름이 올바르지 않습니다".into());
    }
    let t = type_of(&kind).ok_or_else(|| format!("지원하지 않는 레코드 종류입니다: {kind}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let records = lookup(&name, t)?;
        Ok(DnsRecords { records, ms: started.elapsed().as_millis() as u64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_types_offered_are_looked_up() {
        assert_eq!(type_of("MX"), Some(15));
        assert_eq!(type_of("TXT"), Some(16));
        assert_eq!(type_of("SRV"), Some(33));
        assert_eq!(type_of("A"), Some(1));
        assert_eq!(type_of("AAAA"), Some(28));
        assert_eq!(type_of("PTR"), None);
        assert_eq!(type_of("ANY"), None);
        assert_eq!(name_of_type(6), "SOA");
        assert_eq!(name_of_type(99), "TYPE99");
    }

    #[test]
    fn a_bad_name_is_refused_before_any_query() {
        let r = tauri::async_runtime::block_on(net_dns_records("a b.example".into(), "MX".into()));
        assert_eq!(r.err().as_deref(), Some("호스트 이름이 올바르지 않습니다"));
        for bad in ["", ".", "..", "a..b", "example.com..", ".example.com"] {
            let r = tauri::async_runtime::block_on(net_dns_records(bad.into(), "MX".into()));
            assert_eq!(r.err().as_deref(), Some("호스트 이름이 올바르지 않습니다"), "{bad:?}");
        }
        let r = tauri::async_runtime::block_on(net_dns_records("example.com".into(), "ANY".into()));
        assert!(r.err().unwrap().starts_with("지원하지 않는 레코드 종류입니다"));
    }

    /// Real lookups through this PC's resolver: needs the internet, so not run by default.
    #[test]
    #[ignore]
    fn records_are_read_from_the_resolver() {
        let mx = tauri::async_runtime::block_on(net_dns_records("gmail.com".into(), "MX".into())).unwrap();
        assert!(mx.records.iter().any(|r| r.kind == "MX" && r.data.contains("google.com")), "{:?}", mx.records);
        let txt = tauri::async_runtime::block_on(net_dns_records("google.com".into(), "TXT".into())).unwrap();
        assert!(txt.records.iter().any(|r| r.kind == "TXT" && r.data.starts_with("v=spf1")), "{:?}", txt.records);
        let a = tauri::async_runtime::block_on(net_dns_records("example.com".into(), "A".into())).unwrap();
        assert!(a.records.iter().any(|r| r.kind == "A" && r.data.parse::<std::net::Ipv4Addr>().is_ok()), "{:?}", a.records);
        let aaaa = tauri::async_runtime::block_on(net_dns_records("example.com".into(), "AAAA".into())).unwrap();
        assert!(aaaa.records.iter().any(|r| r.kind == "AAAA" && r.data.parse::<std::net::Ipv6Addr>().is_ok()), "{:?}", aaaa.records);
        let soa = tauri::async_runtime::block_on(net_dns_records("example.com".into(), "SOA".into())).unwrap();
        assert!(soa.records.iter().any(|r| r.kind == "SOA" && r.data.split(' ').count() == 7), "{:?}", soa.records);
        let srv = tauri::async_runtime::block_on(net_dns_records("_xmpp-server._tcp.jabber.org".into(), "SRV".into())).unwrap();
        assert!(srv.records.iter().all(|r| r.kind != "SRV" || r.data.split(' ').count() == 4), "{:?}", srv.records);
        // A top-level name with its final dot (a bare "com" Windows refuses).
        let com = tauri::async_runtime::block_on(net_dns_records("com.".into(), "NS".into())).unwrap();
        assert!(com.records.iter().any(|r| r.kind == "NS"), "{:?}", com.records);
        let none = tauri::async_runtime::block_on(net_dns_records("no-such-name-bananaconn-test.example".into(), "MX".into()));
        assert!(none.is_err(), "{none:?}");
    }
}
