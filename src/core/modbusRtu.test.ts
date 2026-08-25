import { describe, expect, it } from "vitest";
import crc16modbus from "crc/calculators/crc16modbus";
import {
  buildModbusRtuRequest,
  formatModbusRtuFrame,
  MAX_MODBUS_WRITE_COILS,
  MAX_MODBUS_WRITE_REGISTERS,
  parseModbusCoilValues,
  parseModbusRegisterValues,
  parseModbusRtuResponse,
  parseModbusUnsignedInteger,
  simulateModbusRtuResponse,
} from "./modbusRtu";

describe("Modbus RTU 构帧", () => {
  it("生成规范示例中的保持寄存器读取请求并按低字节在前附加 CRC", () => {
    const frame = buildModbusRtuRequest({
      operation: "read-holding-registers",
      unitId: 1,
      address: 0,
      quantity: 10,
    });

    expect(formatModbusRtuFrame(frame)).toBe("01 03 00 00 00 0A C5 CD");
  });

  it.each([
    ["read-coils", 0x0013, 0x0025, "11 01 00 13 00 25 0E 84"],
    ["read-discrete-inputs", 0x00c4, 0x0016, "11 02 00 C4 00 16 BA A9"],
    ["read-holding-registers", 0x006b, 0x0003, "11 03 00 6B 00 03 76 87"],
    ["read-input-registers", 0x0008, 0x0001, "11 04 00 08 00 01 B2 98"],
  ] as const)("为 %s 生成规范读取帧", (operation, address, quantity, expected) => {
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation,
          unitId: 0x11,
          address,
          quantity,
        }),
      ),
    ).toBe(expected);
  });

  it("生成单线圈和单寄存器写入规范示例", () => {
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation: "write-single-coil",
          unitId: 0x11,
          address: 0x00ac,
          value: true,
        }),
      ),
    ).toBe("11 05 00 AC FF 00 4E 8B");
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation: "write-single-register",
          unitId: 0x11,
          address: 1,
          value: 3,
        }),
      ),
    ).toBe("11 06 00 01 00 03 9A 9B");
  });

  it("按线圈低位优先和寄存器大端顺序生成多个值写入请求", () => {
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation: "write-multiple-coils",
          unitId: 0x11,
          address: 0x0013,
          values: [true, false, true, true, false, false, true, true, true, false],
        }),
      ),
    ).toBe("11 0F 00 13 00 0A 02 CD 01 BF 0B");
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation: "write-multiple-registers",
          unitId: 0x11,
          address: 1,
          values: [0x000a, 0x0102],
        }),
      ),
    ).toBe("11 10 00 01 00 02 04 00 0A 01 02 C6 F0");
  });

  it("允许写广播但拒绝没有响应语义的读广播", () => {
    expect(() =>
      buildModbusRtuRequest({
        operation: "read-coils",
        unitId: 0,
        address: 0,
        quantity: 1,
      }),
    ).toThrow("读取请求不能使用广播站号 0");
    expect(
      formatModbusRtuFrame(
        buildModbusRtuRequest({
          operation: "write-single-register",
          unitId: 0,
          address: 1,
          value: 2,
        }),
      ),
    ).toMatch(/^00 06 00 01 00 02/);
  });

  it("分别约束读位、读寄存器和批量写入的协议上限", () => {
    expect(() =>
      buildModbusRtuRequest({
        operation: "read-discrete-inputs",
        unitId: 1,
        address: 0,
        quantity: 2_001,
      }),
    ).toThrow("读取数量必须是 1-2000 的整数");
    expect(() =>
      buildModbusRtuRequest({
        operation: "read-input-registers",
        unitId: 1,
        address: 0,
        quantity: 126,
      }),
    ).toThrow("读取数量必须是 1-125 的整数");
    expect(() =>
      buildModbusRtuRequest({
        operation: "write-multiple-coils",
        unitId: 1,
        address: 0,
        values: Array.from({ length: MAX_MODBUS_WRITE_COILS + 1 }, () => false),
      }),
    ).toThrow("线圈值数量必须是 1-1968");
    expect(() =>
      buildModbusRtuRequest({
        operation: "write-multiple-registers",
        unitId: 1,
        address: 0,
        values: Array.from({ length: MAX_MODBUS_WRITE_REGISTERS + 1 }, () => 0),
      }),
    ).toThrow("寄存器值数量必须是 1-123");
  });

  it("拒绝会越过 16 位末地址的读写范围", () => {
    expect(() =>
      buildModbusRtuRequest({
        operation: "read-holding-registers",
        unitId: 1,
        address: 0xffff,
        quantity: 2,
      }),
    ).toThrow("请求范围不能超过地址 65535");
    expect(() =>
      buildModbusRtuRequest({
        operation: "write-multiple-coils",
        unitId: 1,
        address: 0xffff,
        values: [true, false],
      }),
    ).toThrow("请求范围不能超过地址 65535");
  });

  it("在最大合法批量请求下仍不超过 256 字节 RTU ADU", () => {
    const coils = buildModbusRtuRequest({
      operation: "write-multiple-coils",
      unitId: 247,
      address: 0,
      values: Array.from({ length: MAX_MODBUS_WRITE_COILS }, (_, index) => index % 2 === 0),
    });
    const registers = buildModbusRtuRequest({
      operation: "write-multiple-registers",
      unitId: 247,
      address: 0,
      values: Array.from({ length: MAX_MODBUS_WRITE_REGISTERS }, (_, index) => index),
    });

    expect(coils).toHaveLength(255);
    expect(registers).toHaveLength(255);
  });
});

