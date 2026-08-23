mod capture;
mod serial;

use capture::{
    abort_capture, append_simulator_capture, get_capture_state, start_capture, stop_capture,
    CaptureState,
};
use serial::{
    connect_serial, disconnect_serial, get_serial_state, list_serial_ports, send_serial,
    SerialState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureState::default())
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            get_serial_state,
            connect_serial,
            disconnect_serial,
            send_serial,
            get_capture_state,
            start_capture,
            stop_capture,
            abort_capture,
            append_simulator_capture,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Vofa-Ultra 失败");
}
