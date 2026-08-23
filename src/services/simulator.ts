import { encodeFireWaterFrame, encodeJustFloatFrame } from "../core/protocols";
import type { ProtocolKind } from "../types/serial";

export function startSimulator(
  protocol: ProtocolKind,
  onData: (bytes: Uint8Array, timestamp: number) => void,
): () => void {
  const startedAt = performance.now();
  let sampleIndex = 0;

  const timer = window.setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1_000;
    const values = [
      Math.sin(elapsed * Math.PI * 1.2) * 3.2 + 12,
      Math.cos(elapsed * Math.PI * 0.72) * 2.1 + 7,
      9 + Math.sin(elapsed * Math.PI * 0.22) * 1.4 + Math.sin(sampleIndex * 0.91) * 0.12,
    ];

    let bytes: Uint8Array;
    if (protocol === "justfloat") {
      bytes = encodeJustFloatFrame(values);
    } else if (protocol === "firewater") {
      bytes = encodeFireWaterFrame(values);
    } else {
      bytes = new TextEncoder().encode(
        `sample=${sampleIndex.toString().padStart(5, "0")} temp=${values[0]?.toFixed(2)} ` +
          `voltage=${values[1]?.toFixed(2)} load=${values[2]?.toFixed(2)}\n`,
      );
    }

    onData(bytes, Date.now());
    sampleIndex += 1;
  }, 40);

  return () => window.clearInterval(timer);
}
