import { useEffect } from "react";
import { installAppCloseHandler } from "../services/appLifecycle";
import {
  getCaptureState,
  subscribeToCaptureEvents,
} from "../services/captureClient";
import {
  getCaptureExportState,
  subscribeToCaptureExportEvents,
} from "../services/captureExportClient";
import {
  getSerialState,
  getSerialFileSendState,
  isTauriRuntime,
  subscribeToSerialEvents,
} from "../services/serialClient";
import {
  getReplayMarkers,
  getReplayState,
  subscribeToReplayEvents,
} from "../services/replayClient";
import {
  getNumericLogState,
  subscribeToNumericLogEvents,
} from "../services/numericLogClient";
import { startSimulator } from "../services/simulator";
import {
  disposeWorkbenchRuntime,
  prepareWorkbenchForAppClose,
  useWorkbenchStore,
} from "../store/workbenchStore";

export function useWorkbenchRuntime(): void {
  const source = useWorkbenchStore((state) => state.source);
  const protocol = useWorkbenchStore((state) => state.protocol);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const setRuntimeAvailability = useWorkbenchStore((state) => state.setRuntimeAvailability);
  const initializeExtensionRuntime = useWorkbenchStore(
    (state) => state.initializeExtensionRuntime,
  );
  const refreshPorts = useWorkbenchStore((state) => state.refreshPorts);
  const ingestBytes = useWorkbenchStore((state) => state.ingestBytes);
  const handleSerialData = useWorkbenchStore((state) => state.handleSerialData);
  const handleSerialState = useWorkbenchStore((state) => state.handleSerialState);
  const handleSerialTx = useWorkbenchStore((state) => state.handleSerialTx);
  const handleSerialFileSend = useWorkbenchStore((state) => state.handleSerialFileSend);
  const handleModbusTransaction = useWorkbenchStore((state) => state.handleModbusTransaction);
  const handleCaptureState = useWorkbenchStore((state) => state.handleCaptureState);
  const handleNumericLogState = useWorkbenchStore((state) => state.handleNumericLogState);
  const handleCaptureExportState = useWorkbenchStore(
    (state) => state.handleCaptureExportState,
  );
  const handleReplayState = useWorkbenchStore((state) => state.handleReplayState);
  const handleReplayBatch = useWorkbenchStore((state) => state.handleReplayBatch);
  const handleReplayMarkers = useWorkbenchStore((state) => state.handleReplayMarkers);

  useEffect(() => {
    let cancelled = false;
    let dispose: () => void = () => undefined;

    void installAppCloseHandler(prepareWorkbenchForAppClose)
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
      })
      .catch((error: unknown) => {
        console.error("初始化应用关闭监听失败", error);
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    const nativeRuntime = isTauriRuntime();
    let cancelled = false;
    let dispose: () => void = () => undefined;
    setRuntimeAvailability(nativeRuntime);

    void subscribeToSerialEvents({
      onData: handleSerialData,
      onState: handleSerialState,
      onTx: handleSerialTx,
      onFileSend: handleSerialFileSend,
      onModbusTransaction: handleModbusTransaction,
    })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }

        dispose = unlisten;
        if (nativeRuntime) {
          const [snapshot, fileSendSnapshot] = await Promise.all([
            getSerialState(),
            getSerialFileSendState(),
          ]);
          if (!cancelled) {
            handleSerialState(snapshot);
            handleSerialFileSend(fileSendSnapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化串口事件监听失败", error);
      });

    if (nativeRuntime) {
      void refreshPorts();
      void initializeExtensionRuntime();
    }

    return () => {
      cancelled = true;
      disposeWorkbenchRuntime();
      dispose();
    };
  }, [
    handleSerialData,
    handleSerialFileSend,
    handleModbusTransaction,
    handleSerialState,
    handleSerialTx,
    initializeExtensionRuntime,
    refreshPorts,
    setRuntimeAvailability,
  ]);

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

    void subscribeToNumericLogEvents({ onState: handleNumericLogState })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
        if (isTauriRuntime()) {
          const snapshot = await getNumericLogState();
          if (!cancelled) {
            handleNumericLogState(snapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化数值记录状态监听失败", error);
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [handleNumericLogState]);

  useEffect(() => {
    let cancelled = false;
    let dispose: () => void = () => undefined;

    void subscribeToCaptureExportEvents({ onState: handleCaptureExportState })
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        dispose = unlisten;
        if (isTauriRuntime()) {
          const snapshot = await getCaptureExportState();
          if (!cancelled) {
            handleCaptureExportState(snapshot);
          }
        }
      })
      .catch((error: unknown) => {
        console.error("初始化捕获导出状态监听失败", error);
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [handleCaptureExportState]);

  useEffect(() => {
    let cancelled = false;
    let dispose: () => void = () => undefined;

    void subscribeToReplayEvents({
      onState: handleReplayState,
      onBatch: handleReplayBatch,
      onMarkers: handleReplayMarkers,
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
            if (snapshot.sessionId > 0 && snapshot.status !== "idle") {
              try {
                const markers = await getReplayMarkers(snapshot.sessionId);
                if (!cancelled) {
                  handleReplayMarkers(markers);
                }
              } catch (error) {
                const replay = useWorkbenchStore.getState();
                if (
                  !cancelled &&
                  replay.replaySessionId === snapshot.sessionId &&
                  replay.replayStatus !== "idle"
                ) {
                  console.error("初始化回放标记失败", error);
                }
              }
            }
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
  }, [handleReplayBatch, handleReplayMarkers, handleReplayState]);

  useEffect(() => {
    if (source !== "simulator" || connectionStatus !== "connected") {
      return undefined;
    }
    return startSimulator(protocol, ingestBytes);
  }, [connectionStatus, ingestBytes, protocol, source]);
}
