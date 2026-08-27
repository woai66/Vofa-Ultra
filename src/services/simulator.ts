import { getProtocolDefinition } from "../core/protocols";
import { generateSimulatorValues, parseSimulatorConfig } from "../core/simulator";
import type { ProtocolKind } from "../types/serial";
import type { SimulatorConfig } from "../types/simulator";

export function startSimulator(
  protocol: ProtocolKind,
  config: SimulatorConfig,
  onData: (bytes: Uint8Array, timestamp: number) => void,
): () => void {
  const frozenConfig = parseSimulatorConfig(config);
  let sampleIndex = 0;

  const timer = window.setInterval(() => {
    const values = generateSimulatorValues(frozenConfig, sampleIndex);
    const bytes = getProtocolDefinition(protocol).encodeSimulatorSample(values, sampleIndex);
    onData(bytes, Date.now());
    sampleIndex += 1;
  }, 1_000 / frozenConfig.sampleRate);

  return () => window.clearInterval(timer);
}
