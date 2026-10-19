# Local patch of ironrdp-pdu 0.9.0

Upstream source from crates.io (MIT OR Apache-2.0, see LICENSE-MIT and
LICENSE-APACHE), with one change in `src/gcc/core_data/client.rs`:

1. `KeyboardType::Korean = 8`: Korean 103/106-key keyboards (Windows
   `GetKeyboardType` returns 8). The server's Korean layout needs it to map
   right Alt / right Ctrl to 한/영 / 한자, as mstsc does.

Drop this patch once an upstream release has the value.
