import crc16modbus from "crc/calculators/crc16modbus";

export const MAX_MODBUS_RTU_UNIT_ID = 247;
export const MAX_MODBUS_READ_BITS = 2_000;
export const MAX_MODBUS_READ_REGISTERS = 125;
export const MAX_MODBUS_WRITE_COILS = 1_968;
export const MAX_MODBUS_WRITE_REGISTERS = 123;
export const MAX_MODBUS_VALUE_TEXT_CHARACTERS = 8_192;
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
