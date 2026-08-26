import crc16modbus from "crc/calculators/crc16modbus";

export const MAX_MODBUS_RTU_UNIT_ID = 247;
export const MAX_MODBUS_READ_BITS = 2_000;
export const MAX_MODBUS_READ_REGISTERS = 125;
export const MAX_MODBUS_WRITE_COILS = 1_968;
export const MAX_MODBUS_WRITE_REGISTERS = 123;
export const MAX_MODBUS_VALUE_TEXT_CHARACTERS = 8_192;
export const MIN_MODBUS_TRANSACTION_TIMEOUT_MS = 100;
export const MAX_MODBUS_TRANSACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_MODBUS_TRANSACTION_TIMEOUT_MS = 1_000;
export const MAX_MODBUS_TRANSACTION_HISTORY = 32;
const MAX_MODBUS_INTEGER_TEXT_CHARACTERS = 10;

export type ModbusRtuOperation =
  | "read-coils"
  | "read-discrete-inputs"
  | "read-holding-registers"
  | "read-input-registers"
  | "write-single-coil"
  | "write-single-register"
  | "write-multiple-coils"
  | "write-multiple-registers";

export interface ModbusRtuOperationOption {
  value: ModbusRtuOperation;
  functionCode: number;
  label: string;
}

export const MODBUS_RTU_OPERATION_OPTIONS: readonly ModbusRtuOperationOption[] = [
  { value: "read-coils", functionCode: 0x01, label: "01 读取线圈" },
  { value: "read-discrete-inputs", functionCode: 0x02, label: "02 读取离散输入" },
  { value: "read-holding-registers", functionCode: 0x03, label: "03 读取保持寄存器" },
  { value: "read-input-registers", functionCode: 0x04, label: "04 读取输入寄存器" },
  { value: "write-single-coil", functionCode: 0x05, label: "05 写单个线圈" },
  { value: "write-single-register", functionCode: 0x06, label: "06 写单个寄存器" },
  { value: "write-multiple-coils", functionCode: 0x0f, label: "0F 写多个线圈" },
  { value: "write-multiple-registers", functionCode: 0x10, label: "10 写多个寄存器" },
];

type ModbusRtuReadOperation =
  | "read-coils"
  | "read-discrete-inputs"
  | "read-holding-registers"
  | "read-input-registers";

export type ModbusRtuRequest =
  | {
      operation: ModbusRtuReadOperation;
      unitId: number;
      address: number;
      quantity: number;
    }
  | {
      operation: "write-single-coil";
      unitId: number;
      address: number;
      value: boolean;
    }
  | {
      operation: "write-single-register";
      unitId: number;
      address: number;
      value: number;
    }
  | {
      operation: "write-multiple-coils";
      unitId: number;
      address: number;
      values: readonly boolean[];
    }
  | {
      operation: "write-multiple-registers";
      unitId: number;
      address: number;
      values: readonly number[];
    };

export type ModbusRtuTransactionResult =
  | {
      kind: "bits";
      values: readonly boolean[];
    }
  | {
      kind: "registers";
      values: readonly number[];
    }
  | {
      kind: "write-confirmation";
      address: number;
      quantity: number;
    }
  | {
      kind: "broadcast";
    }
  | {
      kind: "exception";
      exceptionCode: number;
      exceptionName: string;
    };

export type ModbusRtuTransactionTerminalStatus =
  | "completed"
  | "exception"
  | "timeout"
  | "cancelled"
  | "error";

export interface ModbusRtuTransactionSnapshot {
  transactionId: number;
  generation: number;
  status: "idle" | "queued" | "waiting" | "cancelling";
  request: ModbusRtuRequest | null;
  requestFrame: Uint8Array;
  timeoutMs: number;
  queuedAt?: number;
  startedAt?: number;
  message: string;
}

export interface ModbusRtuTransactionRecord {
  transactionId: number;
  generation: number;
  status: ModbusRtuTransactionTerminalStatus;
  request: ModbusRtuRequest;
  requestHex: string;
  responseHex: string;
  result: ModbusRtuTransactionResult | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  errorCode?: string;
  message: string;
}

