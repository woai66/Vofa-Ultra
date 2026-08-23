mod serial;

use serial::{
    connect_serial, disconnect_serial, get_serial_state, list_serial_ports, send_serial,
    SerialState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            get_serial_state,
            connect_serial,
            disconnect_serial,
            send_serial,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Vofa-Ultra 失败");
}
