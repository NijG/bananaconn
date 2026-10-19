# Local patch of suppaftp 6.3.0

Upstream source from crates.io, with these changes in `src/sync_ftp/mod.rs`:

1. Numbers parsed from server replies (PASV, EPSV, SIZE, MDTM) return
   `FtpError::BadResponse` instead of `unwrap()`-panicking on values that do
   not fit (e.g. `227 (256,0,0,1,4,1)`).
2. `read_line` reports a closed connection (0 bytes read) as
   `FtpError::ConnectionError`; before, a reply cut off mid-way made the
   multi-line reply loop spin forever at 100% CPU.
3. `local_addr()` failures in active mode are errors, not panics.
4. Active mode: the accepted data socket is set back to blocking (Windows
   sockets inherit the listener's non-blocking mode, so transfers failed with
   `WouldBlock`) and gets 30 s read/write timeouts like passive connections.
5. `connect_secure_implicit_with_stream` starts implicit FTPS on a TCP stream
   the caller connected, so its timeouts also cover the TLS handshake and the
   greeting (`connect_secure_implicit` now uses it).

Drop this patch once an upstream release contains equivalent fixes.

## License

suppaftp is licensed MIT OR Apache-2.0 (https://github.com/veeso/suppaftp).
The crates.io package does not ship the license files; this copy is used
under Apache-2.0, whose text is in `LICENSE-APACHE`. The changes above are
the modifications made to the original files.
