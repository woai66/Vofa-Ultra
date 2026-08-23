import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "./workbenchStore";

describe("workbenchStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "disconnected",
      serialGeneration: 0,
      serialStateRevision: 0,
      statusMessage: "等待连接",
      channels: [],
    });
  });

  it("切换数据源时清空上一数据源的通道", async () => {
    useWorkbenchStore.setState({
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
    });

    await useWorkbenchStore.getState().setSource("serial");

    expect(useWorkbenchStore.getState().source).toBe("serial");
    expect(useWorkbenchStore.getState().channels).toEqual([]);
  });

  it("忽略迟到的串口状态事件", () => {
    useWorkbenchStore.setState({
      source: "serial",
      connectionStatus: "connected",
      serialStateRevision: 10,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 9,
    });
    expect(useWorkbenchStore.getState().connectionStatus).toBe("connected");

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      generation: 2,
      revision: 11,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialStateRevision: 11,
      statusMessage: "设备已移除",
    });
  });
});
