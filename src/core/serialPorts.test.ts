import { describe, expect, it } from "vitest";
import type { SerialPortInfo } from "../types/serial";
import { presentSerialPort, sortSerialPorts } from "./serialPorts";

describe("serialPorts", () => {
  it("按端口名自然排序且不修改输入列表", () => {
    const ports: SerialPortInfo[] = [
      { name: "COM10", kind: "usb", product: "Adapter B" },
      { name: "COM2", kind: "usb", product: "Adapter A" },
      { name: "COM1", kind: "pci" },
    ];

    expect(sortSerialPorts(ports).map((port) => port.name)).toEqual(["COM1", "COM2", "COM10"]);
    expect(ports.map((port) => port.name)).toEqual(["COM10", "COM2", "COM1"]);
  });

  it("显示产品、厂商和 USB 标识但不泄露完整序列号", () => {
    const presentation = presentSerialPort({
      name: "COM7",
      kind: "usb",
      manufacturer: "  Acme   Devices  ",
      product: "Telemetry Adapter",
      serialNumber: "PRIVATE-SERIAL-001",
      vendorId: 0x123,
      productId: 0xabcd,
    });

    expect(presentation).toEqual({
      optionLabel: "COM7 · Telemetry Adapter · 0123:ABCD",
      primaryLabel: "Telemetry Adapter",
      secondaryLabel: "Acme Devices",
      kindLabel: "USB",
      usbIdentifier: "0123:ABCD",
      hasUniqueUsbIdentity: true,
    });
    expect(JSON.stringify(presentation)).not.toContain("PRIVATE-SERIAL-001");
  });

  it("缺少完整 USB 标识时不宣称唯一身份", () => {
    expect(presentSerialPort({
      name: "/dev/ttyUSB0",
      kind: "usb",
      serialNumber: "SERIAL",
      vendorId: 0x1234,
    })).toMatchObject({
      optionLabel: "/dev/ttyUSB0",
      primaryLabel: "USB 设备",
      usbIdentifier: "",
      hasUniqueUsbIdentity: false,
    });
  });

  it("限制设备描述长度以避免异常固件描述撑开布局", () => {
    const presentation = presentSerialPort({
      name: "COM8",
      kind: "usb",
      product: "X".repeat(100),
    });

    expect(presentation.primaryLabel).toHaveLength(64);
    expect(presentation.primaryLabel).toMatch(/\.\.\.$/);
    expect(presentation.optionLabel).toBe(`COM8 · ${presentation.primaryLabel}`);
  });
});
