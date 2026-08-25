import { useEffect, useMemo, useRef, useState } from "react";
import { FileInput, Network, X } from "lucide-react";
import {
  buildModbusRtuRequest,
  formatModbusRtuFrame,
  MAX_MODBUS_READ_BITS,
  MAX_MODBUS_READ_REGISTERS,
  MAX_MODBUS_RTU_UNIT_ID,
  MAX_MODBUS_VALUE_TEXT_CHARACTERS,
  MODBUS_RTU_OPERATION_OPTIONS,
  parseModbusCoilValues,
  parseModbusRegisterValues,
  parseModbusUnsignedInteger,
  type ModbusRtuOperation,
  type ModbusRtuRequest,
} from "../core/modbusRtu";

interface ModbusRtuBuilderProps {
  onApply(frame: Uint8Array): void;
  onClose(): void;
}

interface ModbusRtuPreview {
  frame: Uint8Array | null;
  hex: string;
  error: string;
  broadcast: boolean;
}

export function ModbusRtuBuilder({ onApply, onClose }: ModbusRtuBuilderProps) {
  const operationRef = useRef<HTMLSelectElement>(null);
  const [operation, setOperation] = useState<ModbusRtuOperation>("read-holding-registers");
  const [unitIdText, setUnitIdText] = useState("1");
  const [addressText, setAddressText] = useState("0");
  const [quantityText, setQuantityText] = useState("1");
  const [singleCoilValue, setSingleCoilValue] = useState(true);
  const [singleRegisterText, setSingleRegisterText] = useState("0");
  const [multipleCoilsText, setMultipleCoilsText] = useState("1, 0");
  const [multipleRegistersText, setMultipleRegistersText] = useState("0, 1");
  const preview = useMemo<ModbusRtuPreview>(() => {
    try {
      const request = createRequest({
        operation,
        unitIdText,
        addressText,
        quantityText,
        singleCoilValue,
        singleRegisterText,
        multipleCoilsText,
        multipleRegistersText,
      });
      const frame = buildModbusRtuRequest(request);
      return {
        frame,
        hex: formatModbusRtuFrame(frame),
        error: "",
        broadcast: request.unitId === 0,
      };
    } catch (error) {
      return {
        frame: null,
        hex: "",
        error: error instanceof Error ? error.message : String(error),
        broadcast: false,
      };
    }
  }, [
    addressText,
    multipleCoilsText,
    multipleRegistersText,
    operation,
    quantityText,
    singleCoilValue,
    singleRegisterText,
    unitIdText,
  ]);

  useEffect(() => {
    operationRef.current?.focus();
  }, []);

  const submit = () => {
    if (preview.frame) {
      onApply(preview.frame);
    }
  };

  const crc = preview.frame
    ? formatModbusRtuFrame(preview.frame.slice(preview.frame.length - 2))
    : "-- --";

  return (
    <form
      className="modbus-builder-popover"
      role="dialog"
      aria-label="Modbus RTU 构帧器"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="modbus-builder-header">
        <div>
          <Network size={15} />
          <strong>Modbus RTU</strong>
          <span>CRC16</span>
        </div>
        <button
          className="icon-button compact"
          type="button"
          aria-label="关闭 Modbus RTU 构帧器"
          title="关闭"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>

      <div className="modbus-builder-grid">
        <label className="modbus-field modbus-operation-field">
          <span>功能</span>
          <select
            ref={operationRef}
            id="modbus-operation"
            name="modbus-operation"
            aria-label="Modbus 功能"
            value={operation}
            onChange={(event) => setOperation(event.target.value as ModbusRtuOperation)}
          >
            {MODBUS_RTU_OPERATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="modbus-field">
          <span>站号</span>
          <input
            id="modbus-unit-id"
            name="modbus-unit-id"
            type="text"
            inputMode="numeric"
            aria-label="Modbus 站号"
            maxLength={5}
            value={unitIdText}
            onChange={(event) => setUnitIdText(event.target.value)}
          />
          <small>0-{MAX_MODBUS_RTU_UNIT_ID}</small>
        </label>

        <label className="modbus-field">
          <span>{isSingleWrite(operation) ? "地址" : "起始地址"}</span>
          <input
            id="modbus-address"
            name="modbus-address"
            type="text"
            inputMode="numeric"
            aria-label="Modbus 起始地址"
            maxLength={10}
            value={addressText}
            onChange={(event) => setAddressText(event.target.value)}
          />
          <small>0-based</small>
        </label>

        {isReadOperation(operation) && (
          <label className="modbus-field">
            <span>数量</span>
            <input
              id="modbus-quantity"
              name="modbus-quantity"
              type="text"
              inputMode="numeric"
              aria-label="Modbus 读取数量"
              maxLength={6}
              value={quantityText}
              onChange={(event) => setQuantityText(event.target.value)}
            />
            <small>
              1-
              {operation === "read-coils" || operation === "read-discrete-inputs"
                ? MAX_MODBUS_READ_BITS
                : MAX_MODBUS_READ_REGISTERS}
            </small>
          </label>
        )}

        {operation === "write-single-coil" && (
          <fieldset className="modbus-coil-field">
            <legend>线圈值</legend>
            <div className="segmented-control compact-segments" role="group" aria-label="单线圈值">
              <button
                type="button"
                data-active={!singleCoilValue}
                aria-pressed={!singleCoilValue}
                onClick={() => setSingleCoilValue(false)}
              >
                OFF
              </button>
              <button
                type="button"
                data-active={singleCoilValue}
                aria-pressed={singleCoilValue}
                onClick={() => setSingleCoilValue(true)}
              >
                ON
              </button>
            </div>
          </fieldset>
        )}

        {operation === "write-single-register" && (
          <label className="modbus-field">
            <span>寄存器值</span>
            <input
              id="modbus-register-value"
              name="modbus-register-value"
              type="text"
              inputMode="numeric"
              aria-label="Modbus 寄存器值"
              maxLength={10}
              value={singleRegisterText}
              onChange={(event) => setSingleRegisterText(event.target.value)}
            />
            <small>0-65535</small>
          </label>
        )}

        {operation === "write-multiple-coils" && (
          <label className="modbus-field modbus-values-field">
            <span>线圈值</span>
            <textarea
              id="modbus-coil-values"
              name="modbus-coil-values"
              aria-label="Modbus 多线圈值"
              rows={2}
              maxLength={MAX_MODBUS_VALUE_TEXT_CHARACTERS}
              spellCheck={false}
              placeholder="1, 0, 1, 1"
              value={multipleCoilsText}
              onChange={(event) => setMultipleCoilsText(event.target.value)}
            />
          </label>
        )}

        {operation === "write-multiple-registers" && (
          <label className="modbus-field modbus-values-field">
            <span>寄存器值</span>
            <textarea
              id="modbus-register-values"
              name="modbus-register-values"
              aria-label="Modbus 多寄存器值"
              rows={2}
              maxLength={MAX_MODBUS_VALUE_TEXT_CHARACTERS}
              spellCheck={false}
              placeholder="10, 0x0102"
              value={multipleRegistersText}
              onChange={(event) => setMultipleRegistersText(event.target.value)}
            />
          </label>
        )}
      </div>

      <div className="modbus-frame-preview" data-invalid={!preview.frame}>
        <div>
          <span>帧预览</span>
          <small>
            {preview.frame
              ? `${preview.frame.length} B · ${preview.broadcast ? "广播 · 无响应 · " : ""}CRC ${crc}`
              : "参数无效"}
          </small>
        </div>
        {preview.frame ? (
          <code aria-label="Modbus RTU 帧预览">{preview.hex}</code>
        ) : (
          <span className="modbus-builder-error" role="status">
            {preview.error}
          </span>
        )}
      </div>

      <footer className="modbus-builder-actions">
        <button className="primary-button" type="submit" disabled={!preview.frame}>
          <FileInput size={15} />
          填入发送框
        </button>
      </footer>
    </form>
  );
}

interface RequestDraft {
  operation: ModbusRtuOperation;
  unitIdText: string;
  addressText: string;
  quantityText: string;
  singleCoilValue: boolean;
  singleRegisterText: string;
  multipleCoilsText: string;
  multipleRegistersText: string;
}

function createRequest(draft: RequestDraft): ModbusRtuRequest {
  const unitId = parseModbusUnsignedInteger(
    draft.unitIdText,
    "站号",
    MAX_MODBUS_RTU_UNIT_ID,
  );
  const address = parseModbusUnsignedInteger(draft.addressText, "地址");

  switch (draft.operation) {
    case "read-coils":
    case "read-discrete-inputs":
      return {
        operation: draft.operation,
        unitId,
        address,
        quantity: parseModbusUnsignedInteger(
          draft.quantityText,
          "读取数量",
          MAX_MODBUS_READ_BITS,
          1,
        ),
      };
    case "read-holding-registers":
    case "read-input-registers":
      return {
        operation: draft.operation,
        unitId,
        address,
        quantity: parseModbusUnsignedInteger(
          draft.quantityText,
          "读取数量",
          MAX_MODBUS_READ_REGISTERS,
          1,
        ),
      };
    case "write-single-coil":
      return { operation: draft.operation, unitId, address, value: draft.singleCoilValue };
    case "write-single-register":
      return {
        operation: draft.operation,
        unitId,
        address,
        value: parseModbusUnsignedInteger(draft.singleRegisterText, "寄存器值"),
      };
    case "write-multiple-coils":
      return {
        operation: draft.operation,
        unitId,
        address,
        values: parseModbusCoilValues(draft.multipleCoilsText),
      };
    case "write-multiple-registers":
      return {
        operation: draft.operation,
        unitId,
        address,
        values: parseModbusRegisterValues(draft.multipleRegistersText),
      };
  }
}

function isReadOperation(operation: ModbusRtuOperation): boolean {
  return operation.startsWith("read-");
}

function isSingleWrite(operation: ModbusRtuOperation): boolean {
  return operation === "write-single-coil" || operation === "write-single-register";
}
