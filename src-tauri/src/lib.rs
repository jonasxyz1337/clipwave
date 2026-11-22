//! Clipwave – Tauri backend. The UI (src/) is plain HTML/JS; everything that touches the system lives here.
mod chat;
mod export;
mod media;
mod store;
mod stt;
mod update;
mod util;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            update::start(app.handle());
            Ok(())
        })
        .on_window_event(|_, e| {
            if let tauri::WindowEvent::Destroyed = e {
                util::kill_all(); // never leave ffmpeg / yt-dlp running after the window closes
            }
        })
        .invoke_handler(tauri::generate_handler![
            store::env,
            store::state_load,
            store::state_save,
            store::fs_exists,
            store::pick_dir,
            store::shell_open,
            store::shell_show,
            store::open_url,
            store::sound_pick,
            store::storage_info,
            store::storage_clean,
            store::video_purge,
            media::video_url,
            media::video_file,
            media::video_path,
            media::find_highlight,
            chat::chat_replay,
            stt::transcribe,
            stt::eleven_connect,
            stt::eleven_stop,
            stt::eleven_check,
            export::export_one,
            export::export_reset,
            export::cancel_export,
            export::outro_paths,
            export::gfx_path,
            export::enc_begin,
            export::enc_frame,
            export::enc_end,
            update::update_check,
            update::update_install,
            update::update_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clipwave");
}
