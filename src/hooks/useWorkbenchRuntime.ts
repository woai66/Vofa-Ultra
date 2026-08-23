import { useEffect } from "react";
import {
  getSerialState,
  isTauriRuntime,
  subscribeToSerialEvents,
} from "../services/serialClient";
import { startSimulator } from "../services/simulator";
import { useWorkbenchStore } from "../store/workbenchStore";

export function useWorkbenchRuntime(): void {
  const source = useWorkbenchStore((state) => state.source);
  const protocol = useWorkbenchStore((state) => state.protocol);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const setRuntimeAvailability = useWorkbenchStore((state) => state.setRuntimeAvailability);
  const refreshPorts = useWorkbenchStore((state) => state.refreshPorts);
  const ingestBytes = useWorkbenchStore((state) => state.ingestBytes);
  const handleSerialData = useWorkbenchStore((state) => state.handleSerialData);
  const handleSerialState = useWorkbenchStore((state) => state.handleSerialState);
  const handleSerialTx = useWorkbenchStore((state) => state.handleSerialTx);

  useEffect(() => {
    const nativeRuntime = isTauriRuntime();
    let cancelled = false;
    let dispose: () => void = () => undefined;
    setRuntimeAvailability(nativeRuntime);

    void subscribeToSerialEvents({
      onData: handleSerialData,
      onState: handleSerialState,
      onTx: handleSerialTx,
    })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }

        dispose = unlisten;
        if (nativeRuntime) {
          const snapshot = await getSerialState();
          if (!cancelled) {
            handleSerialState(snapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化串口事件监听失败", error);
      });

    if (nativeRuntime) {
      void refreshPorts();
    }

    return () => {
      cancelled = true;
      dispose();
    };
  }, [handleSerialData, handleSerialState, handleSerialTx, refreshPorts, setRuntimeAvailability]);

  useEffect(() => {
    if (source !== "simulator" || connectionStatus !== "connected") {
      return undefined;
    }
    return startSimulator(protocol, ingestBytes);
  }, [connectionStatus, ingestBytes, protocol, source]);
}
