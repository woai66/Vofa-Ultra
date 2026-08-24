mod capture;
mod capture_export;
mod replay;
mod serial;

use capture::{
    abort_capture, append_simulator_capture, get_capture_state, start_capture, stop_capture,
    CaptureState,
};
use capture_export::{
    cancel_capture_export, clear_capture_export, get_capture_export_state, start_capture_export,
    CaptureExportState,
};
use replay::{
    ack_replay_batch, close_replay, get_replay_state, open_replay, pause_replay, play_replay,
    seek_replay, set_replay_speed, stop_replay, ReplayState,
};
use serial::{
    cancel_serial_connect, connect_serial, disconnect_serial, get_serial_state, list_serial_ports,
    send_serial, SerialState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureState::default())
        .manage(CaptureExportState::default())
        .manage(ReplayState::default())
        .manage(SerialState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            get_serial_state,
            connect_serial,
            cancel_serial_connect,
            disconnect_serial,
            send_serial,
            get_capture_state,
            start_capture,
            stop_capture,
            abort_capture,
            append_simulator_capture,
            get_capture_export_state,
            start_capture_export,
            cancel_capture_export,
            clear_capture_export,
            get_replay_state,
            open_replay,
            play_replay,
            pause_replay,
            seek_replay,
            set_replay_speed,
            stop_replay,
            close_replay,
            ack_replay_batch,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Vofa-Ultra 失败");
}
