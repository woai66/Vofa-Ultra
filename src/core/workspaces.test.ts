import { describe, expect, it } from "vitest";
import {
  areWorkspaceConfigsEqual,
  createDefaultWorkspaceConfig,
  createWorkspaceProfile,
  makeUniqueWorkspaceName,
  parseWorkspaceExport,
  restoreWorkspaceConfig,
  serializeWorkspace,
} from "./workspaces";

describe("工作区文件", () => {
  it("以严格的 v1 格式往返配置", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.serialConfig.portName = "COM7";
    config.protocol = "justfloat";
    config.sendMode = "hex";
    config.lineEnding = "crlf";
    config.channelVisibility = { "channel-2": false };
    const profile = createWorkspaceProfile("台架 A", config, "bench-a", 100);

    const parsed = parseWorkspaceExport(serializeWorkspace(profile));

    expect(parsed).toEqual({
      format: "vofa-ultra.workspace",
      schemaVersion: 1,
      name: "台架 A",
      config,
    });
    expect(parsed.config).not.toBe(config);
    expect(parsed.config.serialConfig).not.toBe(config.serialConfig);
  });

  it.each([
    ["错误格式", { format: "other", schemaVersion: 1 }],
    ["未知版本", { format: "vofa-ultra.workspace", schemaVersion: 2 }],
  ])("拒绝%s", (_label, overrides) => {
    const profile = createWorkspaceProfile(
      "默认工作区",
      createDefaultWorkspaceConfig("simulator"),
      "default",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;

    expect(() => parseWorkspaceExport(JSON.stringify({ ...exported, ...overrides }))).toThrow();
  });

  it("拒绝未知字段和越界串口参数", () => {
    const profile = createWorkspaceProfile(
      "默认工作区",
      createDefaultWorkspaceConfig("simulator"),
      "default",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    const serialConfig = config.serialConfig as Record<string, unknown>;

    expect(() =>
      parseWorkspaceExport(JSON.stringify({ ...exported, unexpected: true })),
    ).toThrow(/未知字段/);
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: { ...config, serialConfig: { ...serialConfig, baudRate: 0 } },
        }),
      ),
    ).toThrow(/波特率/);
  });

  it("把显式可见通道归一为默认值", () => {
    const profile = createWorkspaceProfile(
      "默认工作区",
      createDefaultWorkspaceConfig("simulator"),
      "default",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;

    const parsed = parseWorkspaceExport(
      JSON.stringify({
        ...exported,
        config: {
          ...config,
          channelVisibility: { "channel-0": true, "channel-1": false },
        },
      }),
    );

    expect(parsed.config.channelVisibility).toEqual({ "channel-1": false });
  });
});

describe("工作区本地恢复", () => {
  it("从旧版单工作区字段恢复，并对损坏字段使用默认值", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    const restored = restoreWorkspaceConfig(
      {
        source: "serial",
        protocol: "raw",
        serialConfig: {
          portName: "COM9",
          baudRate: 460_800,
          dataBits: 9,
          parity: "odd",
          stopBits: 2,
          flowControl: "hardware",
          dtr: false,
          rts: false,
        },
        displayMode: "hex",
        chartWindowSeconds: 22,
      },
      fallback,
    );

    expect(restored).toMatchObject({
      source: "serial",
      protocol: "raw",
      displayMode: "hex",
      chartWindowSeconds: 15,
      serialConfig: {
        portName: "COM9",
        baudRate: 460_800,
        dataBits: 8,
        parity: "odd",
        stopBits: 2,
        flowControl: "hardware",
        dtr: false,
        rts: false,
      },
    });
  });

  it("比较配置时忽略通道键顺序", () => {
    const left = createDefaultWorkspaceConfig("simulator");
    const right = createDefaultWorkspaceConfig("simulator");
    left.channelVisibility = { "channel-2": false, "channel-0": false };
    right.channelVisibility = { "channel-0": false, "channel-2": false };

    expect(areWorkspaceConfigsEqual(left, right)).toBe(true);
  });

  it("为导入的重名工作区生成稳定后缀", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    const workspaces = [
      createWorkspaceProfile("台架", config, "bench", 100),
      createWorkspaceProfile("台架 (2)", config, "bench-2", 100),
    ];

    expect(makeUniqueWorkspaceName("台架", workspaces)).toBe("台架 (3)");
  });
});
