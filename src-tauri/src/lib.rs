// BananaConn backend entry point.
//
// Terminal protocols (SSH, Telnet) stream through term.rs; file protocols
// (SFTP, FTP) through remote.rs; RDP launches mstsc; VNC is rendered in-app by
// noVNC over the loopback bridge in vnc.rs. Credentials live in vault.rs.

mod childjob;
mod comport;
mod fileservers;
mod ftpserver;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod sftp_tests;
mod importsrc;
mod legacy;
mod lock;
mod monitor;
mod devmon;
mod nettools;
mod paste;
mod ai;
mod sshkit;
pub mod http;
pub mod proxy;
mod rdp;
mod remote;
mod store;
mod telnet;
mod termlog;
mod tftpclient;
mod termout;
mod tunnel;
mod updater;
mod term;
mod vault;
mod vnc;
mod wsutil;

/// Test runs: the main window (created hidden by the E2E configuration)
/// goes far off screen with no taskbar button, then is shown without being
/// activated.
fn show_off_screen(app: &tauri::App) {
    use tauri::Manager;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, SW_SHOWNOACTIVATE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_position(tauri::PhysicalPosition::new(-20000, -20000));
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: a valid window handle of this process. A tool window has no
        // taskbar button and is left out of Alt+Tab.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd.0, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
            ShowWindow(hwnd.0, SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before any window: the old identifier's folders become this one's.
    if let Err(e) = legacy::move_data_dirs(&context.config().identifier) {
        legacy::fatal(&e);
        return;
    }
    // Test runs (a non-release build started with BX_E2E_OFFSCREEN set) keep
    // their window off screen, without a taskbar button or the focus, so a
    // test run does not take over the screen of whoever works on this PC.
    let offscreen = !legacy::is_release(&context.config().identifier) && std::env::var_os("BX_E2E_OFFSCREEN").is_some();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    // Restore the window's size and position from the last run (it also
    // shows and focuses the window, so not in test runs).
    let builder = if offscreen { builder } else { builder.plugin(tauri_plugin_window_state::Builder::default().build()) };
    builder
        .manage(term::TermState::default())
        .manage(proxy::ProxyState::default())
        .manage(ai::AiState::default())
        .manage(sshkit::SshKitState::default())
        .manage(remote::RemoteState::default())
        .manage(vnc::VncState::default())
        .manage(rdp::RdpState::default())
        .manage(ftpserver::FtpServerState::default())
        .manage(tunnel::TunnelState::default())
        .manage(fileservers::FileServersState::default())
        .manage(lock::LockState::default())
        .manage(monitor::MonitorState::default())
        .manage(tftpclient::TftpState::default())
        .setup(move |app| {
            if offscreen {
                show_off_screen(app);
            }
            lock::init(app.handle());
            // Old-named secrets and scratch folders, off the startup path
            // (the released app only, like the data folders).
            if legacy::is_release(&app.config().identifier) {
                std::thread::spawn(|| {
                    legacy::move_vault_entries(vault::SERVICE);
                    legacy::remove_old_temp();
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store::sessions_load,
            store::sessions_save,
            store::read_text_file,
            importsrc::import_scan,
            importsrc::registry_export,
            term::term_open,
            term::term_write,
            term::term_ack,
            term::windows_build,
            term::os_ui_language,
            term::risk_audit,
            term::term_resize,
            term::term_close,
            term::serial_ports,
            term::term_break,
            term::term_paste,
            proxy::proxy_forward_open,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_models,
            ai::ai_detect_cli,
            ai::ai_cli_models,
            proxy::proxy_forward_close,
            term::term_paste_stop,
            term::term_set_logging,
            term::logs_folder,
            term::save_text_file,
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_list,
            remote::remote_op,
            remote::transfer,
            remote::transfer_cancel,
            remote::local_home,
            remote::local_list,
            remote::local_op,
            remote::edit_temp_path,
            remote::edit_temp_release,
            remote::remote_read_text,
            remote::remote_write_text,
            tunnel::tunnel_open,
            tunnel::tunnel_close,
            tunnel::tunnel_list,
            nettools::net_ping,
            nettools::net_ping_cancel,
            nettools::net_ports,
            nettools::net_dns,
            fileservers::file_server_start,
            fileservers::file_server_stop,
            fileservers::file_server_status,
            fileservers::file_server_active,
            lock::lock_status,
            lock::lock_unlock,
            lock::lock_lock,
            lock::lock_set,
            monitor::monitor_start,
            monitor::monitor_stop,
            monitor::monitor_top,
            monitor::monitor_backup,
            monitor::monitor_commands,
            monitor::monitor_types,
            sshkit::ssh_kit_start,
            sshkit::ssh_kit_stop,
            sshkit::ssh_kit_allow,
            monitor::monitor_pause,
            tftpclient::tftp_transfer,
            tftpclient::tftp_cancel,
            updater::update_check,
            updater::update_install,
            updater::update_open_folder,
            remote::local_stat,
            rdp::rdp_launch,
            rdp::rdp_open,
            rdp::rdp_cert,
            rdp::rdp_input,
            rdp::rdp_visible,
            rdp::rdp_resize,
            rdp::rdp_close,
            ftpserver::ftp_server_start,
            ftpserver::ftp_server_stop,
            ftpserver::ftp_server_status,
            vnc::vnc_proxy_start,
            vnc::vnc_proxy_stop,
            vnc::vnc_proxy_stats,
            vnc::vnc_proxy_error,
            vault::vault_list,
            vault::vault_save,
            vault::vault_delete,
            vault::vault_generate_key,
            vault::vault_public_key,
            vault::vault_reveal,
            vault::vault_default_key_dir,
        ])
        .build(context)
        .expect("error while running tauri application")
        .run(|app, event| {
            // Sessions are not dropped when the process exits: close the logs.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                term::end_all_logs(&app.state::<term::TermState>());
            }
        });
}
