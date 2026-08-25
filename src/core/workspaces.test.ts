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

function removeCurrentTerminalRxFields(config: Record<string, unknown>): void {
  delete config.terminalRxRecordMode;
  delete config.terminalRxLineEnding;
  delete config.terminalRxTextEncoding;
}

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

  it("以严格的 v8 格式往返终端行聚合、文本编码及完整工作区配置", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.serialConfig.portName = "COM7";
    config.protocol = "justfloat";
    config.sendMode = "hex";
    config.lineEnding = "cr";
    config.terminalRxRecordMode = "line";
    config.terminalRxLineEnding = "crlf";
    config.terminalRxTextEncoding = "gb18030";
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
    config.autoResponderRules[0]!.lineEnding = "cr";
    config.quickCommands = [
      {
        id: "quick-status",
        name: "查询状态",
        template: "STATUS?",
        mode: "text",
        lineEnding: "cr",
      },
    ];
    const profile = createWorkspaceProfile("台架 A", config, "bench-a", 100);

    const parsed = parseWorkspaceExport(serializeWorkspace(profile));

    expect(parsed).toEqual({
      format: "vofa-ultra.workspace",
      schemaVersion: 8,
      name: "台架 A",
      config,
    });
    expect(parsed.config).not.toBe(config);
    expect(parsed.config.serialConfig).not.toBe(config.serialConfig);
    expect(parsed.config.processingGraph).not.toBe(config.processingGraph);
    expect(parsed.config.attitudeConfig).not.toBe(config.attitudeConfig);
    expect(parsed.config.attitudeConfig.channels).not.toBe(config.attitudeConfig.channels);
    expect(parsed.config.autoResponderRules).not.toBe(config.autoResponderRules);
    expect(parsed.config.quickCommands).not.toBe(config.quickCommands);
    expect(parsed.config.quickCommands[0]).not.toBe(config.quickCommands[0]);
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
    removeCurrentTerminalRxFields(config);
    delete config.processingGraph;
    delete config.attitudeConfig;
    delete config.autoResponderRules;
    delete config.quickCommands;
    exported.schemaVersion = 1;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
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
    expect(parsed.config.quickCommands).toEqual([]);
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
    removeCurrentTerminalRxFields(config);
    delete config.attitudeConfig;
    delete config.autoResponderRules;
    delete config.quickCommands;
    exported.schemaVersion = 2;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config.processingGraph).toEqual({ enabled: false, nodes: [] });
    expect(parsed.config.attitudeConfig.inputMode).toBe("euler");
    expect(parsed.config.autoResponderRules).toEqual([]);
    expect(parsed.config.quickCommands).toEqual([]);
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
    removeCurrentTerminalRxFields(config);
    delete config.autoResponderRules;
    delete config.quickCommands;
    exported.schemaVersion = 3;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config.attitudeConfig.inputMode).toBe("euler");
    expect(parsed.config.autoResponderRules).toEqual([]);
    expect(parsed.config.quickCommands).toEqual([]);
  });

  it("导入严格 v4 后保留自动应答并补充空快捷命令", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.autoResponderRules = [createDefaultAutoResponderRule("ready", "设备就绪")];
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v4 工作区", config, "legacy-v4", 100)),
    ) as Record<string, unknown>;
    const exportedConfig = exported.config as Record<string, unknown>;
    removeCurrentTerminalRxFields(exportedConfig);
    delete exportedConfig.quickCommands;
    exported.schemaVersion = 4;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config.autoResponderRules).toEqual(config.autoResponderRules);
    expect(parsed.config.quickCommands).toEqual([]);
  });

  it("导入严格 v5 后无损迁移为 v8", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.lineEnding = "crlf";
    config.autoResponderRules = [createDefaultAutoResponderRule("legacy-rule")];
    config.autoResponderRules[0]!.lineEnding = "lf";
    config.quickCommands = [
      {
        id: "legacy-quick",
        name: "旧快捷命令",
        template: "STATUS?",
        mode: "text",
        lineEnding: "crlf",
      },
    ];
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v5 工作区", config, "legacy-v5", 100)),
    ) as Record<string, unknown>;
    removeCurrentTerminalRxFields(exported.config as Record<string, unknown>);
    exported.schemaVersion = 5;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config).toEqual(config);
  });

  it("导入严格 v6 后补充默认接收记录方式与行尾", () => {
    const config = createDefaultWorkspaceConfig("serial");
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v6 工作区", config, "legacy-v6", 100)),
    ) as Record<string, unknown>;
    removeCurrentTerminalRxFields(exported.config as Record<string, unknown>);
    exported.schemaVersion = 6;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config).toMatchObject({
      terminalRxRecordMode: "chunk",
      terminalRxLineEnding: "lf",
      terminalRxTextEncoding: "utf-8",
    });
  });

  it("导入严格 v7 后补充默认 UTF-8 接收编码", () => {
    const config = createDefaultWorkspaceConfig("serial");
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v7 工作区", config, "legacy-v7", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).terminalRxTextEncoding;
    exported.schemaVersion = 7;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.config.terminalRxTextEncoding).toBe("utf-8");
  });

  it.each([1, 2, 3, 4, 5] as const)("v%d 顶层行尾仍拒绝 CR", (schemaVersion) => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile(
          `v${schemaVersion} 工作区`,
          createDefaultWorkspaceConfig("simulator"),
          `legacy-v${schemaVersion}`,
          100,
        ),
      ),
    ) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;
    removeCurrentTerminalRxFields(config);
    config.lineEnding = "cr";
    if (schemaVersion < 5) {
      delete config.quickCommands;
    }
    if (schemaVersion < 4) {
      delete config.autoResponderRules;
    }
    if (schemaVersion < 3) {
      delete config.attitudeConfig;
    }
    if (schemaVersion < 2) {
      delete config.processingGraph;
    }
    exported.schemaVersion = schemaVersion;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/行尾/);
  });

  it.each([
    [4, "autoResponderRules"],
    [5, "autoResponderRules"],
    [5, "quickCommands"],
  ] as const)("v%d 的历史 %s 行尾仍拒绝 CR", (schemaVersion, field) => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.autoResponderRules = [createDefaultAutoResponderRule("legacy-rule")];
    config.quickCommands = [
      {
        id: "legacy-quick",
        name: "旧快捷命令",
        template: "PING",
        mode: "text",
        lineEnding: "none",
      },
    ];
    if (field === "autoResponderRules") {
      config.autoResponderRules[0]!.lineEnding = "cr";
    } else {
      config.quickCommands[0]!.lineEnding = "cr";
    }
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("历史工作区", config, "legacy", 100)),
    ) as Record<string, unknown>;
    removeCurrentTerminalRxFields(exported.config as Record<string, unknown>);
    if (schemaVersion === 4) {
      delete (exported.config as Record<string, unknown>).quickCommands;
    }
    exported.schemaVersion = schemaVersion;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/行尾/);
  });

  it("严格校验 v8 姿态字段、快捷命令、接收配置及派生通道引用", () => {
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
          config: { ...config, terminalRxRecordMode: "packet" },
        }),
      ),
    ).toThrow(/接收记录方式/);
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: { ...config, terminalRxLineEnding: "none" },
        }),
      ),
    ).toThrow(/接收行尾/);
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: { ...config, terminalRxTextEncoding: "big5" },
        }),
      ),
    ).toThrow(/接收文本编码/);
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
    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            quickCommands: [
              {
                id: "quick-1",
                name: "危险字段",
                template: "PING",
                mode: "text",
                lineEnding: "none",
                script: "send()",
              },
            ],
          },
        }),
      ),
    ).toThrow(/未知字段/);
  });

  it.each([
    ["错误格式", { format: "other", schemaVersion: 1 }],
    ["未知版本", { format: "vofa-ultra.workspace", schemaVersion: 9 }],
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

  it("最大合法自动应答与最坏 JSON 转义快捷命令仍可导出并重新导入", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.autoResponderRules = Array.from({ length: 16 }, (_, index) => ({
      ...createDefaultAutoResponderRule(`rule-${index + 1}`, `规则 ${index + 1}`),
      triggerMode: "text" as const,
      trigger: "\0".repeat(256),
      response: "\0".repeat(4 * 1024),
    }));
    config.quickCommands = [
      {
        id: "quick-1",
        name: "控制字节一",
        template: "\0".repeat(64 * 1024),
        mode: "text",
        lineEnding: "none",
      },
      {
        id: "quick-2",
        name: "控制字节二",
        template: "\0".repeat(64 * 1024),
        mode: "text",
        lineEnding: "none",
      },
    ];
    const serialized = serializeWorkspace(
      createWorkspaceProfile("满容量规则", config, "full-rules", 100),
    );

    const serializedBytes = new TextEncoder().encode(serialized).byteLength;
    expect(serializedBytes).toBeGreaterThan(512 * 1024);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_WORKSPACE_FILE_BYTES);
    const parsed = parseWorkspaceExport(serialized);
    expect(parsed.config.autoResponderRules).toEqual(config.autoResponderRules);
    expect(parsed.config.quickCommands).toEqual(config.quickCommands);
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

  it("损坏的本地快捷命令恢复为独立 fallback 副本", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    fallback.quickCommands = [
      {
        id: "quick-safe",
        name: "安全命令",
        template: "PING",
        mode: "text",
        lineEnding: "lf",
      },
    ];

    const restored = restoreWorkspaceConfig(
      { quickCommands: [{ ...fallback.quickCommands[0], script: "send()" }] },
      fallback,
    );

    expect(restored.quickCommands).toEqual(fallback.quickCommands);
    expect(restored.quickCommands).not.toBe(fallback.quickCommands);
    expect(restored.quickCommands[0]).not.toBe(fallback.quickCommands[0]);
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
    right.quickCommands = [
      {
        id: "quick-1",
        name: "查询",
        template: "PING",
        mode: "text",
        lineEnding: "none",
      },
    ];
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
    left.quickCommands = [...right.quickCommands];
    expect(areWorkspaceConfigsEqual(left, right)).toBe(true);
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
