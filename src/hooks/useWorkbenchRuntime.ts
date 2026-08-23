import { useEffect } from "react";
import {
  getCaptureState,
  subscribeToCaptureEvents,
} from "../services/captureClient";
import {
  getSerialState,
  isTauriRuntime,
  subscribeToSerialEvents,
} from "../services/serialClient";
import {
  getReplayState,
  subscribeToReplayEvents,
} from "../services/replayClient";
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
  const handleCaptureState = useWorkbenchStore((state) => state.handleCaptureState);
  const handleReplayState = useWorkbenchStore((state) => state.handleReplayState);
  const handleReplayBatch = useWorkbenchStore((state) => state.handleReplayBatch);

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
    let cancelled = false;
    let dispose: () => void = () => undefined;

    void subscribeToCaptureEvents({ onState: handleCaptureState })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
        if (isTauriRuntime()) {
          const snapshot = await getCaptureState();
          if (!cancelled) {
            handleCaptureState(snapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化捕获状态监听失败", error);
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [handleCaptureState]);

  useEffect(() => {
    let cancelled = false;
    let dispose: () => void = () => undefined;

    void subscribeToReplayEvents({
      onState: handleReplayState,
      onBatch: handleReplayBatch,
    })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
        if (isTauriRuntime()) {
          const snapshot = await getReplayState();
          if (!cancelled) {
            handleReplayState(snapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化回放事件监听失败", error);
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [handleReplayBatch, handleReplayState]);

  useEffect(() => {
    if (source !== "simulator" || connectionStatus !== "connected") {
      return undefined;
    }
    return startSimulator(protocol, ingestBytes);
  }, [connectionStatus, ingestBytes, protocol, source]);
}
