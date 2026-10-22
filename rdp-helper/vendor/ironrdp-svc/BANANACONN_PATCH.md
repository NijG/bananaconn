# Local patch of ironrdp-svc 0.8.0

Upstream source from crates.io (MIT OR Apache-2.0, see LICENSE-MIT and
LICENSE-APACHE), with one change in `src/lib.rs`:

1. `make_channel_options`: static channels are declared with the options
   mstsc and FreeRDP send — `INITIALIZED | ENCRYPT_RDP` plus the compression
   flag, and for `cliprdr` also `SHOW_PROTOCOL` (0xC0A00000). Upstream sends
   only the compression flag, although ironrdp-cliprdr marks every clipboard
   PDU with `CHANNEL_FLAG_SHOW_PROTOCOL`. A Windows 7 server then never starts
   the clipboard (no Monitor Ready), so nothing can be pasted.

Drop this patch once an upstream release declares channels this way.
