// A COM port opened for overlapped I/O. A port opened for synchronous I/O
// (the serialport crate) runs its reads and writes one after another, so the
// reader has to poll with a short timeout or every keystroke waits for the idle
// read to end. Here a pending read and a write proceed at the same time: the
// reader blocks until bytes arrive (no polling), a keystroke leaves at once,
// and close() cancels whatever is pending.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Devices::Communication::{
    ClearCommBreak, GetCommState, PurgeComm, SetCommBreak, SetCommState, SetCommTimeouts, SetupComm, COMMTIMEOUTS, DCB, EVENPARITY, NOPARITY, ODDPARITY,
    ONESTOPBIT, PURGE_RXCLEAR, PURGE_TXCLEAR, TWOSTOPBITS,
};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::CreateEventW;

/// Line settings, as in the session editor.
pub struct Line {
    pub baud: u32,
    pub data_bits: u8,
    /// "none", "odd" or "even"
    pub parity: String,
    pub stop_bits: u8,
    /// "none", "hardware" (RTS/CTS) or "software" (XON/XOFF)
    pub flow: String,
}

/// A read returns as soon as any byte has arrived, or after this long with
/// none (then the reader just reads again).
const READ_WAIT_MS: u32 = 1000;

pub struct ComPort {
    handle: HANDLE,
    closed: AtomicBool,
}

// SAFETY: the handle is a kernel object usable from any thread; every
// operation passes its own OVERLAPPED and event.
unsafe impl Send for ComPort {}
unsafe impl Sync for ComPort {}

impl ComPort {
    /// Open `name` (e.g. "COM3") with the given line settings.
    pub fn open(name: &str, line: &Line) -> io::Result<Self> {
        let path: Vec<u16> = format!(r"\\.\{name}").encode_utf16().chain(Some(0)).collect();
        // SAFETY: path is NUL-terminated; no security attributes or template.
        let handle = unsafe { CreateFileW(path.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut()) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let port = Self::from_handle(handle);
        port.configure(line)?;
        Ok(port)
    }

    /// Take ownership of a handle opened with FILE_FLAG_OVERLAPPED.
    fn from_handle(handle: HANDLE) -> Self {
        Self { handle, closed: AtomicBool::new(false) }
    }

    fn configure(&self, line: &Line) -> io::Result<()> {
        // SAFETY: valid handle; DCB and COMMTIMEOUTS are plain structs filled in place.
        unsafe {
            check(SetupComm(self.handle, 16 * 1024, 16 * 1024))?;
            let mut dcb: DCB = std::mem::zeroed();
            dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
            check(GetCommState(self.handle, &mut dcb))?;
            dcb.BaudRate = line.baud;
            dcb.ByteSize = line.data_bits.clamp(5, 8);
            dcb.Parity = match line.parity.as_str() {
                "odd" => ODDPARITY,
                "even" => EVENPARITY,
                _ => NOPARITY,
            };
            dcb.StopBits = if line.stop_bits == 2 { TWOSTOPBITS } else { ONESTOPBIT };
            dcb._bitfield = dcb_flags(&line.flow, dcb.Parity != NOPARITY);
            dcb.XonChar = 0x11;
            dcb.XoffChar = 0x13;
            dcb.XonLim = 2048;
            dcb.XoffLim = 512;
            check(SetCommState(self.handle, &dcb))?;
            let timeouts = COMMTIMEOUTS {
                // MAXDWORD / MAXDWORD / n: return at once when bytes are
                // waiting, else when the first one arrives, else after n ms.
                ReadIntervalTimeout: u32::MAX,
                ReadTotalTimeoutMultiplier: u32::MAX,
                ReadTotalTimeoutConstant: READ_WAIT_MS,
                // A write waits for as long as the device holds us (XOFF,
                // CTS); close() cancels it.
                WriteTotalTimeoutMultiplier: 0,
                WriteTotalTimeoutConstant: 0,
            };
            check(SetCommTimeouts(self.handle, &timeouts))?;
            check(PurgeComm(self.handle, PURGE_RXCLEAR | PURGE_TXCLEAR))?;
        }
        Ok(())
    }

    /// Wait for input: the bytes that arrived, or 0 after READ_WAIT_MS with none.
    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        // SAFETY: buf outlives the operation, which is complete (or cancelled
        // and complete) when overlapped() returns.
        self.overlapped(|ov| unsafe { ReadFile(self.handle, buf.as_mut_ptr(), len, std::ptr::null_mut(), ov) })
    }

    /// Write all of `data` (it may wait while the device holds us).
    pub fn write_all(&self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            let len = u32::try_from(data.len()).unwrap_or(u32::MAX);
            // SAFETY: as in read().
            let n = self.overlapped(|ov| unsafe { WriteFile(self.handle, data.as_ptr(), len, std::ptr::null_mut(), ov) })?;
            if n == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            data = &data[n..];
        }
        Ok(())
    }

    pub fn set_break(&self, on: bool) -> io::Result<()> {
        // SAFETY: valid handle.
        check(unsafe { if on { SetCommBreak(self.handle) } else { ClearCommBreak(self.handle) } })
    }

    /// End every pending and later read/write at once (they fail with
    /// "operation aborted"); the reader and writer threads then stop.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // SAFETY: valid handle; null cancels all of its I/O, from any thread.
        unsafe { CancelIoEx(self.handle, std::ptr::null()) };
    }

    /// Start an operation with a fresh OVERLAPPED and wait for it to finish.
    fn overlapped(&self, start: impl FnOnce(*mut OVERLAPPED) -> windows_sys::core::BOOL) -> io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(aborted());
        }
        let event = Event::new()?;
        // SAFETY: zeroed OVERLAPPED is valid; the event is manual-reset.
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event.0;
        let mut done = 0u32;
        if start(&mut ov) == 0 {
            // SAFETY: plain call.
            let err = unsafe { GetLastError() };
            if err != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(err as i32));
            }
        }
        // A close() between the start and here cancels this operation too
        // (CancelIoEx with null), so the wait below always ends.
        if self.closed.load(Ordering::SeqCst) {
            // SAFETY: valid handle and OVERLAPPED of this operation.
            unsafe { CancelIoEx(self.handle, &ov) };
        }
        // SAFETY: waits until the operation is complete; ov and the buffer stay alive until then.
        if unsafe { GetOverlappedResult(self.handle, &ov, &mut done, 1) } == 0 {
            // SAFETY: plain call.
            let err = unsafe { GetLastError() };
            return Err(if err == ERROR_OPERATION_ABORTED { aborted() } else { io::Error::from_raw_os_error(err as i32) });
        }
        Ok(done as usize)
    }
}

