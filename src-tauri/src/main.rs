#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

struct BackendProcess(Mutex<Option<Child>>);

#[tauri::command]
fn get_host_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            // Build native system tray with Open, Hide to Tray, and Quit actions
            let show_item = MenuItem::with_id(app, "show", "Open JARVIS", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Minimize to Tray", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit JARVIS", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("JARVIS — Local Autonomous AI OS")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => {
                        let state = app.state::<BackendProcess>();
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Launch local Node/tsx JARVIS backend on 127.0.0.1:3000 in packaged desktop mode
            if !cfg!(debug_assertions) {
                if let Ok(child) = Command::new("node")
                    .arg("dist-server/server.js")
                    .env("HOST", "127.0.0.1")
                    .env("PORT", "3000")
                    .env("NODE_ENV", "production")
                    .spawn()
                {
                    let state = app.state::<BackendProcess>();
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize-to-tray on close request so JARVIS continues background monitoring
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_host_platform,
            hide_to_tray,
            show_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running JARVIS Tauri shell");
}
