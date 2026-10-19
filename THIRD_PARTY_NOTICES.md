# Third-party notices

BananaConn uses the components below; each keeps its own license. Locally
patched copies are in `src-tauri/vendor/` and `rdp-helper/vendor/` (see the
`BANANACONN_PATCH.md` and license files there).

noVNC (MPL-2.0) is bundled unmodified from npm; its source is at
https://github.com/novnc/noVNC.

The app icon is the project's own BananaConn. logo; see
`src-tauri/icons/NOTICE.md`.

## JavaScript (bundled into the app)

| Package | Version | License | Source |
|---|---|---|---|
| @codemirror/commands | 6.11.1 | MIT | https://code.haverbeke.berlin/codemirror/commands |
| @codemirror/lang-css | 6.3.1 | MIT | https://github.com/codemirror/lang-css |
| @codemirror/lang-html | 6.4.12 | MIT | https://code.haverbeke.berlin/codemirror/lang-html |
| @codemirror/lang-javascript | 6.2.5 | MIT | https://github.com/codemirror/lang-javascript |
| @codemirror/lang-json | 6.0.2 | MIT | https://github.com/codemirror/lang-json |
| @codemirror/lang-markdown | 6.5.2 | MIT | https://code.haverbeke.berlin/codemirror/lang-markdown |
| @codemirror/lang-python | 6.2.1 | MIT | https://github.com/codemirror/lang-python |
| @codemirror/lang-sql | 6.10.0 | MIT | https://github.com/codemirror/lang-sql |
| @codemirror/lang-xml | 6.1.0 | MIT | https://github.com/codemirror/lang-xml |
| @codemirror/lang-yaml | 6.1.3 | MIT | https://github.com/codemirror/lang-yaml |
| @codemirror/language | 6.13.1 | MIT | https://code.haverbeke.berlin/codemirror/language |
| @codemirror/legacy-modes | 6.5.5 | MIT | https://code.haverbeke.berlin/codemirror/legacy-modes |
| @codemirror/search | 6.7.2 | MIT | https://code.haverbeke.berlin/codemirror/search |
| @codemirror/state | 6.7.6 | MIT | https://code.haverbeke.berlin/codemirror/state |
| @codemirror/view | 6.43.14 | MIT | https://code.haverbeke.berlin/codemirror/view |
| @lezer/highlight | 1.2.5 | MIT | https://code.haverbeke.berlin/lezer/highlight |
| @novnc/novnc | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |
| @tauri-apps/api | 2.12.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-clipboard-manager | 2.4.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-dialog | 2.8.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-opener | 2.7.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @xterm/addon-fit | 0.11.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit |
| @xterm/addon-search | 0.16.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-search |
| @xterm/addon-web-links | 0.12.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links |
| @xterm/addon-webgl | 0.19.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl |
| @xterm/xterm | 6.0.0 | MIT | https://github.com/xtermjs/xterm.js |
| codemirror | 6.0.2 | MIT | https://github.com/codemirror/basic-setup |
| lucide | 1.57.0 | ISC | https://github.com/lucide-icons/lucide |

## Rust crates (compiled into the app and the RDP helper)