const MODBUS_EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  0x01: "非法功能",
  0x02: "非法数据地址",
  0x03: "非法数据值",
  0x04: "从站设备故障",
  0x05: "确认",
  0x06: "从站设备忙",
  0x08: "存储奇偶校验错误",
  0x0a: "网关路径不可用",
  0x0b: "网关目标设备无响应",
};

export function buildModbusRtuRequest(request: ModbusRtuRequest): Uint8Array {
  assertIntegerInRange(request.unitId, 0, MAX_MODBUS_RTU_UNIT_ID, "站号");
  assertIntegerInRange(request.address, 0, 0xffff, "地址");
  if (request.unitId === 0 && isReadOperation(request.operation)) {
    throw new Error("读取请求不能使用广播站号 0");
  }

  const functionCode = functionCodeForOperation(request.operation);
  const payload: number[] = [request.unitId, functionCode, ...encodeWord(request.address)];

  switch (request.operation) {
    case "read-coils":
    case "read-discrete-inputs":
      assertIntegerInRange(request.quantity, 1, MAX_MODBUS_READ_BITS, "读取数量");
      assertAddressRange(request.address, request.quantity);
      payload.push(...encodeWord(request.quantity));
      break;
    case "read-holding-registers":
    case "read-input-registers":
      assertIntegerInRange(request.quantity, 1, MAX_MODBUS_READ_REGISTERS, "读取数量");
      assertAddressRange(request.address, request.quantity);
      payload.push(...encodeWord(request.quantity));
      break;
    case "write-single-coil":
      if (typeof request.value !== "boolean") {
        throw new Error("线圈值必须是 0 或 1");
      }
      payload.push(request.value ? 0xff : 0x00, 0x00);
      break;
    case "write-single-register":
      assertIntegerInRange(request.value, 0, 0xffff, "寄存器值");
      payload.push(...encodeWord(request.value));
      break;
    case "write-multiple-coils": {
      assertArrayLength(request.values, MAX_MODBUS_WRITE_COILS, "线圈值");
      if (request.values.some((value) => typeof value !== "boolean")) {
        throw new Error("线圈值必须是 0 或 1");
      }
      assertAddressRange(request.address, request.values.length);
      const packedValues = packCoils(request.values);
      payload.push(...encodeWord(request.values.length), packedValues.length, ...packedValues);
      break;
    }
    case "write-multiple-registers":
      assertArrayLength(request.values, MAX_MODBUS_WRITE_REGISTERS, "寄存器值");
      request.values.forEach((value) => {
        assertIntegerInRange(value, 0, 0xffff, "寄存器值");
      });
      assertAddressRange(request.address, request.values.length);
      payload.push(...encodeWord(request.values.length), request.values.length * 2);
      request.values.forEach((value) => payload.push(...encodeWord(value)));
      break;
  }

  const bytesWithoutCrc = Uint8Array.from(payload);
  const crc = crc16modbus(bytesWithoutCrc);
  return Uint8Array.from([...bytesWithoutCrc, crc & 0xff, (crc >>> 8) & 0xff]);
}

