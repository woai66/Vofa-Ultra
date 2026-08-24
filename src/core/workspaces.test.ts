import { describe, expect, it } from "vitest";
import compatibilityPolicy from "../../compatibility-policy.json";
import {
  areWorkspaceConfigsEqual,
  createDefaultWorkspaceConfig,
  createWorkspaceProfile,
  MAX_WORKSPACE_FILE_BYTES,
  makeUniqueWorkspaceName,
  parseWorkspaceExport,
  restoreWorkspaceConfig,
  serializeWorkspace,
  WORKSPACE_FILE_FORMAT,
  WORKSPACE_READABLE_SCHEMA_VERSIONS,
  WORKSPACE_SCHEMA_VERSION,
} from "./workspaces";
import { createDefaultAutoResponderRule } from "./autoResponder";
import { PROTOCOL_IDS } from "../types/serial";

describe("工作区文件", () => {
  it("与公开兼容性清单保持一致", () => {
    expect(Object.keys(compatibilityPolicy).sort()).toEqual([
      "capture",
      "deprecation",
      "localStorage",
      "protocols",
      "schemaVersion",
      "workspace",
    ]);
    expect(compatibilityPolicy.schemaVersion).toBe(2);
    expect(compatibilityPolicy.workspace).toEqual({
      fileFormat: WORKSPACE_FILE_FORMAT,
      writeVersion: WORKSPACE_SCHEMA_VERSION,
      readVersions: [...WORKSPACE_READABLE_SCHEMA_VERSIONS],
      futureVersionBehavior: "reject",
    });
    expect(compatibilityPolicy.protocols).toEqual({
      stableWireIds: [...PROTOCOL_IDS],
      wireIdEvolution: "append-only",
      runtimePluginAbi: {
        identifier: "vux-wasm-v1-experimental",
        status: "experimental",
        packageFormat: "vofa-ultra-extension",
        schemaVersion: 1,
        apiVersion: 1,
        futureVersionBehavior: "reject",
      },
    });
    expect(Object.keys(compatibilityPolicy.capture).sort()).toEqual([
      "fileFormat",
      "futureVersionBehavior",
      "readVersions",
      "writeVersion",
    ]);
    expect(compatibilityPolicy.deprecation).toEqual({
      minimumNoticeMinorReleases: 2,
      minimumNoticeDays: 90,
      removalRelease: "major-only",
    });
  });

  it("以严格的 v4 格式往返处理图、姿态与自动应答配置", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.serialConfig.portName = "COM7";
    config.protocol = "justfloat";
    config.sendMode = "hex";
    config.lineEnding = "crlf";
    config.channelVisibility = { "channel-2": false };
    config.processingGraph = {
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "output",
          kind: "output",
          input: "source",
          name: "Filtered",
          color: "#46d89c",
        },
      ],
    };
    config.attitudeConfig.channels.roll = "channel-0";
    config.attitudeConfig.channels.pitch = "channel-1";
    config.attitudeConfig.channels.yaw = "derived:output";
    config.autoResponderRules = [createDefaultAutoResponderRule("ready", "设备就绪")];
    const profile = createWorkspaceProfile("台架 A", config, "bench-a", 100);

    const parsed = parseWorkspaceExport(serializeWorkspace(profile));

    expect(parsed).toEqual({
      format: "vofa-ultra.workspace",
      schemaVersion: 4,
      name: "台架 A",
      config,
    });
    expect(parsed.config).not.toBe(config);
    expect(parsed.config.serialConfig).not.toBe(config.serialConfig);
    expect(parsed.config.processingGraph).not.toBe(config.processingGraph);
    expect(parsed.config.attitudeConfig).not.toBe(config.attitudeConfig);
    expect(parsed.config.attitudeConfig.channels).not.toBe(config.attitudeConfig.channels);
    expect(parsed.config.autoResponderRules).not.toBe(config.autoResponderRules);
  });

  it("导入严格 v1 后规范化为禁用处理图和空姿态映射", () => {
    const profile = createWorkspaceProfile(
      "旧工作区",
      createDefaultWorkspaceConfig("simulator"),
      "legacy",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    delete config.processingGraph;
    delete config.attitudeConfig;
    delete config.autoResponderRules;
    exported.schemaVersion = 1;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.config.processingGraph).toEqual({ enabled: false, nodes: [] });
    expect(parsed.config.attitudeConfig.channels).toEqual({
      roll: "",
      pitch: "",
      yaw: "",
      w: "",
      x: "",
      y: "",
      z: "",
    });
    expect(parsed.config.autoResponderRules).toEqual([]);
  });

  it("导入严格 v2 后保留处理图并补充默认姿态配置", () => {
    const profile = createWorkspaceProfile(
      "v2 工作区",
      createDefaultWorkspaceConfig("simulator"),
      "legacy-v2",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    delete config.attitudeConfig;
    delete config.autoResponderRules;
    exported.schemaVersion = 2;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.config.processingGraph).toEqual({ enabled: false, nodes: [] });
    expect(parsed.config.attitudeConfig.inputMode).toBe("euler");
    expect(parsed.config.autoResponderRules).toEqual([]);
  });

  it("导入严格 v3 后保留姿态配置并补充空自动应答规则", () => {
    const profile = createWorkspaceProfile(
      "v3 工作区",
      createDefaultWorkspaceConfig("simulator"),
      "legacy-v3",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    delete config.autoResponderRules;
    exported.schemaVersion = 3;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.config.attitudeConfig.inputMode).toBe("euler");
    expect(parsed.config.autoResponderRules).toEqual([]);
  });

  it("严格校验 v4 姿态字段及其派生通道引用", () => {
    const profile = createWorkspaceProfile(
      "姿态工作区",
      createDefaultWorkspaceConfig("simulator"),
      "attitude",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    const attitudeConfig = config.attitudeConfig as Record<string, unknown>;
    const channels = attitudeConfig.channels as Record<string, unknown>;

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            attitudeConfig: { ...attitudeConfig, rotationOrder: "zyx" },
          },
        }),
      ),
    ).toThrow(/未知字段/);
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            attitudeConfig: {
              ...attitudeConfig,
              channels: { ...channels, roll: "derived:missing" },
            },
          },
        }),
      ),
    ).toThrow(/未知派生通道/);
  });

  it.each([
    ["错误格式", { format: "other", schemaVersion: 1 }],
    ["未知版本", { format: "vofa-ultra.workspace", schemaVersion: 5 }],
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
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({ ...exported, config: { ...config, protocol: "future-protocol" } }),
      ),
    ).toThrow(/协议/);
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

  it("拒绝含循环或未知字段的处理图", () => {
    const profile = createWorkspaceProfile(
      "默认工作区",
      createDefaultWorkspaceConfig("simulator"),
      "default",
      100,
    );
    const exported = JSON.parse(serializeWorkspace(profile)) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            processingGraph: {
              enabled: true,
              nodes: [
                { id: "a", kind: "affine", input: "b", gain: 1, offset: 0 },
                { id: "b", kind: "affine", input: "a", gain: 1, offset: 0 },
              ],
            },
          },
        }),
      ),
    ).toThrow(/循环/);
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            processingGraph: { enabled: false, nodes: [], script: "return value" },
          },
        }),
      ),
    ).toThrow(/未知字段/);
  });

  it("最大合法自动应答配置仍可导出并重新导入", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.autoResponderRules = Array.from({ length: 16 }, (_, index) => ({
      ...createDefaultAutoResponderRule(`rule-${index + 1}`, `规则 ${index + 1}`),
      triggerMode: "text" as const,
      trigger: "\0".repeat(256),
      response: "\0".repeat(4 * 1024),
    }));
    const serialized = serializeWorkspace(
      createWorkspaceProfile("满容量规则", config, "full-rules", 100),
    );

    const serializedBytes = new TextEncoder().encode(serialized).byteLength;
    expect(serializedBytes).toBeGreaterThan(128 * 1024);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_WORKSPACE_FILE_BYTES);
    expect(parseWorkspaceExport(serialized).config.autoResponderRules).toEqual(
      config.autoResponderRules,
    );
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

  it("未知协议恢复为显式 fallback", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    fallback.protocol = "justfloat";

    expect(restoreWorkspaceConfig({ protocol: "future-protocol" }, fallback).protocol).toBe(
      "justfloat",
    );
  });

  it("比较配置时忽略通道键顺序", () => {
    const left = createDefaultWorkspaceConfig("simulator");
    const right = createDefaultWorkspaceConfig("simulator");
    left.channelVisibility = { "channel-2": false, "channel-0": false };
    right.channelVisibility = { "channel-0": false, "channel-2": false };

    expect(areWorkspaceConfigsEqual(left, right)).toBe(true);

    right.autoResponderRules = [createDefaultAutoResponderRule("rule-1")];
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
    right.autoResponderRules = [];
    right.processingGraph.enabled = true;
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
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