describe("Modbus RTU 单事务响应", () => {
  it("解析位、寄存器和写确认并保持请求数量", () => {
    const bitRequest = {
      operation: "read-coils" as const,
      unitId: 1,
      address: 5,
      quantity: 10,
    };
    const registerRequest = {
      operation: "read-holding-registers" as const,
      unitId: 1,
      address: 10,
      quantity: 3,
    };
    const writeRequest = {
      operation: "write-multiple-registers" as const,
      unitId: 1,
      address: 20,
      values: [1, 2, 3],
    };

    expect(
      parseModbusRtuResponse(bitRequest, simulateModbusRtuResponse(bitRequest)!),
    ).toEqual({
      kind: "bits",
      values: [false, true, false, false, true, false, false, true, false, false],
    });
    expect(
      parseModbusRtuResponse(
        registerRequest,
        simulateModbusRtuResponse(registerRequest)!,
      ),
    ).toEqual({ kind: "registers", values: [10, 11, 12] });
    expect(
      parseModbusRtuResponse(writeRequest, simulateModbusRtuResponse(writeRequest)!),
    ).toEqual({ kind: "write-confirmation", address: 20, quantity: 3 });
  });

  it("解析标准异常响应并给未知异常保留稳定回退名称", () => {
    const request = {
      operation: "read-input-registers" as const,
      unitId: 0x11,
      address: 0,
      quantity: 1,
    };

    expect(parseModbusRtuResponse(request, responseFrame([0x11, 0x84, 0x02]))).toEqual({
      kind: "exception",
      exceptionCode: 2,
      exceptionName: "非法数据地址",
    });
    expect(parseModbusRtuResponse(request, responseFrame([0x11, 0x84, 0x7f]))).toEqual({
      kind: "exception",
      exceptionCode: 0x7f,
      exceptionName: "未知异常",
    });
  });

  it("拒绝 CRC、站号、字节数和写回显不匹配的响应", () => {
    const request = {
      operation: "read-holding-registers" as const,
      unitId: 1,
      address: 0,
      quantity: 1,
    };
    const badCrc = responseFrame([1, 3, 2, 0, 1]);
    badCrc[3] = (badCrc[3] ?? 0) ^ 1;

    expect(() => parseModbusRtuResponse(request, badCrc)).toThrow("CRC");
    expect(() =>
      parseModbusRtuResponse(request, responseFrame([2, 3, 2, 0, 1])),
    ).toThrow("站号");
    expect(() =>
      parseModbusRtuResponse(request, responseFrame([1, 3, 4, 0, 1, 0, 2])),
    ).toThrow("字节数");

    const writeRequest = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 2,
      value: 9,
    };
    expect(() =>
      parseModbusRtuResponse(writeRequest, responseFrame([1, 6, 0, 2, 0, 8])),
    ).toThrow("回显");
  });

  it("广播写入无响应即完成，并拒绝伪造响应", () => {
    const request = {
      operation: "write-single-coil" as const,
      unitId: 0,
      address: 1,
      value: true,
    };
    expect(parseModbusRtuResponse(request, new Uint8Array())).toEqual({ kind: "broadcast" });
    expect(() =>
      parseModbusRtuResponse(request, simulateModbusRtuResponse({ ...request, unitId: 1 })!),
    ).toThrow("不应包含响应帧");
  });
});

function responseFrame(payload: readonly number[]): Uint8Array {
  const bytes = Uint8Array.from(payload);
  const crc = crc16modbus(bytes);
  return Uint8Array.from([...bytes, crc & 0xff, (crc >>> 8) & 0xff]);
}

describe("Modbus RTU 输入解析", () => {
  it("接受十进制、十六进制以及逗号、分号或空白分隔", () => {
    expect(parseModbusUnsignedInteger(" 0x00AC ", "地址")).toBe(0x00ac);
    expect(parseModbusRegisterValues("10, 0x0102; 65535\n0")).toEqual([
      10,
      0x0102,
      0xffff,
      0,
    ]);
    expect(parseModbusCoilValues("1,0 1;1")).toEqual([true, false, true, true]);
  });

  it("拒绝小数、符号、空列表和非法线圈文本", () => {
    expect(() => parseModbusUnsignedInteger("1.5", "地址")).toThrow(
      "地址必须是 0-65535 的整数",
    );
    expect(() => parseModbusUnsignedInteger("-1", "地址")).toThrow(
      "地址必须是 0-65535 的整数",
    );
    expect(() => parseModbusUnsignedInteger("00000000000", "地址")).toThrow(
      "地址必须是 0-65535 的整数",
    );
    expect(() => parseModbusRegisterValues("  ")).toThrow("寄存器值不能为空");
    expect(() => parseModbusRegisterValues("1,,2")).toThrow("寄存器值不能包含空值");
    expect(() => parseModbusRegisterValues("1, ")).toThrow("寄存器值不能包含空值");
    expect(() => parseModbusCoilValues("1,ON,0")).toThrow("线圈值只接受 0 或 1");
  });
});