export function parseModbusRtuResponse(
  request: ModbusRtuRequest,
  response: Uint8Array,
): ModbusRtuTransactionResult {
  if (request.unitId === 0) {
    if (isReadOperation(request.operation)) {
      throw new Error("读取请求不能使用广播站号 0");
    }
    if (response.length !== 0) {
      throw new Error("广播事务不应包含响应帧");
    }
    return { kind: "broadcast" };
  }
  if (response.length < 5 || response.length > 256) {
    throw new Error("Modbus 响应帧长度无效");
  }
  assertFrameCrc(response);
  if (response[0] !== request.unitId) {
    throw new Error("Modbus 响应站号与请求不一致");
  }

  const functionCode = functionCodeForOperation(request.operation);
  if (response[1] === (functionCode | 0x80)) {
    if (response.length !== 5) {
      throw new Error("Modbus 异常响应长度无效");
    }
    const exceptionCode = response[2] ?? 0;
    return {
      kind: "exception",
      exceptionCode,
      exceptionName: MODBUS_EXCEPTION_NAMES[exceptionCode] ?? "未知异常",
    };
  }
  if (response[1] !== functionCode) {
    throw new Error("Modbus 响应功能码与请求不一致");
  }

  switch (request.operation) {
    case "read-coils":
    case "read-discrete-inputs": {
      const byteCount = Math.ceil(request.quantity / 8);
      assertReadResponseLength(response, byteCount);
      const values = Array.from({ length: request.quantity }, (_, index) => {
        const packed = response[3 + Math.floor(index / 8)] ?? 0;
        return (packed & (1 << (index % 8))) !== 0;
      });
      return { kind: "bits", values };
    }
    case "read-holding-registers":
    case "read-input-registers": {
      const byteCount = request.quantity * 2;
      assertReadResponseLength(response, byteCount);
      const values = Array.from({ length: request.quantity }, (_, index) => {
        const offset = 3 + index * 2;
        return ((response[offset] ?? 0) << 8) | (response[offset + 1] ?? 0);
      });
      return { kind: "registers", values };
    }
    case "write-single-coil":
    case "write-single-register": {
      const expected = buildModbusRtuRequest(request);
      if (!equalBytes(response, expected)) {
        throw new Error("Modbus 写响应未正确回显请求");
      }
      return { kind: "write-confirmation", address: request.address, quantity: 1 };
    }
    case "write-multiple-coils":
    case "write-multiple-registers": {
      if (response.length !== 8) {
        throw new Error("Modbus 批量写响应长度无效");
      }
      const requestFrame = buildModbusRtuRequest(request);
      if (!equalBytes(response.slice(0, 6), requestFrame.slice(0, 6))) {
        throw new Error("Modbus 批量写响应地址或数量与请求不一致");
      }
      return {
        kind: "write-confirmation",
        address: request.address,
        quantity: request.values.length,
      };
    }
  }
}

export function simulateModbusRtuResponse(request: ModbusRtuRequest): Uint8Array | null {
  const requestFrame = buildModbusRtuRequest(request);
  if (request.unitId === 0) {
    return null;
  }
  const functionCode = functionCodeForOperation(request.operation);
  switch (request.operation) {
    case "read-coils":
    case "read-discrete-inputs": {
      const values = Array.from(
        { length: request.quantity },
        (_, index) => (request.address + index) % 3 === 0,
      );
      const packed = packCoils(values);
      return appendModbusCrc(Uint8Array.from([request.unitId, functionCode, packed.length, ...packed]));
    }
    case "read-holding-registers":
    case "read-input-registers": {
      const data = Array.from({ length: request.quantity }, (_, index) =>
        encodeWord((request.address + index) & 0xffff),
      ).flat();
      return appendModbusCrc(
        Uint8Array.from([request.unitId, functionCode, data.length, ...data]),
      );
    }
    case "write-single-coil":
    case "write-single-register":
      return requestFrame;
    case "write-multiple-coils":
    case "write-multiple-registers":
      return appendModbusCrc(requestFrame.slice(0, 6));
  }
}

export function cloneModbusRtuRequest(request: ModbusRtuRequest): ModbusRtuRequest {
  if (request.operation === "write-multiple-coils") {
    return { ...request, values: [...request.values] };
  }
  if (request.operation === "write-multiple-registers") {
    return { ...request, values: [...request.values] };
  }
  return { ...request };
}

export function createInitialModbusRtuTransactionSnapshot(): ModbusRtuTransactionSnapshot {
  return {
    transactionId: 0,
    generation: 0,
    status: "idle",
    request: null,
    requestFrame: new Uint8Array(),
    timeoutMs: DEFAULT_MODBUS_TRANSACTION_TIMEOUT_MS,
    message: "",
  };
}

