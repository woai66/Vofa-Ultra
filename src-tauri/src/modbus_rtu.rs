use std::time::Duration;

const MAX_RTU_FRAME_SIZE: usize = 256;
const MAX_OBSERVED_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_READ_BITS: u16 = 2_000;
const MAX_READ_REGISTERS: u16 = 125;
const MAX_WRITE_COILS: u16 = 1_968;
const MAX_WRITE_REGISTERS: u16 = 123;

pub(crate) const MIN_TRANSACTION_TIMEOUT_MS: u64 = 100;
pub(crate) const MAX_TRANSACTION_TIMEOUT_MS: u64 = 60_000;
pub(crate) const BUS_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
pub(crate) struct ModbusRequestSpec {
    request: Vec<u8>,
    unit_id: u8,
    function_code: u8,
    response_kind: ResponseKind,
    broadcast: bool,
}

#[derive(Clone, Copy, Debug)]
enum ResponseKind {
    Read { byte_count: u8 },
    Write { expected_prefix: [u8; 6] },
}

impl ModbusRequestSpec {
    pub(crate) fn parse(request: Vec<u8>) -> Result<Self, String> {
        if request.len() < 8 || request.len() > MAX_RTU_FRAME_SIZE {
            return Err("Modbus RTU 请求帧长度无效".to_owned());
        }
        if !has_valid_crc(&request) {
            return Err("Modbus RTU 请求 CRC 校验失败".to_owned());
        }
        let unit_id = request[0];
        if unit_id > 247 {
            return Err("Modbus RTU 站号必须是 0-247".to_owned());
        }
        let function_code = request[1];
        let address = word(&request, 2);
        let (quantity, response_kind) = match function_code {
            0x01 | 0x02 => {
                require_length(&request, 8)?;
                if unit_id == 0 {
                    return Err("Modbus RTU 读取请求不能使用广播站号 0".to_owned());
                }
                let quantity = word(&request, 4);
                require_quantity(quantity, MAX_READ_BITS, "读取位数量")?;
                (
                    quantity,
                    ResponseKind::Read {
                        byte_count: quantity.div_ceil(8) as u8,
                    },
                )
            }
            0x03 | 0x04 => {
                require_length(&request, 8)?;
                if unit_id == 0 {
                    return Err("Modbus RTU 读取请求不能使用广播站号 0".to_owned());
                }
                let quantity = word(&request, 4);
                require_quantity(quantity, MAX_READ_REGISTERS, "读取寄存器数量")?;
                (
                    quantity,
                    ResponseKind::Read {
                        byte_count: (quantity * 2) as u8,
                    },
                )
            }
            0x05 => {
                require_length(&request, 8)?;
                let value = word(&request, 4);
                if value != 0x0000 && value != 0xff00 {
                    return Err("Modbus RTU 单线圈写入值必须是 0000 或 FF00".to_owned());
                }
                (1, write_response_kind(&request))
            }
            0x06 => {
                require_length(&request, 8)?;
                (1, write_response_kind(&request))
            }
            0x0f => {
                let quantity = word(&request, 4);
                require_quantity(quantity, MAX_WRITE_COILS, "写入线圈数量")?;
                let byte_count = request[6] as usize;
                let expected_byte_count = quantity.div_ceil(8) as usize;
                if byte_count != expected_byte_count || request.len() != byte_count + 9 {
                    return Err("Modbus RTU 多线圈请求的数量与字节数不一致".to_owned());
                }
                let unused_bits = byte_count * 8 - quantity as usize;
                if unused_bits > 0 {
                    let used_bits = 8 - unused_bits;
                    let last_value = request[7 + byte_count - 1];
                    if last_value >> used_bits != 0 {
                        return Err("Modbus RTU 多线圈请求包含非零填充位".to_owned());
                    }
                }
                (quantity, write_response_kind(&request))
            }
            0x10 => {
                let quantity = word(&request, 4);
                require_quantity(quantity, MAX_WRITE_REGISTERS, "写入寄存器数量")?;
                let byte_count = request[6] as usize;
                if byte_count != quantity as usize * 2 || request.len() != byte_count + 9 {
                    return Err("Modbus RTU 多寄存器请求的数量与字节数不一致".to_owned());
                }
                (quantity, write_response_kind(&request))
            }
            _ => return Err(format!("不支持的 Modbus RTU 功能码: {function_code:02X}")),
        };
        if address as u32 + quantity as u32 > u16::MAX as u32 + 1 {
            return Err("Modbus RTU 请求范围超过地址 65535".to_owned());
        }

        Ok(Self {
            request,
            unit_id,
            function_code,
            response_kind,
            broadcast: unit_id == 0,
        })
    }

    pub(crate) fn request(&self) -> &[u8] {
        &self.request
    }

    pub(crate) fn is_broadcast(&self) -> bool {
        self.broadcast
    }

