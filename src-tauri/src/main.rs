// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh.exe's ProxyCommand for a session behind a proxy (proxy.rs): pipe
    // stdin/stdout to the app's local forward, without starting the app.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--proxy-stdio") {
        std::process::exit(bananaconn_lib::proxy::stdio_main(&args[1..]));
    }
    bananaconn_lib::run()
}