export function formatModbusRtuFrame(frame: Uint8Array): string {
  return Array.from(frame, (value) => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function parseModbusUnsignedInteger(
  value: string,
  label: string,
  maximum = 0xffff,
  minimum = 0,
): number {
  const normalized = value.trim();
  if (
    normalized.length > MAX_MODBUS_INTEGER_TEXT_CHARACTERS ||
    !/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(normalized)
  ) {
    throw new Error(`${label}必须是 ${minimum}-${maximum} 的整数`);
  }
  const parsed = Number(normalized);
  assertIntegerInRange(parsed, minimum, maximum, label);
  return parsed;
}

export function parseModbusCoilValues(value: string): boolean[] {
  const tokens = splitValueTokens(value, "线圈值");
  if (tokens.length > MAX_MODBUS_WRITE_COILS) {
    throw new Error(`线圈值数量不能超过 ${MAX_MODBUS_WRITE_COILS}`);
  }
  return tokens.map((token) => {
    if (token !== "0" && token !== "1") {
      throw new Error("线圈值只接受 0 或 1");
    }
    return token === "1";
  });
}

export function parseModbusRegisterValues(value: string): number[] {
  const tokens = splitValueTokens(value, "寄存器值");
  if (tokens.length > MAX_MODBUS_WRITE_REGISTERS) {
    throw new Error(`寄存器值数量不能超过 ${MAX_MODBUS_WRITE_REGISTERS}`);
  }
  return tokens.map((token) => parseModbusUnsignedInteger(token, "寄存器值"));
}

function isReadOperation(operation: ModbusRtuOperation): operation is ModbusRtuReadOperation {
  return operation.startsWith("read-");
}

function functionCodeForOperation(operation: ModbusRtuOperation): number {
  const option = MODBUS_RTU_OPERATION_OPTIONS.find((candidate) => candidate.value === operation);
  if (!option) {
    throw new Error("不支持的 Modbus 功能码");
  }
  return option.functionCode;
}

function encodeWord(value: number): [number, number] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function packCoils(values: readonly boolean[]): number[] {
  const packed = Array.from({ length: Math.ceil(values.length / 8) }, () => 0);
  values.forEach((value, index) => {
    if (value) {
      const byteIndex = Math.floor(index / 8);
      packed[byteIndex] = (packed[byteIndex] ?? 0) | (1 << (index % 8));
    }
  });
  return packed;
}

function appendModbusCrc(payload: Uint8Array): Uint8Array {
  const crc = crc16modbus(payload);
  return Uint8Array.from([...payload, crc & 0xff, (crc >>> 8) & 0xff]);
}

function assertFrameCrc(frame: Uint8Array): void {
  const payload = frame.slice(0, -2);
  const expected = crc16modbus(payload);
  const actual = (frame[frame.length - 2] ?? 0) | ((frame[frame.length - 1] ?? 0) << 8);
  if (actual !== expected) {
    throw new Error("Modbus 响应 CRC 校验失败");
  }
}

function assertReadResponseLength(response: Uint8Array, expectedByteCount: number): void {
  if (response[2] !== expectedByteCount || response.length !== expectedByteCount + 5) {
    throw new Error("Modbus 读取响应字节数与请求不一致");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function splitValueTokens(value: string, label: string): string[] {
  if (value.length > MAX_MODBUS_VALUE_TEXT_CHARACTERS) {
    throw new Error(`${label}输入不能超过 ${MAX_MODBUS_VALUE_TEXT_CHARACTERS} 个字符`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label}不能为空`);
  }
  const groups = normalized.split(/[,;]/);
  if (groups.some((group) => !group.trim())) {
    throw new Error(`${label}不能包含空值`);
  }
  return groups.flatMap((group) => group.trim().split(/\s+/));
}

function assertArrayLength(values: readonly unknown[], maximum: number, label: string): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    throw new Error(`${label}数量必须是 1-${maximum}`);
  }
}

function assertAddressRange(address: number, quantity: number): void {
  if (address + quantity - 1 > 0xffff) {
    throw new Error("请求范围不能超过地址 65535");
  }
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}必须是 ${minimum}-${maximum} 的整数`);
  }
}