| Crate | Version | License | Source |
|---|---|---|---|
| addchain | 0.2.1 | MIT OR Apache-2.0 | https://github.com/str4d/addchain |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | https://github.com/oyvindln/adler2 |
| aead | 0.6.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| aes | 0.9.3 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| aes-gcm | 0.11.0-rc.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| aes-gcm | 0.11.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| aes-kw | 0.3.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/key-wraps |
| aho-corasick | 1.1.5 | Unlicense OR MIT | https://github.com/BurntSushi/aho-corasick |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| alloc-stdlib | 0.3.0 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| ambient-authority | 0.0.2 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/ambient-authority |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 | https://github.com/nical/android_system_properties |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | https://github.com/dtolnay/anyhow |
| arboard | 3.6.1 | MIT OR Apache-2.0 | https://github.com/1Password/arboard |
| arc-swap | 1.9.2 | MIT OR Apache-2.0 | https://github.com/vorner/arc-swap |
| argon2 | 0.6.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| asn1-rs | 0.7.2 | MIT OR Apache-2.0 | https://github.com/rusticata/asn1-rs.git |
| asn1-rs-derive | 0.6.0 | MIT OR Apache-2.0 | https://github.com/rusticata/asn1-rs.git |
| asn1-rs-impl | 0.2.0 | MIT/Apache-2.0 | https://github.com/rusticata/asn1-rs.git |
| async-broadcast | 0.7.2 | MIT OR Apache-2.0 | https://github.com/smol-rs/async-broadcast |
| async-channel | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-channel |
| async-dnssd | 0.5.1 | MIT | https://github.com/stbuehler/rust-async-dnssd |
| async-executor | 1.14.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-executor |
| async-io | 2.6.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-io |
| async-lock | 3.4.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-lock |
| async-process | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-process |
| async-recursion | 1.2.0 | MIT OR Apache-2.0 | https://github.com/dcchut/async-recursion |
| async-signal | 0.2.14 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-signal |
| async-task | 4.7.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-task |
| async-trait | 0.1.92 | MIT OR Apache-2.0 | https://github.com/dtolnay/async-trait |
| atk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| atk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| atomic-polyfill | 1.0.3 | MIT OR Apache-2.0 | https://github.com/embassy-rs/atomic-polyfill |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/atomic-waker |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | https://github.com/cuviper/autocfg |
| aws-lc-rs | 1.18.2 | ISC AND (Apache-2.0 OR ISC) | https://github.com/aws/aws-lc-rs |
| aws-lc-sys | 0.46.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) | https://github.com/aws/aws-lc-rs |
| base16ct | 1.0.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| base64 | 0.21.7 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.22.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.23.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| bcrypt-pbkdf | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-set |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-vec |
| bit_field | 0.10.3 | Apache-2.0/MIT | https://github.com/phil-opp/rust-bit-field |
| bitflags | 1.3.2 | MIT/Apache-2.0 | https://github.com/bitflags/bitflags |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | https://github.com/bitflags/bitflags |
| bitvec | 1.1.1 | MIT | https://github.com/bitvecto-rs/bitvec |
| blake2 | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| block-padding | 0.4.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| block2 | 0.6.2 | MIT | https://github.com/madsmtm/objc2 |
| blocking | 1.7.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/blocking |
| blowfish | 0.10.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| brotli | 9.0.0 | BSD-3-Clause AND MIT | https://github.com/dropbox/rust-brotli |
| brotli-decompressor | 6.0.1 | BSD-3-Clause/MIT | https://github.com/dropbox/rust-brotli-decompressor |
| bs58 | 0.5.1 | MIT/Apache-2.0 | https://github.com/Nullus157/bs58-rs |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | https://github.com/fitzgen/bumpalo |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/bytemuck |
| byteorder | 1.5.0 | Unlicense OR MIT | https://github.com/BurntSushi/byteorder |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | https://github.com/image-rs/byteorder-lite |
| bytes | 1.12.1 | MIT | https://github.com/tokio-rs/bytes |
| cairo-rs | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| cairo-sys-rs | 0.18.2 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| camino | 1.2.6 | MIT OR Apache-2.0 | https://github.com/camino-rs/camino |
| cap-primitives | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/cap-std |
| cap-std | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/cap-std |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/cargo |
| cargo_metadata | 0.19.2 | MIT | https://github.com/oli-obk/cargo_metadata |
| cargo_toml | 1.0.1 | Apache-2.0 OR MIT | https://gitlab.com/lib.rs/cargo_toml |
| cbc | 0.2.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| cc | 1.8.0 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| cesu8 | 1.1.0 | Apache-2.0/MIT | https://github.com/emk/cesu8-rs |
| cfb | 0.14.0 | MIT | https://github.com/mdsteele/rust-cfb |
| cfg-expr | 0.15.8 | MIT OR Apache-2.0 | https://github.com/EmbarkStudios/cfg-expr |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/cfg-if |
| cfg_aliases | 0.2.2 | MIT | https://github.com/katharostech/cfg_aliases |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/stream-ciphers |
| chrono | 0.4.45 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| cipher | 0.5.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| clipboard-win | 5.4.1 | BSL-1.0 | https://github.com/DoumanAsh/clipboard-win |
| cmake | 0.1.58 | MIT OR Apache-2.0 | https://github.com/rust-lang/cmake-rs |
| cmov | 0.5.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| combine | 4.6.8 | MIT | https://github.com/Marwes/combine |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/concurrent-queue |
| const-oid | 0.10.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| const-oid | 0.9.6 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/const-oid |
| convert_case | 0.10.0 | MIT | https://github.com/rutrum/convert-case |
| cookie | 0.18.2 | MIT OR Apache-2.0 | https://github.com/SergioBenitez/cookie-rs |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| core-graphics | 0.25.0 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| cpubits | 0.1.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 | https://github.com/srijs/rust-crc32fast |
| critical-section | 1.2.0 | MIT OR Apache-2.0 | https://github.com/rust-embedded/critical-section |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crunchy | 0.2.4 | MIT | https://github.com/eira-fransham/crunchy |
| crypto-bigint | 0.7.5 | Apache-2.0 OR MIT | https://github.com/RustCrypto/crypto-bigint |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| crypto-mac | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| crypto-primes | 0.7.2 | Apache-2.0 OR MIT | https://github.com/entropyxyz/crypto-primes |
| cryptoki | 0.12.1 | Apache-2.0 | https://github.com/parallaxsecond/rust-cryptoki |
| cryptoki-sys | 0.5.0 | Apache-2.0 | https://github.com/parallaxsecond/rust-cryptoki |
| cssparser | 0.37.0 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| cssparser-macros | 0.7.1 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| ctor | 1.0.13 | Apache-2.0 OR MIT | https://github.com/mmastrac/linktime |
| ctr | 0.10.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| ctutils | 0.4.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| curve25519-dalek | 5.0.0 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| curve25519-dalek | 5.0.0-rc.1 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| curve25519-dalek-derive | 0.1.1 | MIT/Apache-2.0 | https://github.com/dalek-cryptography/curve25519-dalek |
| darling | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| darling_core | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| darling_macro | 0.24.1 | MIT | https://github.com/TedDriggs/darling |
| dashmap | 6.2.1 | MIT | https://github.com/xacrimon/dashmap |
| data-encoding | 2.11.1 | MIT | https://github.com/ia0/data-encoding |
| dbus | 0.9.12 | Apache-2.0/MIT | https://github.com/diwic/dbus-rs |
| defmt | 1.1.1 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| defmt-macros | 1.1.1 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| defmt-parser | 1.0.0 | MIT OR Apache-2.0 | https://github.com/knurling-rs/defmt |
| delegate | 0.13.5 | MIT OR Apache-2.0 | https://github.com/kobzol/rust-delegate |
| der | 0.7.10 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/der |
| der | 0.8.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| der-parser | 10.0.0 | MIT OR Apache-2.0 | https://github.com/rusticata/der-parser.git |
| der_derive | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/der/derive |
| deranged | 0.5.9 | MIT OR Apache-2.0 | https://github.com/jhpratt/deranged |
| derive_more | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| derive_more-impl | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| des | 0.9.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| digest | 0.10.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| digest | 0.11.3 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| dirs | 5.0.1 | MIT OR Apache-2.0 | https://github.com/soc/dirs-rs |
| dirs | 7.0.0 | MIT OR Apache-2.0 | https://codeberg.org/dirs/dirs-rs |
| dirs-sys | 0.4.1 | MIT OR Apache-2.0 | https://github.com/dirs-dev/dirs-sys-rs |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | https://github.com/dirs-dev/dirs-sys-rs |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | https://github.com/yaahc/displaydoc |
| dlopen2 | 0.8.2 | MIT | https://github.com/OpenByteDev/dlopen2 |
| dlopen2_derive | 0.4.3 | MIT | https://github.com/OpenByteDev/dlopen2 |
| dom_query | 0.28.0 | MIT | https://github.com/niklak/dom_query |
| downcast-rs | 1.2.1 | MIT/Apache-2.0 | https://github.com/marcianx/downcast-rs |
| dpi | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | https://github.com/dtolnay/dtoa |
| dtoa-short | 0.3.5 | MPL-2.0 | https://github.com/upsuper/dtoa-short |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | https://gitlab.com/kornelski/dunce |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | https://github.com/dtolnay/dyn-clone |
| ecdsa | 0.17.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| ecdsa | 0.17.0-rc.22 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| ed25519 | 3.0.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| ed25519-dalek | 3.0.0 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| ed25519-dalek | 3.0.0-rc.1 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| elliptic-curve | 0.14.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| embed-resource | 3.0.12 | MIT | https://github.com/nabijaczleweli/rust-embed-resource |
| embed_plist | 1.2.2 | MIT OR Apache-2.0 | https://github.com/nvzqz/embed-plist-rs |
| endi | 1.1.1 | MIT | https://github.com/zeenix/endi |
| enum_dispatch | 0.3.13 | MIT OR Apache-2.0 | https://gitlab.com/antonok/enum_dispatch |
| enumflags2 | 0.7.12 | MIT OR Apache-2.0 | https://github.com/meithecatte/enumflags2 |
| enumflags2_derive | 0.7.12 | MIT OR Apache-2.0 | https://github.com/meithecatte/enumflags2 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| erased-serde | 0.3.31 | MIT OR Apache-2.0 | https://github.com/dtolnay/erased-serde |
| erased-serde | 0.4.10 | MIT OR Apache-2.0 | https://github.com/dtolnay/erased-serde |
| errno | 0.3.14 | MIT OR Apache-2.0 | https://github.com/lambda-fairy/rust-errno |
| error-code | 3.4.0 | BSL-1.0 | https://github.com/DoumanAsh/error-code |
| event-listener | 5.4.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener-strategy |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| fax | 0.2.7 | MIT | https://github.com/pdf-rs/fax |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | https://github.com/image-rs/fdeflate |
| ff | 0.14.0 | MIT/Apache-2.0 | https://github.com/zkcrypto/ff |
| fiat-crypto | 0.3.0 | MIT OR Apache-2.0 OR BSD-1-Clause | https://github.com/mit-plv/fiat-crypto |
| field-offset | 0.3.6 | MIT OR Apache-2.0 | https://github.com/Diggsey/rust-field-offset |
| filedescriptor | 0.8.3 | MIT | https://github.com/wezterm/wezterm |
| find-msvc-tools | 0.1.14 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| fixedbitset | 0.5.7 | MIT OR Apache-2.0 | https://github.com/petgraph/fixedbitset |
| flagset | 0.4.7 | Apache-2.0 | https://github.com/enarx/flagset |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | https://github.com/rust-lang/flate2-rs |
| fnv | 1.0.7 | Apache-2.0 / MIT | https://github.com/servo/rust-fnv |
| foldhash | 0.1.5 | Zlib | https://github.com/orlp/foldhash |
| foldhash | 0.2.0 | Zlib | https://github.com/orlp/foldhash |
| foreign-types | 0.3.2 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| foreign-types | 0.5.0 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| foreign-types-macros | 0.2.4 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| foreign-types-shared | 0.1.1 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| foreign-types-shared | 0.3.1 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| fs-set-times | 0.20.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/fs-set-times |
| fs_extra | 1.3.0 | MIT | https://github.com/webdesus/fs_extra |
| funty | 2.0.0 | MIT | https://github.com/myrrlyn/funty |
| futures | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-io | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/futures-lite |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| gdk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdk-pixbuf | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gdk-pixbuf-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gdk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkwayland-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkx11 | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkx11-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| generic-array | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| generic-array | 1.4.5 | MIT | https://github.com/fizyk20/generic-array.git |
| gethostname | 1.1.0 | Apache-2.0 | https://codeberg.org/swsnr/gethostname.rs.git |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| ghash | 0.6.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| gio | 0.18.4 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gio-sys | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib-macros | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib-sys | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glob | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-lang/glob |
| gloo-timers | 0.4.0 | MIT OR Apache-2.0 | https://github.com/rustwasm/gloo/tree/master/crates/timers |
| gobject-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| group | 0.14.0 | MIT/Apache-2.0 | https://github.com/zkcrypto/group |
| gtk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gtk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gtk3-macros | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| half | 2.7.1 | MIT OR Apache-2.0 | https://github.com/VoidStarKat/half-rs |
| hash32 | 0.2.1 | MIT OR Apache-2.0 | https://github.com/japaric/hash32 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.14.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.15.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| heapless | 0.7.17 | MIT OR Apache-2.0 | https://github.com/japaric/heapless |
| heck | 0.4.1 | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| heck | 0.5.0 | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| hermit-abi | 0.5.3 | MIT OR Apache-2.0 | https://github.com/hermit-os/hermit-rs |
| hex | 0.4.3 | MIT OR Apache-2.0 | https://github.com/KokaKiwi/rust-hex |
| hex-literal | 1.1.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| hkdf | 0.13.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/KDFs/ |
| hmac | 0.13.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| http | 1.5.0 | MIT OR Apache-2.0 | https://github.com/hyperium/http |
| http-body | 1.1.0 | MIT | https://github.com/hyperium/http-body |
| http-body-util | 0.1.5 | MIT | https://github.com/hyperium/http-body |
| httparse | 1.10.1 | MIT OR Apache-2.0 | https://github.com/seanmonstar/httparse |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hybrid-array |
| hyper | 1.12.0 | MIT | https://github.com/hyperium/hyper |
| hyper-util | 0.1.21 | MIT | https://github.com/hyperium/hyper-util |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| ico | 0.5.0 | MIT | https://github.com/mdsteele/rust-ico |
| icu_collections | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locale_core | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties_data | 2.3.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider | 2.3.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| ident_case | 1.0.1 | MIT/Apache-2.0 | https://github.com/TedDriggs/ident_case |
| idna | 1.1.0 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | https://github.com/hsivonen/idna_adapter |
| image | 0.25.10 | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | https://github.com/bluss/indexmap |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| infer | 0.22.0 | MIT | https://github.com/bojand/infer |
| inout | 0.2.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| io-extras | 0.19.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/io-extras |
| io-lifetimes | 2.0.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/io-lifetimes |
| io-lifetimes | 3.0.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/io-lifetimes |
| ioctl-rs | 0.1.6 | MIT | https://github.com/dcuddeback/ioctl-rs |
| ipnet | 2.12.2 | MIT OR Apache-2.0 | https://github.com/krisprice/ipnet |
| ironrdp | 0.17.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-async | 0.10.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-bulk | 0.1.1 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-cliprdr | 0.7.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-cliprdr-native | 0.7.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-connector | 0.10.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-core | 0.2.1 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-displaycontrol | 0.8.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-dvc | 0.8.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-error | 0.2.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-graphics | 0.9.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-input | 0.7.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-pdu (local patch) | 0.9.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-session (local patch) | 0.11.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-svc | 0.8.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-tls | 0.2.2 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| ironrdp-tokio | 0.10.0 | MIT OR Apache-2.0 | https://github.com/Devolutions/IronRDP |
| is-docker | 0.2.0 | MIT | https://github.com/TheLarkInn/is-docker |
| is-wsl | 0.4.0 | MIT | https://github.com/TheLarkInn/is-wsl |
| iso7816 | 0.1.4 | Apache-2.0 OR MIT | https://github.com/trussed-dev/iso7816 |
| iso7816-tlv | 0.4.4 | ISC | https://github.com/jkowalsk/iso7816-tlv |
| itoa | 1.0.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/itoa |
| javascriptcore-rs | 1.1.2 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| javascriptcore-rs-sys | 1.1.1 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| jiff | 0.2.38 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| jiff-core | 0.1.1 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| jiff-static | 0.2.38 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| jiff-tzdb | 0.1.9 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT | https://github.com/BurntSushi/jiff |
| jni | 0.21.1 | MIT/Apache-2.0 | https://github.com/jni-rs/jni-rs |
| jni-sys | 0.3.1 | MIT OR Apache-2.0 | https://github.com/jni-rs/jni-sys |
| jni-sys | 0.4.1 | MIT OR Apache-2.0 | https://github.com/jni-rs/jni-sys |
| jni-sys-macros | 0.4.1 | MIT OR Apache-2.0 | https://github.com/jni-rs/jni-sys |
| jobserver | 0.1.35 | MIT OR Apache-2.0 | https://github.com/rust-lang/jobserver-rs |
| js-sys | 0.3.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| json-patch | 4.2.0 | MIT/Apache-2.0 | https://github.com/idubrov/json-patch |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | https://github.com/chanced/jsonptr |
| keccak | 0.2.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/sponges |
| kem | 0.3.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | https://github.com/rust-windowing/keyboard-types |
| keyring | 3.6.3 | MIT OR Apache-2.0 | https://github.com/hwchen/keyring-rs.git |
| lazy-regex | 3.6.2 | MIT | https://github.com/Canop/lazy-regex |
| lazy-regex-proc_macros | 3.6.2 | MIT | https://github.com/Canop/lazy-regex/tree/main/src/proc_macros |
| lazy_static | 1.5.1 | MIT OR Apache-2.0 | https://github.com/rust-lang-nursery/lazy-static.rs |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |  |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |  |
| libc | 0.2.190 | MIT OR Apache-2.0 | https://github.com/rust-lang/libc |
| libdbus-sys | 0.2.7 | Apache-2.0/MIT | https://github.com/diwic/dbus-rs |
| libloading | 0.7.4 | ISC | https://github.com/nagisa/rust_libloading/ |
| libloading | 0.8.9 | ISC | https://github.com/nagisa/rust_libloading/ |
| libredox | 0.1.25 | MIT | https://gitlab.redox-os.org/redox-os/libredox.git |
| libunftp | 0.23.1 | Apache-2.0 | https://github.com/bolcom/libunftp |
| libz-sys | 1.1.30 | MIT OR Apache-2.0 | https://github.com/rust-lang/libz-sys |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| litemap | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| log | 0.4.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| maybe-owned | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rustonaut/maybe-owned |
| md-5 | 0.10.6 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| md-5 | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| md4 | 0.10.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| md5 | 0.8.1 | Apache-2.0 OR MIT | https://github.com/stainless-steel/md5 |
| memchr | 2.8.3 | Unlicense OR MIT | https://github.com/BurntSushi/memchr |
| memoffset | 0.6.5 | MIT | https://github.com/Gilnaa/memoffset |
| memoffset | 0.9.1 | MIT | https://github.com/Gilnaa/memoffset |
| mime | 0.3.17 | MIT OR Apache-2.0 | https://github.com/hyperium/mime |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 | https://github.com/Alexhuszagh/minimal-lexical |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| mio | 1.2.4 | MIT | https://github.com/tokio-rs/mio |
| ml-kem | 0.3.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/KEMs |
| module-lattice | 0.2.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/KEMs |
| moka | 0.12.16 | (MIT OR Apache-2.0) AND Apache-2.0 | https://github.com/moka-rs/moka |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | https://github.com/awxkee/moxcms.git |
| muda | 0.20.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/muda |
| native-tls | 0.2.18 | MIT OR Apache-2.0 | https://github.com/rust-native-tls/rust-native-tls |
| ndk | 0.9.0 | MIT OR Apache-2.0 | https://github.com/rust-mobile/ndk |
| ndk-context | 0.1.1 | MIT OR Apache-2.0 | https://github.com/rust-windowing/android-ndk-rs |
| ndk-sys | 0.6.0+11769913 | MIT OR Apache-2.0 | https://github.com/rust-mobile/ndk |
| new_debug_unreachable | 1.0.6 | MIT | https://github.com/mbrubeck/rust-debug-unreachable |
| nix | 0.25.1 | MIT | https://github.com/nix-rust/nix |
| nix | 0.30.1 | MIT | https://github.com/nix-rust/nix |
| nix | 0.31.3 | MIT | https://github.com/nix-rust/nix |
| nom | 7.1.3 | MIT | https://github.com/Geal/nom |
| nom | 8.0.0 | MIT | https://github.com/rust-bakery/nom |
| num-bigint | 0.3.3 | MIT OR Apache-2.0 | https://github.com/rust-num/num-bigint |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 | https://github.com/rust-num/num-bigint |
| num-bigint | 0.5.1 | MIT OR Apache-2.0 | https://github.com/rust-num/num-bigint |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | https://github.com/jhpratt/num-conv |
| num-derive | 0.4.2 | MIT OR Apache-2.0 | https://github.com/rust-num/num-derive |
| num-integer | 0.1.47 | MIT OR Apache-2.0 | https://github.com/rust-num/num-integer |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | https://github.com/rust-num/num-traits |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | https://github.com/illicitonion/num_enum |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | https://github.com/illicitonion/num_enum |
| objc2 | 0.6.5 | MIT | https://github.com/madsmtm/objc2 |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-cloud-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-data | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-image | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-location | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-encode | 4.1.0 | MIT | https://github.com/madsmtm/objc2 |
| objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-foundation | 0.3.2 | MIT | https://github.com/madsmtm/objc2 |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-ui-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-user-notifications | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/madsmtm/objc2 |
| oid | 0.2.1 | MIT OR Apache-2.0 | https://github.com/UnnecessaryEngineering/oid |
| oid-registry | 0.8.1 | MIT OR Apache-2.0 | https://github.com/rusticata/oid-registry.git |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | https://github.com/matklad/once_cell |
| open | 5.4.4 | MIT | https://github.com/Byron/open-rs |
| openssl | 0.10.81 | Apache-2.0 | https://github.com/rust-openssl/rust-openssl |
| openssl-macros | 0.1.1 | MIT/Apache-2.0 |  |
| openssl-probe | 0.2.1 | MIT OR Apache-2.0 | https://github.com/rustls/openssl-probe |
| openssl-sys | 0.9.117 | MIT | https://github.com/rust-openssl/rust-openssl |
| option-ext | 0.2.0 | MPL-2.0 | https://github.com/soc/option-ext.git |
| ordered-stream | 0.2.0 | MIT OR Apache-2.0 | https://github.com/danieldg/ordered-stream |
| os_pipe | 1.2.3 | MIT | https://github.com/oconnor663/os_pipe.rs |
| p256 | 0.14.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| p256 | 0.14.0-rc.14 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| p384 | 0.14.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| p384 | 0.14.0-rc.14 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| p521 | 0.14.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| p521 | 0.14.0-rc.14 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| pageant | 0.2.4 | Apache-2.0 | https://github.com/warp-tech/russh |
| pango | 0.18.3 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| pango-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| parking | 2.2.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/parking |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| password-hash | 0.6.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| pbkdf2 | 0.13.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| pem-rfc7468 | 1.0.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| petgraph | 0.8.3 | MIT OR Apache-2.0 | https://github.com/petgraph/petgraph |
| phc | 0.6.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| phf | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_codegen | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_generator | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_macros | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_shared | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| picky | 7.0.0-rc.25 | MIT OR Apache-2.0 | https://github.com/Devolutions/picky-rs |
| picky-asn1 | 0.10.1 | MIT OR Apache-2.0 | https://github.com/Devolutions/picky-rs |
| picky-asn1-der | 0.5.7 | MIT OR Apache-2.0 | https://github.com/Devolutions/picky-rs |
| picky-asn1-x509 | 0.15.5 | MIT OR Apache-2.0 | https://github.com/Devolutions/picky-rs |
| picky-krb | 0.12.4 | MIT OR Apache-2.0 | https://github.com/Devolutions/picky-rs |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| pin-utils | 0.1.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/pin-utils |
| piper | 0.2.5 | MIT OR Apache-2.0 | https://github.com/smol-rs/piper |
| pkcs1 | 0.7.5 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/pkcs1 |
| pkcs1 | 0.8.0-rc.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| pkcs5 | 0.8.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| pkcs8 | 0.11.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 | https://github.com/rust-lang/pkg-config-rs |
| plist | 1.10.1 | MIT | https://github.com/ebarnard/rust-plist/ |
| png | 0.17.16 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| png | 0.18.1 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| polling | 3.11.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/polling |
| poly1305 | 0.9.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| polyval | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| portable-atomic | 1.15.0 | Apache-2.0 OR MIT | https://github.com/taiki-e/portable-atomic |
| portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT | https://github.com/taiki-e/portable-atomic-util |
| portable-pty | 0.8.1 | MIT | https://github.com/wez/wezterm |
| potential_utf | 0.1.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 | https://github.com/jhpratt/powerfmt |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 | https://github.com/cryptocorrosion/cryptocorrosion |
| precomputed-hash | 0.1.1 | MIT | https://github.com/emilio/precomputed-hash |
| primefield | 0.14.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| primeorder | 0.14.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| primeorder | 0.14.0-rc.14 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| proc-macro-crate | 1.3.1 | MIT OR Apache-2.0 | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 2.0.2 | MIT OR Apache-2.0 | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 | https://github.com/bkchr/proc-macro-crate |
| proc-macro-error | 1.0.4 | MIT OR Apache-2.0 | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro-error-attr | 1.0.4 | MIT OR Apache-2.0 | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | https://github.com/dtolnay/proc-macro2 |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 | https://github.com/awxkee/pxfm |
| quick-error | 2.0.1 | MIT/Apache-2.0 | http://github.com/tailhook/quick-error |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| quick-xml | 0.42.0 | MIT | https://github.com/tafia/quick-xml |
| quote | 1.0.47 | MIT OR Apache-2.0 | https://github.com/dtolnay/quote |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| radium | 0.7.0 | MIT | https://github.com/bitvecto-rs/radium |
| rand | 0.10.3 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand | 0.8.8 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand | 0.9.5 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_core | 0.10.1 | MIT OR Apache-2.0 | https://github.com/rust-random/rand_core |
| rand_core | 0.6.4 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_core | 0.9.5 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | https://github.com/rust-windowing/raw-window-handle |
| rc2 | 0.9.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| redox_syscall | 0.5.18 | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| redox_users | 0.4.6 | MIT | https://gitlab.redox-os.org/redox-os/users |
| redox_users | 0.5.3 | MIT | https://gitlab.redox-os.org/redox-os/users |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 | https://github.com/dtolnay/ref-cast |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 | https://github.com/dtolnay/ref-cast |
| regex | 1.13.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| reqwest | 0.13.5 | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| rfc6979 | 0.6.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| rfc6979 | 0.6.0-pre.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures |
| rfd | 0.16.0 | MIT | https://github.com/PolyMeilex/rfd |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| rsa | 0.10.0-rc.18 | MIT OR Apache-2.0 | https://github.com/RustCrypto/RSA |
| russh | 0.64.1 | Apache-2.0 | https://github.com/warp-tech/russh |
| russh-cryptovec | 0.62.0 | Apache-2.0 | https://github.com/warp-tech/russh |
| russh-sftp | 3.0.1 | Apache-2.0 | https://github.com/AspectUnk/russh-sftp |
| russh-util | 0.52.0 | Apache-2.0 | https://github.com/warp-tech/russh |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 | https://github.com/djc/rustc-version-rs |
| rustcrypto-ff | 0.14.0-rc.1 | MIT/Apache-2.0 | https://github.com/RustCrypto/ff |
| rustcrypto-ff_derive | 0.14.0-rc.0 | MIT/Apache-2.0 | https://github.com/zkcrypto/ff |
| rustcrypto-group | 0.14.0-rc.1 | MIT/Apache-2.0 | https://github.com/RustCrypto/group |
| rusticata-macros | 4.1.0 | MIT/Apache-2.0 | https://github.com/rusticata/rusticata-macros.git |
| rustix | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/rustix |
| rustix-linux-procfs | 0.1.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/rustix-linux-procfs |
| rustls | 0.23.45 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| rustls-native-certs | 0.8.5 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls-native-certs |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 | https://github.com/rustls/pki-types |
| rustls-webpki | 0.103.15 | ISC | https://github.com/rustls/webpki |
| rustversion | 1.0.23 | MIT OR Apache-2.0 | https://github.com/dtolnay/rustversion |
| salsa20 | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/stream-ciphers |
| same-file | 1.0.6 | Unlicense/MIT | https://github.com/BurntSushi/same-file |
| schannel | 0.1.29 | MIT | https://github.com/steffengy/schannel-rs |
| schemars | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| schemars | 0.9.0 | MIT | https://github.com/GREsau/schemars |
| schemars | 1.2.3 | MIT | https://github.com/GREsau/schemars |
| schemars_derive | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | https://github.com/bluss/scopeguard |
| scrypt | 0.12.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/password-hashes |
| sec1 | 0.8.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| secrecy | 0.10.3 | Apache-2.0 OR MIT | https://github.com/iqlusioninc/crates/tree/main/secrecy |
| security-framework | 3.7.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| selectors | 0.38.0 | MPL-2.0 | https://github.com/servo/stylo |
| semver | 1.0.28 | MIT OR Apache-2.0 | https://github.com/dtolnay/semver |
| serde | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | https://github.com/dtolnay/serde-untagged |
| serde_bytes | 0.11.19 | MIT OR Apache-2.0 | https://github.com/serde-rs/bytes |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/serde-repr |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | https://github.com/jonasbb/serde_with/ |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | https://github.com/jonasbb/serde_with/ |
| serdect | 0.4.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| serial | 0.4.0 | MIT | https://github.com/dcuddeback/serial-rs |
| serial-core | 0.4.0 | MIT | https://github.com/dcuddeback/serial-rs |
| serial-unix | 0.4.0 | MIT | https://github.com/dcuddeback/serial-rs |
| serial-windows | 0.4.0 | MIT | https://github.com/dcuddeback/serial-rs |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | https://github.com/chippers/serialize-to-javascript |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | https://github.com/chippers/serialize-to-javascript |
| serialport | 4.10.1 | MPL-2.0 | https://github.com/serialport/serialport-rs |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | https://github.com/servo/stylo |
| sha1 | 0.10.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| sha1 | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| sha2 | 0.11.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| sha3 | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| sha3 | 0.12.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| shared_library | 0.1.9 | Apache-2.0/MIT | https://github.com/tomaka/shared_library/ |
| shell-words | 1.1.1 | MIT/Apache-2.0 | https://github.com/tmiasko/shell-words |
| shlex | 2.0.1 | MIT OR Apache-2.0 | https://github.com/comex/rust-shlex |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 | https://github.com/vorner/signal-hook |
| signature | 3.0.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| simd-adler32 | 0.3.10 | MIT | https://github.com/mcountryman/simd-adler32 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | https://github.com/jedisct1/rust-siphash |
| slab | 0.4.12 | MIT | https://github.com/tokio-rs/slab |
| slog | 2.8.2 | MPL-2.0 OR MIT OR Apache-2.0 | https://github.com/slog-rs/slog |
| slog-scope | 4.4.1 | MPL-2.0 OR MIT OR Apache-2.0 | https://github.com/slog-rs/scope |
| slog-stdlog | 4.1.1 | MPL-2.0 OR MIT OR Apache-2.0 | https://github.com/slog-rs/stdlog |
| smallvec | 1.16.3 | MIT OR Apache-2.0 | https://github.com/servo/rust-smallvec |
| socket2 | 0.6.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/socket2 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | https://github.com/rust-windowing/softbuffer |
| soup3 | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| soup3-sys | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| spin | 0.9.9 | MIT | https://github.com/mvdnes/spin-rs.git |
| spki | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/spki |
| spki | 0.8.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| sponge-cursor | 0.1.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| ssh-cipher | 0.3.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| ssh-encoding | 0.3.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| ssh-key | 0.7.0-rc.11 | Apache-2.0 OR MIT | https://github.com/RustCrypto/SSH |
| sspi | 0.21.3 | MIT OR Apache-2.0 | https://github.com/devolutions/sspi-rs |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | https://github.com/storyyeller/stable_deref_trait |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | https://github.com/servo/string-cache |
| string_cache_codegen | 0.6.1 | MIT OR Apache-2.0 | https://github.com/servo/string-cache |
| strsim | 0.11.1 | MIT | https://github.com/rapidfuzz/strsim-rs |
| subtle | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| suppaftp (local patch) | 6.3.0 | MIT OR Apache-2.0 | https://github.com/veeso/suppaftp |
| swift-rs | 1.0.9 | MIT OR Apache-2.0 | https://github.com/Brendonovich/swift-rs |
| syn | 1.0.109 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| syn | 2.0.119 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| syn | 3.0.9 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| sync_wrapper | 1.0.2 | Apache-2.0 | https://github.com/Actyx/sync_wrapper |
| synstructure | 0.13.2 | MIT | https://github.com/mystor/synstructure |
| synstructure | 0.14.0 | MIT | https://github.com/mystor/synstructure |
| system-deps | 6.2.2 | MIT OR Apache-2.0 | https://github.com/gdesmott/system-deps |
| tagptr | 0.2.0 | MIT/Apache-2.0 | https://github.com/oliver-giersch/tagptr.git |
| tao | 0.37.1 | Apache-2.0 | https://github.com/tauri-apps/tao |
| tao-macros | 0.1.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tao |
| tap | 1.0.1 | MIT | https://github.com/myrrlyn/tap |
| target-lexicon | 0.12.16 | Apache-2.0 WITH LLVM-exception | https://github.com/bytecodealliance/target-lexicon |
| tauri | 2.12.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-build | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-codegen | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-macros | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-plugin | 2.7.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-plugin-clipboard-manager | 2.4.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-dialog | 2.8.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-fs | 2.7.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-opener | 2.7.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-window-state | 2.5.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-runtime | 2.12.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-runtime-wry | 2.12.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-utils | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-winres | 0.3.6 | MIT | https://github.com/tauri-apps/winres |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | https://github.com/Stebalien/tempfile |
| tendril | 0.5.1 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| termios | 0.2.2 | MIT | https://github.com/dcuddeback/termios-rs |
| thiserror | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| tiff | 0.11.3 | MIT | https://github.com/image-rs/image-tiff |
| time | 0.3.55 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| time-core | 0.1.9 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| time-macros | 0.2.32 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| tinystr | 0.8.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/tinyvec |
| tls_codec | 0.4.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| tls_codec_derive | 0.4.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| tokio | 1.53.3 | MIT | https://github.com/tokio-rs/tokio |
| tokio-macros | 2.7.2 | MIT | https://github.com/tokio-rs/tokio |
| tokio-native-tls | 0.3.1 | MIT | https://github.com/tokio-rs/tls |
| tokio-rustls | 0.26.6 | MIT OR Apache-2.0 | https://github.com/rustls/tokio-rustls |
| tokio-stream | 0.1.19 | MIT | https://github.com/tokio-rs/tokio |
| tokio-tungstenite | 0.24.0 | MIT | https://github.com/snapview/tokio-tungstenite |
| tokio-util | 0.7.20 | MIT | https://github.com/tokio-rs/tokio |
| toml | 0.8.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_datetime | 0.6.3 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_edit | 0.19.15 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_edit | 0.20.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_edit | 0.25.17+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_writer | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| tower | 0.5.3 | MIT | https://github.com/tower-rs/tower |
| tower-http | 0.6.11 | MIT | https://github.com/tower-rs/tower-http |
| tower-layer | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tower-service | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tracing | 0.1.44 | MIT | https://github.com/tokio-rs/tracing |
| tracing-attributes | 0.1.31 | MIT | https://github.com/tokio-rs/tracing |
| tracing-core | 0.1.36 | MIT | https://github.com/tokio-rs/tracing |
| tray-icon | 0.25.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tray-icon |
| tree_magic_mini | 3.2.2 | MIT | https://github.com/mbrubeck/tree_magic/ |
| try-lock | 0.2.5 | MIT | https://github.com/seanmonstar/try-lock |
| tungstenite | 0.24.0 | MIT OR Apache-2.0 | https://github.com/snapview/tungstenite-rs |
| typeid | 1.0.3 | MIT OR Apache-2.0 | https://github.com/dtolnay/typeid |
| typenum | 1.20.1 | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| uds_windows | 1.2.1 | MIT | https://github.com/haraldh/rust_uds_windows |
| unftp-core | 0.1.0 | Apache-2.0 | https://github.com/bolcom/libunftp/tree/master/crates/unftp-core |
| unftp-sbe-fs | 0.4.0 | Apache-2.0 | https://github.com/bolcom/libunftp/tree/master/crates/unftp-sbe-fs |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-segmentation |
| unicode-xid | 0.2.6 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-xid |
| universal-hash | 0.6.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| untrusted | 0.9.0 | ISC | https://github.com/briansmith/untrusted |
| url | 2.5.8 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| urlpattern | 0.6.0 | MIT | https://github.com/denoland/rust-urlpattern |
| utf-8 | 0.7.6 | MIT OR Apache-2.0 | https://github.com/SimonSapin/rust-utf8 |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | https://github.com/hsivonen/utf8_iter |
| uuid | 1.28.0 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| vcpkg | 0.2.15 | MIT/Apache-2.0 | https://github.com/mcgoo/vcpkg-rs |
| version-compare | 0.2.1 | MIT | https://gitlab.com/timvisee/version-compare |
| version_check | 0.9.5 | MIT/Apache-2.0 | https://github.com/SergioBenitez/version_check |
| vswhom | 0.1.0 | MIT | https://github.com/nabijaczleweli/vswhom.rs |
| vswhom-sys | 0.1.3 | MIT | https://github.com/nabijaczleweli/vswhom-sys.rs |
| walkdir | 2.5.0 | Unlicense/MIT | https://github.com/BurntSushi/walkdir |
| want | 0.3.2 | MIT | https://github.com/seanmonstar/want |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi-rs |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen |
| wasm-bindgen-futures | 0.4.79 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/main/crates/macro-support |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| wasm-streams | 0.5.0 | MIT OR Apache-2.0 | https://github.com/MattiasBuelens/wasm-streams/ |
| wayland-backend | 0.3.17 | MIT | https://github.com/smithay/wayland-rs |
| wayland-client | 0.31.15 | MIT | https://github.com/smithay/wayland-rs |
| wayland-protocols | 0.32.13 | MIT | https://github.com/smithay/wayland-rs |
| wayland-protocols-wlr | 0.3.12 | MIT | https://github.com/smithay/wayland-rs |
| wayland-scanner | 0.31.11 | MIT | https://github.com/smithay/wayland-rs |
| wayland-sys | 0.31.11 | MIT | https://github.com/smithay/wayland-rs |
| web-sys | 0.3.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| web-time | 1.1.0 | MIT OR Apache-2.0 | https://github.com/daxpedda/web-time |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | https://github.com/servo/html5ever |
| webkit2gtk | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webkit2gtk-sys | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webview2-com | 0.39.1 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-macros | 0.8.1 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-sys | 0.39.1 | MIT | https://github.com/wravery/webview2-rs |
| weezl | 0.1.12 | MIT OR Apache-2.0 | https://github.com/image-rs/weezl |
| widestring | 1.2.1 | MIT OR Apache-2.0 | https://github.com/VoidStarKat/widestring-rs |
| winapi | 0.3.9 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| winapi-util | 0.1.11 | Unlicense OR MIT | https://github.com/BurntSushi/winapi-util |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| windows | 0.62.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-registry | 0.6.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.45.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.48.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.42.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| winnow | 0.5.40 | MIT | https://github.com/winnow-rs/winnow |
| winnow | 1.0.4 | MIT | https://github.com/winnow-rs/winnow |
| winreg | 0.10.1 | MIT | https://github.com/gentoo90/winreg-rs |
| winreg | 0.56.0 | MIT | https://github.com/gentoo90/winreg-rs |
| winscard | 0.3.3 | MIT/Apache-2.0 | https://github.com/devolutions/sspi-rs |
| winx | 0.36.4 | Apache-2.0 WITH LLVM-exception | https://github.com/sunfishcode/winx |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wl-clipboard-rs | 0.9.4 | MIT OR Apache-2.0 | https://github.com/YaLTeR/wl-clipboard-rs |
| wnaf | 0.14.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves |
| writeable | 0.6.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| wry | 0.57.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/wry |
| wyz | 0.5.1 | MIT | https://github.com/myrrlyn/wyz |
| x11 | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| x11-dl | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| x11rb | 0.13.2 | MIT OR Apache-2.0 | https://github.com/psychon/x11rb |
| x11rb-protocol | 0.13.2 | MIT OR Apache-2.0 | https://github.com/psychon/x11rb |
| x25519-dalek | 3.0.0-rc.1 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/x25519-dalek |
| x509-cert | 0.2.5 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/x509-cert |
| x509-parser | 0.18.1 | MIT OR Apache-2.0 | https://github.com/rusticata/x509-parser.git |
| yoke | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yoke-derive | 0.8.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yuv | 0.8.19 | BSD-3-Clause OR Apache-2.0 | https://github.com/awxkee/yuvutils-rs |
| zbus | 5.19.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zbus_macros | 5.19.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zbus_names | 4.3.4 | MIT | https://github.com/z-galaxy/zbus/ |
| zcheapstr | 1.1.0 | MIT | https://github.com/z-galaxy/zcheapstr/ |
| zerocopy | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerocopy-derive | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerofrom | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zeroize | 1.9.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| zerotrie | 0.2.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec | 0.11.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec-derive | 0.11.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zlib-rs | 0.6.8 | Zlib | https://github.com/trifectatechfoundation/zlib-rs |
| zmij | 1.0.23 | MIT | https://github.com/dtolnay/zmij |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |
| zvariant | 5.15.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zvariant_derive | 5.15.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zvariant_utils | 4.2.0 | MIT | https://github.com/z-galaxy/zbus/ |
