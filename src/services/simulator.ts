import { getProtocolDefinition } from "../core/protocols";
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

    const bytes = getProtocolDefinition(protocol).encodeSimulatorSample(values, sampleIndex);
    onData(bytes, Date.now());
    sampleIndex += 1;
  }, 40);

  return () => window.clearInterval(timer);
}
