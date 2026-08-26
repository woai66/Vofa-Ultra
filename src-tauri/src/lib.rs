mod capture;
mod capture_export;
mod extensions;
mod modbus_rtu;
mod numeric_log;
mod recording_directory;
mod replay;
mod serial;

use capture::{
    abort_capture, append_capture_marker, append_simulator_capture, get_capture_state,
    start_capture, stop_capture, CaptureState,
};
use capture_export::{
    cancel_capture_export, clear_capture_export, get_capture_export_state, start_capture_export,
    CaptureExportState,
};
use extensions::{
    activate_extension, deactivate_extension, get_extension_state, inspect_extension,
    push_extension_batch, reset_extension, ExtensionState,
};
use numeric_log::{
    abort_numeric_log, append_numeric_log, get_numeric_log_state, start_numeric_log,
    stop_numeric_log, NumericLogState,
};
use replay::{
    ack_replay_batch, close_replay, get_replay_markers, get_replay_state, open_replay,
    pause_replay, play_replay, seek_replay, set_replay_speed, stop_replay, ReplayState,
};
use serial::{
    cancel_modbus_transaction, cancel_serial_connect, cancel_serial_file_send, connect_serial,
    disconnect_serial, get_serial_file_send_state, get_serial_state, list_serial_ports,
    send_serial, set_serial_control_line, start_modbus_transaction, start_serial_file_send,
    SerialState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureState::default())
        .manage(CaptureExportState::default())
        .manage(ExtensionState::default())
        .manage(NumericLogState::default())
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
            set_serial_control_line,
            get_serial_file_send_state,
            start_serial_file_send,
            cancel_serial_file_send,
            start_modbus_transaction,
            cancel_modbus_transaction,
            get_capture_state,
            start_capture,
            stop_capture,
            abort_capture,
            append_simulator_capture,
            append_capture_marker,
            get_capture_export_state,
            start_capture_export,
            cancel_capture_export,
            clear_capture_export,
            inspect_extension,
            activate_extension,
            get_extension_state,
            deactivate_extension,
            reset_extension,
            push_extension_batch,
            get_numeric_log_state,
            start_numeric_log,
            append_numeric_log,
            stop_numeric_log,
            abort_numeric_log,
            get_replay_state,
            get_replay_markers,
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