impl Drop for ComPort {
    fn drop(&mut self) {
        // SAFETY: owned handle, closed once.
        unsafe { CloseHandle(self.handle) };
    }
}

/// DCB flag bits: binary mode, parity check, and the flow control.
fn dcb_flags(flow: &str, parity: bool) -> u32 {
    const BINARY: u32 = 1;
    const PARITY: u32 = 1 << 1;
    const OUTX_CTS: u32 = 1 << 2;
    const DTR_ENABLE: u32 = 1 << 4;
    const TX_CONTINUE_ON_XOFF: u32 = 1 << 7;
    const OUTX: u32 = 1 << 8;
    const INX: u32 = 1 << 9;
    const RTS_ENABLE: u32 = 1 << 12;
    const RTS_HANDSHAKE: u32 = 2 << 12;
    let mut f = BINARY | DTR_ENABLE | if parity { PARITY } else { 0 };
    match flow {
        "hardware" => f |= OUTX_CTS | RTS_HANDSHAKE,
        "software" => f |= OUTX | INX | TX_CONTINUE_ON_XOFF | RTS_ENABLE,
        _ => f |= RTS_ENABLE,
    }
    f
}

fn aborted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "COM 포트를 닫았습니다")
}

fn check(ok: windows_sys::core::BOOL) -> io::Result<()> {
    if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// A manual-reset event for one operation.
struct Event(HANDLE);

impl Event {
    fn new() -> io::Result<Self> {
        // SAFETY: unnamed manual-reset event, initially not signalled.
        let h = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if h.is_null() { Err(io::Error::last_os_error()) } else { Ok(Self(h)) }
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: owned handle.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};

    /// Both ends of a named pipe, opened for overlapped I/O: the same
    /// ReadFile/WriteFile semantics a COM port has (line settings aside).
    fn pair() -> (ComPort, ComPort) {
        let name: Vec<u16> = format!(r"\\.\pipe\bx-comport-test-{}-{:?}", std::process::id(), std::thread::current().id())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: valid NUL-terminated name; default security.
        unsafe {
            let server = CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, std::ptr::null());
            assert_ne!(server, INVALID_HANDLE_VALUE);
            let client = CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut());
            assert_ne!(client, INVALID_HANDLE_VALUE);
            let server = ComPort::from_handle(server);
            // Already connected (the client opened it): ERROR_PIPE_CONNECTED.
            let _ = server.overlapped(|ov| ConnectNamedPipe(server.handle, ov));
            (server, ComPort::from_handle(client))
        }
    }

    #[test]
    fn a_write_is_not_held_up_by_a_pending_read() {
        let (device, port) = pair();
        let port = Arc::new(port);
        let reader = {
            let port = port.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                port.read(&mut buf).map(|n| buf[..n].to_vec())
            })
        };
        std::thread::sleep(Duration::from_millis(100)); // the read is pending now
        let t = Instant::now();
        port.write_all(b"show version\r").unwrap();
        let took = t.elapsed();
        let mut buf = [0u8; 64];
        let n = device.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"show version\r");
        assert!(took < Duration::from_millis(20), "write waited {took:?} for the pending read");
        device.write_all(b"R1#").unwrap();
        assert_eq!(reader.join().unwrap().unwrap(), b"R1#");
    }

    #[test]
    fn close_ends_a_pending_read_and_later_calls() {
        let (_device, port) = pair();
        let port = Arc::new(port);
        let reader = {
            let port = port.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                let t = Instant::now();
                (port.read(&mut buf), t.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        port.close();
        let (result, took) = reader.join().unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(took < Duration::from_millis(400), "{took:?}");
        assert_eq!(port.write_all(b"x").unwrap_err().kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn a_large_write_arrives_whole() {
        let (device, port) = pair();
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let sender = {
            let data = data.clone();
            std::thread::spawn(move || port.write_all(&data))
        };
        let mut got = Vec::new();
        let mut buf = [0u8; 8192];
        while got.len() < data.len() {
            let n = device.read(&mut buf).unwrap();
            got.extend_from_slice(&buf[..n]);
        }
        sender.join().unwrap().unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn flow_control_bits() {
        assert_eq!(dcb_flags("none", false), 1 | 1 << 4 | 1 << 12);
        assert_eq!(dcb_flags("hardware", true), 1 | 1 << 1 | 1 << 4 | 1 << 2 | 2 << 12);
        assert_eq!(dcb_flags("software", false), 1 | 1 << 4 | 1 << 8 | 1 << 9 | 1 << 7 | 1 << 12);
    }

    #[test]
    fn a_missing_port_is_reported() {
        let err = ComPort::open("COM250", &Line { baud: 9600, data_bits: 8, parity: String::new(), stop_bits: 1, flow: String::new() }).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::NotFound, "{err}");
    }
}
