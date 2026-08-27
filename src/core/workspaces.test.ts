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
  delete config.channelPresentations;
  delete config.commandChecksum;
  delete config.simulatorConfig;
  delete config.terminalTxTextEncoding;
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

  it("以严格的 v13 格式往返发送编码、校验模式、模拟器及完整配置", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.serialConfig.portName = "COM7";
    config.protocol = "justfloat";
    config.sendMode = "hex";
    config.lineEnding = "cr";
    config.commandChecksum = "crc16-modbus-be";
    config.simulatorConfig = {
      signal: "white-noise",
      channelCount: 16,
      sampleRate: 200,
    };
    config.terminalRxRecordMode = "line";
    config.terminalRxLineEnding = "crlf";
    config.terminalRxTextEncoding = "gb18030";
    config.terminalTxTextEncoding = "windows-1252";
    config.channelVisibility = { "channel-2": false };
    config.channelPresentations.firewater["channel-0"] = {
      alias: "温度",
      unit: "degC",
      color: "#123456",
    };
    config.channelPresentations.justfloat["channel-0"] = {
      alias: "电压",
      unit: "V",
      color: null,
    };
    config.processingGraph = {
      enabled: true,
      nodes: [
        { id: "low", kind: "input", channelIndex: 0 },
        { id: "high", kind: "input", channelIndex: 1 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: ["low", "high"],
          numericType: "u16",
          endianness: "le",
        },
        {
          id: "encoded",
          kind: "number_to_byte",
          input: "decoded",
          numericType: "u16",
          endianness: "be",
          byteIndex: 0,
        },
        {
          id: "output",
          kind: "output",
          input: "encoded",
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
      schemaVersion: 13,
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
    expect(parsed.config.channelPresentations).not.toBe(config.channelPresentations);
    expect(parsed.config.channelPresentations.firewater).not.toBe(
      config.channelPresentations.firewater,
    );
    expect(parsed.config.channelPresentations.firewater["channel-0"]).not.toBe(
      config.channelPresentations.firewater["channel-0"],
    );
    expect(parsed.config.simulatorConfig).not.toBe(config.simulatorConfig);
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

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
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

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
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

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
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

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
    expect(parsed.config.autoResponderRules).toEqual(config.autoResponderRules);
    expect(parsed.config.quickCommands).toEqual([]);
  });

  it("导入严格 v5 后无损迁移为 v13", () => {
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

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config).toEqual({ ...config, commandChecksum: "none" });
  });

  it("导入严格 v6 后补充默认接收记录方式与行尾", () => {
    const config = createDefaultWorkspaceConfig("serial");
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v6 工作区", config, "legacy-v6", 100)),
    ) as Record<string, unknown>;
    removeCurrentTerminalRxFields(exported.config as Record<string, unknown>);
    exported.schemaVersion = 6;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
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
    const exportedConfig = exported.config as Record<string, unknown>;
    delete exportedConfig.terminalRxTextEncoding;
    delete exportedConfig.channelPresentations;
    delete exportedConfig.commandChecksum;
    delete exportedConfig.simulatorConfig;
    delete exportedConfig.terminalTxTextEncoding;
    exported.schemaVersion = 7;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
    expect(parsed.config.terminalRxTextEncoding).toBe("utf-8");
  });

  it("导入合法 v8 处理图后无损迁移为 v13", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.processingGraph = {
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "result", kind: "output", input: "source", name: "结果", color: "#123456" },
      ],
    };
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v8 工作区", config, "legacy-v8", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).channelPresentations;
    delete (exported.config as Record<string, unknown>).commandChecksum;
    delete (exported.config as Record<string, unknown>).simulatorConfig;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 8;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.processingGraph).toEqual(config.processingGraph);
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
  });

  it("导入 v9 当前处理图时保留转换节点并补充空展示配置", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.processingGraph = {
      enabled: true,
      nodes: [
        { id: "low", kind: "input", channelIndex: 0 },
        { id: "high", kind: "input", channelIndex: 1 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: ["low", "high"],
          numericType: "u16",
          endianness: "le",
        },
        {
          id: "encoded",
          kind: "number_to_byte",
          input: "decoded",
          numericType: "u16",
          endianness: "be",
          byteIndex: 0,
        },
      ],
    };
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v9 工作区", config, "legacy-v9", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).channelPresentations;
    delete (exported.config as Record<string, unknown>).commandChecksum;
    delete (exported.config as Record<string, unknown>).simulatorConfig;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 9;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("none");
    expect(parsed.config.processingGraph).toEqual(config.processingGraph);
    expect(parsed.config.channelPresentations).toEqual({ firewater: {}, justfloat: {} });
  });

  it("导入严格 v10 后补充默认命令校验模式", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.channelPresentations.firewater["channel-0"] = {
      alias: "温度",
      unit: "degC",
      color: "#123456",
    };
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v10 工作区", config, "legacy-v10", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).commandChecksum;
    delete (exported.config as Record<string, unknown>).simulatorConfig;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 10;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config).toEqual({ ...config, commandChecksum: "none" });
  });

  it("v10 继续严格拒绝提前出现的 v11 字段", () => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile(
          "伪 v10",
          createDefaultWorkspaceConfig("simulator"),
          "invalid-v10",
          100,
        ),
      ),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 10;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/commandChecksum/);
  });

  it("导入严格 v11 后补充默认模拟器配置", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.commandChecksum = "xor8";
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v11 工作区", config, "legacy-v11", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).simulatorConfig;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 11;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.commandChecksum).toBe("xor8");
    expect(parsed.config.simulatorConfig).toEqual({
      signal: "sine",
      channelCount: 3,
      sampleRate: 25,
    });
  });

  it("v11 继续严格拒绝提前出现的 v12 字段", () => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile(
          "伪 v11",
          createDefaultWorkspaceConfig("simulator"),
          "invalid-v11",
          100,
        ),
      ),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 11;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/simulatorConfig/);
  });

  it("导入严格 v12 后补充默认 UTF-8 发送编码", () => {
    const config = createDefaultWorkspaceConfig("serial");
    config.terminalRxTextEncoding = "gb18030";
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("v12 工作区", config, "legacy-v12", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 12;

    const parsed = parseWorkspaceExport(JSON.stringify(exported));

    expect(parsed.schemaVersion).toBe(13);
    expect(parsed.config.terminalRxTextEncoding).toBe("gb18030");
    expect(parsed.config.terminalTxTextEncoding).toBe("utf-8");
  });

  it("v12 严格拒绝提前出现的 v13 发送编码字段", () => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile(
          "伪 v12",
          createDefaultWorkspaceConfig("simulator"),
          "invalid-v12",
          100,
        ),
      ),
    ) as Record<string, unknown>;
    exported.schemaVersion = 12;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/terminalTxTextEncoding/);
  });

  it("v9 继续严格拒绝提前出现的 v10 字段", () => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile("伪 v9", createDefaultWorkspaceConfig("simulator"), "invalid-v9", 100),
      ),
    ) as Record<string, unknown>;
    exported.schemaVersion = 9;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/未知字段/);
  });

  it("拒绝伪装成 v8 的转换节点", () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.processingGraph = {
      enabled: true,
      nodes: [
        { id: "first", kind: "input", channelIndex: 0 },
        { id: "second", kind: "input", channelIndex: 1 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: ["first", "second"],
          numericType: "u16",
          endianness: "le",
        },
      ],
    };
    const exported = JSON.parse(
      serializeWorkspace(createWorkspaceProfile("伪 v8", config, "invalid-v8", 100)),
    ) as Record<string, unknown>;
    delete (exported.config as Record<string, unknown>).channelPresentations;
    delete (exported.config as Record<string, unknown>).commandChecksum;
    delete (exported.config as Record<string, unknown>).simulatorConfig;
    delete (exported.config as Record<string, unknown>).terminalTxTextEncoding;
    exported.schemaVersion = 8;

    expect(() => parseWorkspaceExport(JSON.stringify(exported))).toThrow(/kind/);
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

  it("严格校验 v13 姿态字段、快捷命令、接收配置及派生通道引用", () => {
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

  it("严格校验 v13 通道展示、命令校验、模拟器与发送编码字段", () => {
    const exported = JSON.parse(
      serializeWorkspace(
        createWorkspaceProfile(
          "展示工作区",
          createDefaultWorkspaceConfig("simulator"),
          "presentations",
          100,
        ),
      ),
    ) as Record<string, unknown>;
    const config = exported.config as Record<string, unknown>;

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: { ...config, commandChecksum: "crc16-modbus" },
        }),
      ),
    ).toThrow(/命令校验模式/);

    const missing = { ...config };
    delete missing.channelPresentations;
    expect(() =>
      parseWorkspaceExport(JSON.stringify({ ...exported, config: missing })),
    ).toThrow(/缺少字段：channelPresentations/);

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            channelPresentations: { firewater: {}, justfloat: {}, raw: {} },
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
            channelPresentations: {
              firewater: {
                "channel-16": { alias: "越界", unit: "", color: null },
              },
              justfloat: {},
            },
          },
        }),
      ),
    ).toThrow(/不支持通道/);

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            simulatorConfig: {
              signal: "sine",
              channelCount: 17,
              sampleRate: 25,
            },
          },
        }),
      ),
    ).toThrow(/通道数/);

    expect(() =>
      parseWorkspaceExport(
        JSON.stringify({
          ...exported,
          config: {
            ...config,
            simulatorConfig: {
              signal: "sine",
              channelCount: 3,
              sampleRate: 30,
            },
          },
        }),
      ),
    ).toThrow(/采样率/);
  });

  it.each([
    ["错误格式", { format: "other", schemaVersion: 1 }],
    ["未知版本", { format: "vofa-ultra.workspace", schemaVersion: 14 }],
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

  it("本地命令校验模式严格恢复，损坏时使用 fallback", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    fallback.commandChecksum = "sum8";

    expect(
      restoreWorkspaceConfig({ commandChecksum: "crc32-be" }, fallback).commandChecksum,
    ).toBe("crc32-be");
    expect(
      restoreWorkspaceConfig({ commandChecksum: "crc16-modbus" }, fallback).commandChecksum,
    ).toBe("sum8");
  });

  it("本地模拟器配置严格恢复，损坏时使用独立 fallback 副本", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    fallback.simulatorConfig = {
      signal: "square",
      channelCount: 8,
      sampleRate: 100,
    };

    const restored = restoreWorkspaceConfig(
      {
        simulatorConfig: {
          signal: "multi-tone",
          channelCount: 16,
          sampleRate: 200,
        },
      },
      fallback,
    );
    expect(restored.simulatorConfig).toEqual({
      signal: "multi-tone",
      channelCount: 16,
      sampleRate: 200,
    });

    const fallbackRestored = restoreWorkspaceConfig(
      {
        simulatorConfig: {
          signal: "future",
          channelCount: 3,
          sampleRate: 25,
        },
      },
      fallback,
    );
    expect(fallbackRestored.simulatorConfig).toEqual(fallback.simulatorConfig);
    expect(fallbackRestored.simulatorConfig).not.toBe(fallback.simulatorConfig);
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

  it("本地展示配置严格恢复，损坏时使用独立 fallback 副本", () => {
    const fallback = createDefaultWorkspaceConfig("simulator");
    fallback.channelPresentations.firewater["channel-0"] = {
      alias: "温度",
      unit: "degC",
      color: "#123456",
    };

    const restored = restoreWorkspaceConfig(
      {
        channelPresentations: {
          firewater: {
            "channel-1": { alias: " 电压 ", unit: " V ", color: "#ABCDEF" },
          },
          justfloat: {},
        },
      },
      fallback,
    );
    expect(restored.channelPresentations).toEqual({
      firewater: {
        "channel-1": { alias: "电压", unit: "V", color: "#abcdef" },
      },
      justfloat: {},
    });

    const fallbackRestored = restoreWorkspaceConfig(
      {
        channelPresentations: {
          firewater: {
            "channel-16": { alias: "越界", unit: "", color: null },
          },
          justfloat: {},
        },
      },
      fallback,
    );
    expect(fallbackRestored.channelPresentations).toEqual(fallback.channelPresentations);
    expect(fallbackRestored.channelPresentations).not.toBe(fallback.channelPresentations);
    expect(fallbackRestored.channelPresentations.firewater).not.toBe(
      fallback.channelPresentations.firewater,
    );
    expect(fallbackRestored.channelPresentations.firewater["channel-0"]).not.toBe(
      fallback.channelPresentations.firewater["channel-0"],
    );
  });

  it("比较配置时忽略通道键顺序并纳入命令校验与模拟器配置", () => {
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
    right.channelPresentations.justfloat["channel-0"] = {
      alias: "电压",
      unit: "V",
      color: null,
    };
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
    left.channelPresentations.justfloat["channel-0"] = {
      alias: "电压",
      unit: "V",
      color: null,
    };
    expect(areWorkspaceConfigsEqual(left, right)).toBe(true);
    right.commandChecksum = "xor8";
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
    left.commandChecksum = "xor8";
    expect(areWorkspaceConfigsEqual(left, right)).toBe(true);
    right.simulatorConfig.channelCount = 16;
    expect(areWorkspaceConfigsEqual(left, right)).toBe(false);
    left.simulatorConfig.channelCount = 16;
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
