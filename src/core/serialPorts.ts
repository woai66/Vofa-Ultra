import type { SerialPortInfo } from "../types/serial";

const PORT_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const MAX_DESCRIPTOR_LENGTH = 64;

export interface SerialPortPresentation {
  optionLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  kindLabel: string;
  usbIdentifier: string;
  hasUniqueUsbIdentity: boolean;
}

export function sortSerialPorts(ports: readonly SerialPortInfo[]): SerialPortInfo[] {
  return [...ports].sort((left, right) => PORT_NAME_COLLATOR.compare(left.name, right.name));
}

export function presentSerialPort(port: SerialPortInfo): SerialPortPresentation {
  const product = compactDescriptor(port.product);
  const manufacturer = compactDescriptor(port.manufacturer);
  const kindLabel = serialPortKindLabel(port.kind);
  const usbIdentifier = formatUsbIdentifier(port.vendorId, port.productId);
  const primaryLabel = product || manufacturer || `${kindLabel} 设备`;
  const secondaryLabel = product && manufacturer && product !== manufacturer ? manufacturer : "";
  const optionLabel = [port.name, product || manufacturer, usbIdentifier]
    .filter(Boolean)
    .join(" · ");

  return {
    optionLabel,
    primaryLabel,
    secondaryLabel,
    kindLabel,
    usbIdentifier,
    hasUniqueUsbIdentity:
      port.kind === "usb" &&
      usbIdentifier.length > 0 &&
      compactDescriptor(port.serialNumber).length > 0,
  };
}

function compactDescriptor(value: string | undefined): string {
  const compacted = value?.replace(/\s+/g, " ").trim() ?? "";
  if (compacted.length <= MAX_DESCRIPTOR_LENGTH) {
    return compacted;
  }
  return `${compacted.slice(0, MAX_DESCRIPTOR_LENGTH - 3)}...`;
}

function formatUsbIdentifier(vendorId: number | undefined, productId: number | undefined): string {
  const vendor = formatUsbWord(vendorId);
  const product = formatUsbWord(productId);
  return vendor && product ? `${vendor}:${product}` : "";
}

function formatUsbWord(value: number | undefined): string {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 0xffff
    ? value.toString(16).toUpperCase().padStart(4, "0")
    : "";
}

function serialPortKindLabel(kind: SerialPortInfo["kind"]): string {
  switch (kind) {
    case "usb":
      return "USB";
    case "bluetooth":
      return "蓝牙";
    case "pci":
      return "PCI";
    default:
      return "串口";
  }
}