    fn validate_response(&self, frame: &[u8]) -> Result<(), ResponseErrorCode> {
        match self.response_kind {
            ResponseKind::Read { byte_count } => {
                if frame.get(2).copied() != Some(byte_count)
                    || frame.len() != byte_count as usize + 5
                {
                    return Err(ResponseErrorCode::ResponseMismatch);
                }
            }
            ResponseKind::Write { expected_prefix } => {
                if frame.len() != 8 || frame[..6] != expected_prefix {
                    return Err(ResponseErrorCode::ResponseMismatch);
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResponseErrorCode {
    CrcMismatch,
    ResponseMismatch,
    ResponseOverflow,
}

impl ResponseErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CrcMismatch => "crc-mismatch",
            Self::ResponseMismatch => "response-mismatch",
            Self::ResponseOverflow => "response-overflow",
        }
    }

    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::CrcMismatch => "收到关联响应，但 CRC 校验失败",
            Self::ResponseMismatch => "收到关联响应，但长度或回显字段与请求不一致",
            Self::ResponseOverflow => "事务观察的响应数据超过 64 KiB 上限",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResponseMatch {
    Normal(Vec<u8>),
    Exception { frame: Vec<u8>, code: u8 },
    ProtocolError(ResponseErrorCode),
}

pub(crate) struct ModbusResponseCollector {
    spec: ModbusRequestSpec,
    buffer: Vec<u8>,
    observed_bytes: usize,
    last_error: Option<ResponseErrorCode>,
}

impl ModbusResponseCollector {
    pub(crate) fn new(spec: ModbusRequestSpec) -> Self {
        Self {
            spec,
            buffer: Vec::with_capacity(MAX_RTU_FRAME_SIZE - 1),
            observed_bytes: 0,
            last_error: None,
        }
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Option<ResponseMatch> {
        self.observed_bytes = self.observed_bytes.saturating_add(bytes.len());
        if self.observed_bytes > MAX_OBSERVED_RESPONSE_BYTES {
            return Some(ResponseMatch::ProtocolError(
                ResponseErrorCode::ResponseOverflow,
            ));
        }
        self.buffer.extend_from_slice(bytes);

        for start in 0..self.buffer.len() {
            if self.buffer[start] != self.spec.unit_id {
                continue;
            }
            let Some(function_code) = self.buffer.get(start + 1).copied() else {
                continue;
            };
            let frame_length = if function_code == (self.spec.function_code | 0x80) {
                5
            } else if function_code == self.spec.function_code {
                match self.spec.response_kind {
                    ResponseKind::Read { .. } => {
                        let Some(byte_count) = self.buffer.get(start + 2).copied() else {
                            continue;
                        };
                        byte_count as usize + 5
                    }
                    ResponseKind::Write { .. } => 8,
                }
            } else {
                continue;
            };
            if frame_length > MAX_RTU_FRAME_SIZE || start + frame_length > self.buffer.len() {
                continue;
            }

            let frame = &self.buffer[start..start + frame_length];
            if !has_valid_crc(frame) {
                self.last_error = Some(ResponseErrorCode::CrcMismatch);
                continue;
            }
            if function_code == (self.spec.function_code | 0x80) {
                return Some(ResponseMatch::Exception {
                    frame: frame.to_vec(),
                    code: frame[2],
                });
            }
            if let Err(error) = self.spec.validate_response(frame) {
                self.last_error = Some(error);
                continue;
            }
            return Some(ResponseMatch::Normal(frame.to_vec()));
        }

        if self.buffer.len() >= MAX_RTU_FRAME_SIZE {
            let keep_from = self.buffer.len() - (MAX_RTU_FRAME_SIZE - 1);
            self.buffer.drain(..keep_from);
        }
        None
    }

    pub(crate) fn last_error(&self) -> Option<ResponseErrorCode> {
        self.last_error
    }
}

pub(crate) fn silent_interval(
    baud_rate: u32,
    data_bits: u8,
    parity_enabled: bool,
    stop_bits: u8,
) -> Duration {
    if baud_rate > 19_200 {
        return Duration::from_micros(1_750);
    }
    let bits_per_character = 1_u64 + data_bits as u64 + parity_enabled as u64 + stop_bits as u64;
    let numerator = bits_per_character * 35 * 1_000_000;
    let denominator = baud_rate.max(1) as u64 * 10;
    Duration::from_micros(numerator.div_ceil(denominator))
}

fn write_response_kind(request: &[u8]) -> ResponseKind {
    ResponseKind::Write {
        expected_prefix: request[..6].try_into().expect("请求前缀长度应已校验"),
    }
}

fn require_length(request: &[u8], expected: usize) -> Result<(), String> {
    if request.len() != expected {
        return Err("Modbus RTU 请求帧长度与功能码不一致".to_owned());
    }
    Ok(())
}

fn require_quantity(quantity: u16, maximum: u16, label: &str) -> Result<(), String> {
    if quantity == 0 || quantity > maximum {
        return Err(format!("{label}必须是 1-{maximum}"));
    }
    Ok(())
}

fn word(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}

fn has_valid_crc(frame: &[u8]) -> bool {
    if frame.len() < 3 {
        return false;
    }
    let expected = crc16_modbus(&frame[..frame.len() - 2]);
    let actual = u16::from_le_bytes([frame[frame.len() - 2], frame[frame.len() - 1]]);
    expected == actual
}

#[cfg(test)]
fn append_crc(payload: &[u8]) -> Vec<u8> {
    let crc = crc16_modbus(payload);
    let mut frame = Vec::with_capacity(payload.len() + 2);
    frame.extend_from_slice(payload);
    frame.extend_from_slice(&crc.to_le_bytes());
    frame
}

fn crc16_modbus(bytes: &[u8]) -> u16 {
    let mut crc = 0xffff_u16;
    for byte in bytes {
        crc ^= *byte as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xa001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(payload: &[u8]) -> Vec<u8> {
        append_crc(payload)
    }

    #[test]
    fn parses_all_supported_request_shapes() {
        let requests = [
            request(&[1, 1, 0, 0, 0, 8]),
            request(&[1, 2, 0, 0, 0, 8]),
            request(&[1, 3, 0, 0, 0, 2]),
            request(&[1, 4, 0, 0, 0, 2]),
            request(&[1, 5, 0, 0, 0xff, 0]),
            request(&[1, 6, 0, 0, 0, 1]),
            request(&[1, 15, 0, 0, 0, 9, 2, 1, 1]),
            request(&[1, 16, 0, 0, 0, 2, 4, 0, 1, 0, 2]),
        ];
        for frame in requests {
            assert!(ModbusRequestSpec::parse(frame).is_ok());
        }
    }

    #[test]
    fn rejects_invalid_crc_broadcast_reads_and_inconsistent_lengths() {
        let mut invalid_crc = request(&[1, 3, 0, 0, 0, 1]);
        invalid_crc[2] ^= 1;
        assert!(ModbusRequestSpec::parse(invalid_crc)
            .unwrap_err()
            .contains("CRC"));
        assert!(ModbusRequestSpec::parse(request(&[0, 3, 0, 0, 0, 1]))
            .unwrap_err()
            .contains("广播"));
        assert!(
            ModbusRequestSpec::parse(request(&[1, 16, 0, 0, 0, 2, 2, 0, 1]))
                .unwrap_err()
                .contains("不一致")
        );
    }

    #[test]
    fn matches_read_response_across_every_split_and_preserves_noise() {
        let spec = ModbusRequestSpec::parse(request(&[0x11, 3, 0, 0x6b, 0, 3])).unwrap();
        let response = request(&[0x11, 3, 6, 0, 1, 0, 2, 0, 3]);
        for split in 0..=response.len() {
            let mut collector = ModbusResponseCollector::new(spec.clone());
            assert_eq!(collector.push(&[0xaa, 0xbb]), None);
            let first = collector.push(&response[..split]);
            let result = first.or_else(|| collector.push(&response[split..]));
            assert_eq!(result, Some(ResponseMatch::Normal(response.clone())));
        }
    }

    #[test]
    fn matches_exception_and_reports_correlated_crc_or_echo_errors() {
        let spec = ModbusRequestSpec::parse(request(&[1, 3, 0, 0, 0, 1])).unwrap();
        let exception = request(&[1, 0x83, 2]);
        let mut exception_collector = ModbusResponseCollector::new(spec.clone());
        assert_eq!(
            exception_collector.push(&exception),
            Some(ResponseMatch::Exception {
                frame: exception,
                code: 2,
            })
        );

        let mut bad_crc = request(&[1, 3, 2, 0, 1]);
        bad_crc[4] ^= 1;
        let mut crc_collector = ModbusResponseCollector::new(spec.clone());
        assert_eq!(crc_collector.push(&bad_crc), None);
        assert_eq!(
            crc_collector.last_error(),
            Some(ResponseErrorCode::CrcMismatch)
        );

        let mismatch = request(&[1, 3, 4, 0, 1, 0, 2]);
        let mut mismatch_collector = ModbusResponseCollector::new(spec);
        assert_eq!(mismatch_collector.push(&mismatch), None);
        assert_eq!(
            mismatch_collector.last_error(),
            Some(ResponseErrorCode::ResponseMismatch)
        );
    }

    #[test]
    fn validates_write_echo_and_broadcast_requests() {
        let single = request(&[1, 6, 0, 2, 0, 9]);
        let spec = ModbusRequestSpec::parse(single.clone()).unwrap();
        let mut collector = ModbusResponseCollector::new(spec);
        assert_eq!(collector.push(&single), Some(ResponseMatch::Normal(single)));

        let broadcast = ModbusRequestSpec::parse(request(&[0, 6, 0, 2, 0, 9])).unwrap();
        assert!(broadcast.is_broadcast());
    }

    #[test]
    fn uses_protocol_silence_for_low_and_high_baud_rates() {
        assert_eq!(
            silent_interval(115_200, 8, false, 1),
            Duration::from_micros(1_750)
        );
        assert_eq!(
            silent_interval(9_600, 8, false, 1),
            Duration::from_micros(3_646)
        );
        assert!(silent_interval(1_200, 8, true, 2) > Duration::from_millis(30));
    }
}
