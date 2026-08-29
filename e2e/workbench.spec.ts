import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProcessingGraphConfig } from "../src/types/processingGraph";
import { DEFAULT_SERIAL_CONFIG } from "../src/types/serial";
import type { TerminalEntry } from "../src/types/workbench";

async function expectValidTabPanelReferences(page: Page, tablistName: string): Promise<void> {
  const tabs = page.getByRole("tablist", { name: tablistName }).getByRole("tab");
  const count = await tabs.count();
  for (let index = 0; index < count; index += 1) {
    const targetId = await tabs.nth(index).getAttribute("aria-controls");
    expect(targetId).toBeTruthy();
    await expect(page.locator(`#${targetId}`)).toHaveCount(1);
  }
}

async function ingestProtocolText(page: Page, text: string, timestamp: number): Promise<void> {
  await ingestProtocolBytes(page, Array.from(new TextEncoder().encode(text)), timestamp);
}

async function ingestProtocolBytes(
  page: Page,
  bytes: number[],
  timestamp: number,
): Promise<void> {
  await page.evaluate(
    async ({ payload, receivedAt }) => {
      type WorkbenchStoreHandle = {
        getState(): {
          ingestBytes(bytes: Uint8Array, timestamp?: number): void;
        };
      };
      const runtime = globalThis as typeof globalThis & {
        __vofaUltraE2eStore?: WorkbenchStoreHandle;
      };
      if (!runtime.__vofaUltraE2eStore) {
        const moduleUrl = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => name.includes("/src/store/workbenchStore.ts"));
        if (!moduleUrl) {
          throw new Error("找不到页面当前使用的工作台 Store 模块");
        }
        const module = await import(/* @vite-ignore */ moduleUrl);
        runtime.__vofaUltraE2eStore = module.useWorkbenchStore as WorkbenchStoreHandle;
      }
      runtime.__vofaUltraE2eStore.getState().ingestBytes(
        Uint8Array.from(payload),
        receivedAt,
      );
    },
    { payload: bytes, receivedAt: timestamp },
  );
}

async function setWorkbenchState(page: Page, state: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (nextState) => {
    type WorkbenchStoreHandle = {
      setState(state: Record<string, unknown>): void;
    };
    const runtime = globalThis as typeof globalThis & {
      __vofaUltraE2eStore?: WorkbenchStoreHandle;
    };
    if (!runtime.__vofaUltraE2eStore) {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => name.includes("/src/store/workbenchStore.ts"));
      if (!moduleUrl) {
        throw new Error("找不到页面当前使用的工作台 Store 模块");
      }
      const module = await import(/* @vite-ignore */ moduleUrl);
      runtime.__vofaUltraE2eStore = module.useWorkbenchStore as WorkbenchStoreHandle;
    }
    runtime.__vofaUltraE2eStore.setState(nextState);
  }, state);
}

async function readWaveformTriggerSnapshot(page: Page): Promise<{
  phase: string;
  threshold: number | null;
  previousValue: number | null;
  chartPaused: boolean;
  pointCount: number;
  pointValues: number[];
  terminalEntryCount: number;
  rxFrames: number;
}> {
  return page.evaluate(() => {
    type WorkbenchStoreHandle = {
      getState(): {
        waveformTrigger: {
          phase: string;
          config: { threshold: number } | null;
          previousValue: number | null;
        };
        chartPaused: boolean;
        channels: Array<{ points: Array<{ y: number }> }>;
        terminalEntries: unknown[];
        stats: { rxFrames: number };
      };
    };
    const runtime = globalThis as typeof globalThis & {
      __vofaUltraE2eStore?: WorkbenchStoreHandle;
    };
    const state = runtime.__vofaUltraE2eStore?.getState();
    if (!state) {
      throw new Error("工作台 Store 尚未初始化");
    }
    return {
      phase: state.waveformTrigger.phase,
      threshold: state.waveformTrigger.config?.threshold ?? null,
      previousValue: state.waveformTrigger.previousValue,
      chartPaused: state.chartPaused,
      pointCount: state.channels[0]?.points.length ?? 0,
      pointValues: state.channels[0]?.points.map((point) => point.y) ?? [],
      terminalEntryCount: state.terminalEntries.length,
      rxFrames: state.stats.rxFrames,
    };
  });
}

async function replaceTerminalEntries(page: Page, entries: TerminalEntry[]): Promise<void> {
  await page.evaluate(async (terminalEntries) => {
    type WorkbenchStoreHandle = {
      setState(state: { terminalEntries: TerminalEntry[] }): void;
    };
    const runtime = globalThis as typeof globalThis & {
      __vofaUltraE2eStore?: WorkbenchStoreHandle;
    };
    if (!runtime.__vofaUltraE2eStore) {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => name.includes("/src/store/workbenchStore.ts"));
      if (!moduleUrl) {
        throw new Error("找不到页面当前使用的工作台 Store 模块");
      }
      const module = await import(/* @vite-ignore */ moduleUrl);
      runtime.__vofaUltraE2eStore = module.useWorkbenchStore as WorkbenchStoreHandle;
    }
    runtime.__vofaUltraE2eStore.setState({ terminalEntries });
  }, entries);
}

async function readWaveformCanvasStats(page: Page): Promise<{
  width: number;
  height: number;
  opaquePixels: number;
  chromaticPixels: number;
}> {
  return page.locator(".waveform-chart canvas").first().evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (!context) {
      return { width: 0, height: 0, opaquePixels: 0, chromaticPixels: 0 };
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    let chromaticPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha > 0) {
        opaquePixels += 1;
      }
      if (alpha > 0 && Math.max(red, green, blue) - Math.min(red, green, blue) > 35) {
        chromaticPixels += 1;
      }
    }
    return { width: canvas.width, height: canvas.height, opaquePixels, chromaticPixels };
  });
}

async function readWaveformColorBounds(
  page: Page,
  color: string,
): Promise<{ pixelCount: number; minY: number; maxY: number; span: number }> {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) {
    throw new Error(`无效的波形颜色: ${color}`);
  }
  const target = match.slice(1).map((component) => Number.parseInt(component, 16));
  return page.locator(".waveform-chart canvas").first().evaluate((canvas, targetColor) => {
    const context = canvas.getContext("2d");
    const plot = canvas.closest(".uplot")?.querySelector<HTMLElement>(".u-over");
    if (!context || !plot) {
      return { pixelCount: 0, minY: -1, maxY: -1, span: 0 };
    }
    const canvasRect = canvas.getBoundingClientRect();
    const plotRect = plot.getBoundingClientRect();
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const margin = 2;
    const left = Math.max(0, Math.floor((plotRect.left - canvasRect.left - margin) * scaleX));
    const right = Math.min(
      canvas.width,
      Math.ceil((plotRect.right - canvasRect.left + margin) * scaleX),
    );
    const top = Math.max(0, Math.floor((plotRect.top - canvasRect.top - margin) * scaleY));
    const bottom = Math.min(
      canvas.height,
      Math.ceil((plotRect.bottom - canvasRect.top + margin) * scaleY),
    );
    const image = context.getImageData(left, top, right - left, bottom - top);
    const pixels = image.data;
    let pixelCount = 0;
    let minY = image.height;
    let maxY = -1;
    for (let index = 0; index < pixels.length; index += 4) {
      const distance =
        Math.abs((pixels[index] ?? 0) - (targetColor[0] ?? 0)) +
        Math.abs((pixels[index + 1] ?? 0) - (targetColor[1] ?? 0)) +
        Math.abs((pixels[index + 2] ?? 0) - (targetColor[2] ?? 0));
      if ((pixels[index + 3] ?? 0) < 80 || distance > 90) {
        continue;
      }
      const y = Math.floor(index / 4 / image.width);
      pixelCount += 1;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return {
      pixelCount,
      minY: pixelCount > 0 ? minY : -1,
      maxY,
      span: pixelCount > 0 ? (maxY - minY) / scaleY : 0,
    };
  }, target);
}
test("主题偏好跟随系统并持久化固定选择", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("vofa-ultra-theme"))).toBe("system");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const appearance = page.getByRole("group", { name: "外观" });
  const system_button = appearance.getByRole("button", { name: "系统" });
  const dark_button = appearance.getByRole("button", { name: "深色" });
  await expect(system_button).toHaveAttribute("aria-pressed", "true");

  await dark_button.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("vofa-ultra-theme"))).toBe("dark");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(appearance.getByRole("button", { name: "深色" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await appearance.getByRole("button", { name: "系统" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("vofa-ultra-theme"))).toBe("system");

  await page.screenshot({
    path: testInfo.outputPath("system-theme-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(appearance).toBeVisible();
  const theme_buttons = appearance.getByRole("button");
  await expect(theme_buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const box = await theme_buttons.nth(index).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("system-theme-mobile.png"),
    fullPage: true,
  });
});

test("状态栏显示当前双向吞吐并在空闲后归零", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  const startedAt = Date.now();
  await setWorkbenchState(page, {
    stats: { rxBytes: 0, txBytes: 0, rxFrames: 0, startedAt },
  });

  const rate = page.locator(".transfer-rate");
  await expect(rate).toContainText("RX 0 B/s");
  await expect(rate).toContainText("TX 0 B/s");
  await setWorkbenchState(page, {
    stats: { rxBytes: 4_096, txBytes: 2_048, rxFrames: 2, startedAt },
  });
  await expect
    .poll(async () => {
      const text = (await rate.textContent()) ?? "";
      return {
        rxActive: !text.includes("RX 0 B/s"),
        txActive: !text.includes("TX 0 B/s"),
      };
    }, { intervals: [50], timeout: 2_500 })
    .toEqual({ rxActive: true, txActive: true });

  await expect
    .poll(async () => {
      const text = (await rate.textContent()) ?? "";
      return {
        rxIdle: text.includes("RX 0 B/s"),
        txIdle: text.includes("TX 0 B/s"),
      };
    }, { intervals: [50], timeout: 2_500 })
    .toEqual({ rxIdle: true, txIdle: true });

  await page.setViewportSize({ width: 320, height: 568 });
  await expect(rate).toHaveAttribute("aria-label", /RX 0 B\/s，TX 0 B\/s/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("状态栏在主工作区持续显示数值 CSV 记录与失败", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");
  await setWorkbenchState(page, {
    numericLogStatus: "recording",
    numericLogOutputBytes: 2_048,
    numericLogMessage: "",
  });

  await expect(page.getByLabel("数值 CSV 记录中：2.0 KB")).toBeVisible();
  await setWorkbenchState(page, {
    numericLogStatus: "error",
    numericLogMessage: "磁盘空间不足",
  });

  const failure = page.getByRole("status", {
    name: "数值 CSV 记录失败：磁盘空间不足",
  });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("CSV 失败");
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(failure).toBeVisible();
  const bounds = await failure.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const statusBar = element.parentElement?.getBoundingClientRect();
    return {
      itemLeft: item.left,
      itemRight: item.right,
      statusLeft: statusBar?.left ?? 0,
      statusRight: statusBar?.right ?? 0,
    };
  });
  expect(bounds.itemLeft).toBeGreaterThanOrEqual(bounds.statusLeft);
  expect(bounds.itemRight).toBeLessThanOrEqual(bounds.statusRight);
  await page.screenshot({
    path: testInfo.outputPath("numeric-log-status-error.png"),
  });
});

test("模拟信号实验室支持十六通道配置、运行锁定与可复现重启", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "true");
  const receive_display = page.getByRole("group", { name: "接收显示格式" });
  await expect(receive_display.getByRole("button", { name: "TEXT" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("radio", { name: /Raw Data/ }).click();
  await expect(receive_display.getByRole("button", { name: "HEX" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("radio", { name: /FireWater/ }).click();
  await expect(receive_display.getByRole("button", { name: "TEXT" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("radio", { name: /Raw Data/ }).click();
  const protocolBoundary = page.locator('.terminal-line[data-direction="system"]').last();
  await expect(protocolBoundary).toContainText("协议：FireWater → Raw Data");
  await expect(protocolBoundary).toHaveAttribute("data-session-boundary", "true");
  await expect(protocolBoundary.locator(".direction-label")).toHaveText("SYS");
  await expect(protocolBoundary.locator("small")).toHaveText("边界");

  const signal = page.getByLabel("信号类型");
  const channelCount = page.getByRole("spinbutton", { name: "模拟器通道数" });
  const sampleRate = page.getByLabel("模拟器采样率");
  await signal.selectOption("white-noise");
  await channelCount.fill("16");
  await sampleRate.selectOption("10");
  await expect(signal).toHaveValue("white-noise");
  await expect(channelCount).toHaveValue("16");
  await expect(sampleRate).toHaveValue("10");

  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await expect(signal).toBeDisabled();
  await expect(channelCount).toBeDisabled();
  await expect(sampleRate).toBeDisabled();

  const rxLines = page.locator('.terminal-line[data-direction="rx"]');
  await expect.poll(() => rxLines.count()).toBeGreaterThanOrEqual(3);
  const firstRun = (await rxLines.locator("code").allTextContents()).slice(0, 3);
  expect(firstRun).toHaveLength(3);
  expect(firstRun[0]).toMatch(/^56 55 01 10 00 00 00 00 /);
  expect(firstRun[1]).toMatch(/^56 55 01 10 01 00 00 00 /);
  expect(firstRun[2]).toMatch(/^56 55 01 10 02 00 00 00 /);
  expect(firstRun.every((line) => line.split(/\s+/).length === 72)).toBe(true);
  expect(firstRun.every((line) => !line.includes("sample="))).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("simulator-signals-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "断开连接" }).click();
  await expect(page.getByText("模拟数据已停止")).toBeVisible();
  await page.getByRole("button", { name: "清空终端", exact: true }).click();
  await expect(rxLines).toHaveCount(0);

  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect.poll(() => rxLines.count()).toBeGreaterThanOrEqual(3);
  const secondRun = (await rxLines.locator("code").allTextContents()).slice(0, 3);
  expect(secondRun).toEqual(firstRun);
  await page.getByRole("button", { name: "断开连接" }).click();

  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "true");
  const simulatorPanel = page.getByRole("region", { name: "模拟器配置" });
  await expect(simulatorPanel).toBeVisible();
  await expect
    .poll(() => simulatorPanel.evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThanOrEqual(0);
  const mobileLayout = await simulatorPanel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      width: bounds.width,
      right: bounds.right,
      scrollWidth: document.documentElement.scrollWidth,
      controlHeights: [...element.querySelectorAll<HTMLElement>("input, select")].map(
        (control) => control.getBoundingClientRect().height,
      ),
    };
  });
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.width).toBeGreaterThanOrEqual(280);
  expect(mobileLayout.right).toBeLessThanOrEqual(320);
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(320);
  expect(mobileLayout.controlHeights.every((height) => height >= 44)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("simulator-signals-mobile.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("标签组支持标准键盘导航", async ({ page }) => {
  await page.goto("/");

  const waveformTab = page.getByRole("tab", { name: "波形" });
  const monitorTab = page.getByRole("tab", { name: "监视" });
  const attitudeTab = page.getByRole("tab", { name: "姿态" });
  const waveformPanel = page.locator("#workspace-waveform-panel");
  const monitorPanel = page.locator("#workspace-monitor-panel");
  const attitudePanel = page.locator("#workspace-attitude-panel");
  await expectValidTabPanelReferences(page, "工作区视图");
  await expect(waveformPanel).toBeVisible();
  await expect(monitorPanel).toBeHidden();
  await expect(attitudePanel).toBeHidden();
  await waveformTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(monitorTab).toBeFocused();
  await expect(monitorTab).toHaveAttribute("aria-selected", "true");
  await expect(monitorTab).toHaveAttribute("tabindex", "0");
  await expect(waveformTab).toHaveAttribute("tabindex", "-1");
  await expect(monitorPanel).toBeVisible();
  await expect(waveformPanel).toBeHidden();
  await expect(attitudePanel).toBeHidden();
  await expect(monitorPanel.getByRole("heading", { name: "通道监视" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(attitudeTab).toBeFocused();
  await expect(attitudeTab).toHaveAttribute("aria-selected", "true");
  await expect(attitudeTab).toHaveAttribute("tabindex", "0");
  await expect(waveformTab).toHaveAttribute("tabindex", "-1");
  await expect(attitudePanel).toBeVisible();
  await expect(waveformPanel).toBeHidden();
  await expect(monitorPanel).toBeHidden();
  await expect(attitudePanel.getByRole("heading", { name: "3D 姿态" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(waveformTab).toBeFocused();
  await expect(waveformPanel).toBeVisible();
  await expect(monitorPanel).toBeHidden();
  await expect(attitudePanel).toBeHidden();

  await page.getByRole("button", { name: "记录", exact: true }).click();
  const recordTab = page.getByRole("tab", { name: "录制" });
  const exportTab = page.getByRole("tab", { name: "导出" });
  const recordPanel = page.locator("#record-panel");
  const exportPanel = page.locator("#export-panel");
  await expectValidTabPanelReferences(page, "会话模式");
  await expect(recordPanel).toBeVisible();
  await expect(exportPanel).toBeHidden();
  await recordTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(exportTab).toBeFocused();
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(exportPanel).toBeVisible();
  await expect(recordPanel).toBeHidden();
  await expect(exportPanel.getByRole("region", { name: "导出状态" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(recordTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(exportTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recordTab).toBeFocused();
  await expect(recordTab).toHaveAttribute("aria-selected", "true");
  await expect(recordPanel).toBeVisible();
  await expect(exportPanel).toBeHidden();
});

test("串口输入握手线状态在桌面与窄屏保持可读", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  await setWorkbenchState(page, {
    isNativeRuntime: true,
    source: "serial",
    connectionStatus: "connected",
    serialGeneration: 7,
    serialModemStatus: {
      generation: 7,
      revision: 2,
      cts: true,
      dsr: false,
      ri: null,
      dcd: true,
    },
  });

  const status = page.locator('dl[aria-label="串口输入握手线状态"]');
  const items = status.locator(".modem-status-item");
  await expect(status).toBeVisible();
  await expect(items).toHaveText(["CTS有效", "DSR无效", "RI不可用", "DCD有效"]);
  await expect
    .poll(() => items.evaluateAll((elements) => elements.map((element) => element.dataset.state)))
    .toEqual(["asserted", "deasserted", "unavailable", "asserted"]);

  const desktopLayout = await items.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  expect(desktopLayout).toHaveLength(4);
  expect(desktopLayout.every(({ height }) => height >= 44)).toBe(true);
  expect(desktopLayout[0]?.y).toBe(desktopLayout[1]?.y);
  expect(desktopLayout[2]?.y).toBe(desktopLayout[3]?.y);
  expect(desktopLayout[0]?.x).toBe(desktopLayout[2]?.x);
  expect(desktopLayout[1]?.x).toBe(desktopLayout[3]?.x);
  await page.screenshot({
    path: testInfo.outputPath("serial-modem-status-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(status).toBeVisible();
  const mobileBounds = await status.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(mobileBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.right).toBeLessThanOrEqual(mobileBounds.viewportWidth);
  expect(mobileBounds.scrollWidth).toBeLessThanOrEqual(mobileBounds.clientWidth);
  await page.screenshot({
    path: testInfo.outputPath("serial-modem-status-mobile.png"),
    fullPage: true,
  });

  await setWorkbenchState(page, { connectionStatus: "disconnected" });
  await expect(status).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("工作台分栏支持拖拽、键盘、持久化、专注模式和窄屏回退", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  const content = page.locator(".workspace-content");
  const primaryPanel = page.locator("#workspace-waveform-panel");
  const terminalPanel = page.locator("#workspace-terminal-panel");
  const separator = page.getByRole("separator", { name: "调整主视图与终端高度" });
  await expect(content).toHaveAttribute("data-layout-mode", "split");
  await expect(separator).toHaveAttribute("aria-valuenow", "61");
  await expect(primaryPanel).toBeVisible();
  await expect(terminalPanel).toBeVisible();

  const initialPrimaryHeight = await primaryPanel.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const initialTerminalHeight = await terminalPanel.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const separatorBox = await separator.boundingBox();
  expect(separatorBox).not.toBeNull();
  if (!separatorBox) {
    throw new Error("工作台分隔条没有可用边界");
  }
  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2,
    separatorBox.y + separatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2,
    separatorBox.y + separatorBox.height / 2 - 70,
    { steps: 4 },
  );
  await page.mouse.up();

  const resizedPrimaryHeight = await primaryPanel.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const resizedTerminalHeight = await terminalPanel.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(resizedPrimaryHeight).toBeLessThan(initialPrimaryHeight - 50);
  expect(resizedTerminalHeight).toBeGreaterThan(initialTerminalHeight + 50);
  const storedSplit = await page.evaluate(() =>
    Number.parseFloat(localStorage.getItem("vofa-ultra-workspace-split") ?? ""),
  );
  expect(storedSplit).toBeGreaterThanOrEqual(0.4);
  expect(storedSplit).toBeLessThan(0.61);

  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", String(Math.round(storedSplit * 100)));
  await expect
    .poll(() => primaryPanel.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(initialPrimaryHeight - 50);
  await page.screenshot({
    path: testInfo.outputPath("desktop-workspace-layout.png"),
    fullPage: true,
  });

  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "40");
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "66");
  await separator.dblclick();
  await expect(separator).toHaveAttribute("aria-valuenow", "61");

  const splitButton = page.getByRole("button", { name: "分栏显示" });
  const primaryButton = page.getByRole("button", { name: "专注波形视图" });
  const terminalButton = page.getByRole("button", { name: "专注终端" });
  await terminalButton.click();
  await expect(content).toHaveAttribute("data-layout-mode", "terminal");
  await expect(primaryPanel).toBeHidden();
  await expect(terminalPanel).toBeVisible();
  await splitButton.click();
  await expect(primaryPanel).toBeVisible();
  await expect(separator).toBeVisible();
  await primaryButton.click();
  await expect(content).toHaveAttribute("data-layout-mode", "primary");
  await expect(primaryPanel).toBeVisible();
  await expect(terminalPanel).toBeHidden();

  await terminalButton.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.getByRole("group", { name: "工作区布局" })).toBeHidden();
  await expect(separator).toBeHidden();
  await expect(primaryPanel).toBeVisible();
  await expect(terminalPanel).toBeVisible();
  const mobileLayout = await page.locator(".app-shell").evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(mobileLayout.width).toBeLessThanOrEqual(390);
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(390);
  const mobileSendButton = page.getByRole("button", { name: "发送", exact: true });
  const sendAndRailBounds = await page.evaluate(() => {
    const send = document.querySelector<HTMLElement>(".send-button");
    const rail = document.querySelector<HTMLElement>(".activity-rail");
    if (!send || !rail) {
      return null;
    }
    const sendRect = send.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    return {
      sendBottom: sendRect.bottom,
      sendHeight: sendRect.height,
      railTop: railRect.top,
    };
  });
  expect(sendAndRailBounds).not.toBeNull();
  expect(sendAndRailBounds?.sendHeight ?? 0).toBeGreaterThanOrEqual(44);
  expect(sendAndRailBounds?.sendBottom ?? 845).toBeLessThanOrEqual(
    (sendAndRailBounds?.railTop ?? 0) + 1,
  );
  expect(await clippedVisibleHeight(mobileSendButton)).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: testInfo.outputPath("mobile-workspace-layout.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(mobileSendButton).toBeInViewport();
  expect(await clippedVisibleHeight(mobileSendButton)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(pageErrors).toEqual([]);
});

test("Windows 支持窗口内发送栏、周期设置和频谱控件保持分离", async ({ page }, testInfo) => {
  const viewports = [
    { width: 1_440, height: 900 },
    { width: 1_366, height: 768 },
    { width: 1_345, height: 768 },
    { width: 1_344, height: 768 },
    { width: 1_280, height: 800 },
    { width: 1_200, height: 800 },
    { width: 1_101, height: 680 },
    { width: 1_100, height: 680 },
    { width: 1_024, height: 680 },
  ];
  await page.setViewportSize(viewports[0]);
  await page.goto("/");

  const app_shell = page.locator(".app-shell");
  const sidebar = page.locator(".sidebar");
  const send_row = page.locator(".send-main-row");
  const workspace_header = page.locator(".workspace-header");
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(app_shell).toHaveAttribute("data-sidebar-open", "true");
    await expect(sidebar).toBeVisible();
    const layout = await send_row.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll<HTMLElement>("button, select, textarea")]
        .filter((control) => {
          const control_rect = control.getBoundingClientRect();
          return control_rect.width > 0 && control_rect.height > 0;
        })
        .map((control) => {
          const control_rect = control.getBoundingClientRect();
          return {
            name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
            left: control_rect.left,
            top: control_rect.top,
            right: control_rect.right,
            bottom: control_rect.bottom,
          };
        });
      const overlaps: string[] = [];
      for (let left_index = 0; left_index < controls.length; left_index += 1) {
        for (let right_index = left_index + 1; right_index < controls.length; right_index += 1) {
          const left = controls[left_index];
          const right = controls[right_index];
          if (
            left &&
            right &&
            Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
            Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
          ) {
            overlaps.push(`${left.name} / ${right.name}`);
          }
        }
      }
      return {
        overflow: element.scrollWidth - element.clientWidth,
        document_width: document.documentElement.scrollWidth,
        outside: controls.filter(
          (control) => control.left < rect.left - 1 || control.right > rect.right + 1,
        ),
        overlaps,
      };
    });
    expect(layout.document_width).toBeLessThanOrEqual(viewport.width);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.outside).toEqual([]);
    expect(layout.overlaps).toEqual([]);

    const header_layout = await workspace_header.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const controls = [...element.children]
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .filter((control) => {
          const control_rect = control.getBoundingClientRect();
          return control_rect.width > 0 && control_rect.height > 0;
        })
        .map((control) => {
          const control_rect = control.getBoundingClientRect();
          return {
            name: control.className,
            left: control_rect.left,
            top: control_rect.top,
            right: control_rect.right,
            bottom: control_rect.bottom,
          };
        });
      const overlaps: string[] = [];
      for (let left_index = 0; left_index < controls.length; left_index += 1) {
        for (let right_index = left_index + 1; right_index < controls.length; right_index += 1) {
          const left = controls[left_index];
          const right = controls[right_index];
          if (
            left &&
            right &&
            Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
            Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
          ) {
            overlaps.push(`${left.name} / ${right.name}`);
          }
        }
      }
      const primary_title = element.querySelector<HTMLElement>(".workspace-title strong");
      return {
        outside: controls.filter(
          (control) =>
            control.left < rect.left - 1 ||
            control.right > rect.right + 1 ||
            control.top < rect.top - 1 ||
            control.bottom > rect.bottom + 1,
        ),
        overlaps,
        primary_title_truncated:
          (primary_title?.scrollWidth ?? 0) > (primary_title?.clientWidth ?? 0) + 1,
      };
    });
    expect(header_layout.outside).toEqual([]);
    expect(header_layout.overlaps).toEqual([]);
    expect(header_layout.primary_title_truncated).toBe(false);
  }

  const message = page.getByRole("textbox", { name: "发送内容" });
  await message.fill("PING");
  await page.getByRole("button", { name: "展开周期发送设置" }).click();
  const vertical_layout = await page.locator("#workspace-terminal-panel").evaluate((element) => {
    const panel_rect = element.getBoundingClientRect();
    const composer_rect = element.querySelector<HTMLElement>(".send-composer")?.getBoundingClientRect();
    const log_rect = element.querySelector<HTMLElement>(".terminal-log-shell")?.getBoundingClientRect();
    const status_rect = document.querySelector<HTMLElement>(".status-bar")?.getBoundingClientRect();
    return {
      composer_bottom: composer_rect?.bottom ?? Number.POSITIVE_INFINITY,
      log_height: log_rect?.height ?? 0,
      panel_bottom: panel_rect.bottom,
      status_top: status_rect?.top ?? 0,
      document_height: document.documentElement.scrollHeight,
    };
  });
  expect(vertical_layout.composer_bottom).toBeLessThanOrEqual(vertical_layout.panel_bottom + 1);
  expect(Math.abs(vertical_layout.panel_bottom - vertical_layout.status_top)).toBeLessThanOrEqual(1);
  expect(vertical_layout.log_height).toBeGreaterThanOrEqual(20);
  expect(vertical_layout.document_height).toBeLessThanOrEqual(680);

  await page.getByRole("group", { name: "波形视图" }).getByRole("button", { name: "频谱" }).click();
  const spectrum = page.getByLabel("频谱设置", { exact: true });
  await expect(spectrum).toBeVisible();
  const spectrum_layout = await spectrum.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>("button, select, input")].map(
      (control) => {
        const control_rect = control.getBoundingClientRect();
        return {
          left: control_rect.left,
          right: control_rect.right,
          top: control_rect.top,
          bottom: control_rect.bottom,
        };
      },
    );
    return {
      overflow: element.scrollWidth - element.clientWidth,
      outside: controls.filter(
        (control) => control.left < rect.left - 1 || control.right > rect.right + 1,
      ),
    };
  });
  expect(spectrum_layout.overflow).toBeLessThanOrEqual(1);
  expect(spectrum_layout.outside).toEqual([]);

  const workspace_width_before_collapse = await page
    .locator(".workspace")
    .evaluate((element) => element.getBoundingClientRect().width);
  const sidebar_toggle = page.getByRole("button", { name: "显示或隐藏侧栏" });
  await sidebar_toggle.click();
  await expect(app_shell).toHaveAttribute("data-sidebar-open", "false");
  await expect(sidebar).toBeHidden();
  const workspace_width_after_collapse = await page
    .locator(".workspace")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(workspace_width_after_collapse).toBeGreaterThan(workspace_width_before_collapse + 200);
  await sidebar_toggle.click();
  await expect(app_shell).toHaveAttribute("data-sidebar-open", "true");
  await expect(sidebar).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("windows-minimum-responsive-layout.png"),
    fullPage: true,
  });
});

test("Windows 最小窗口中连接主操作始终可达", async ({ page }, testInfo) => {
  await installTauriSerialMock(page);
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  const panel = page.locator(".connection-panel");
  const scroller = page.locator(".connection-panel-scroll");
  const connect_button = page.getByRole("button", { name: "连接设备" });

  await expect(connect_button).toBeInViewport();
  expect(await clippedVisibleHeight(connect_button)).toBeGreaterThanOrEqual(36);

  const layout = await panel.evaluate((element) => {
    const panel_rect = element.getBoundingClientRect();
    const scroll_element = element.querySelector<HTMLElement>(".connection-panel-scroll");
    const action_element = element.querySelector<HTMLElement>(".connection-action-area");
    const button_element = action_element?.querySelector<HTMLElement>(".connect-button");
    const scroll_rect = scroll_element?.getBoundingClientRect();
    const action_rect = action_element?.getBoundingClientRect();
    const button_rect = button_element?.getBoundingClientRect();
    return {
      panel_bottom: panel_rect.bottom,
      scroll_bottom: scroll_rect?.bottom ?? Number.POSITIVE_INFINITY,
      action_top: action_rect?.top ?? Number.NEGATIVE_INFINITY,
      action_bottom: action_rect?.bottom ?? Number.POSITIVE_INFINITY,
      button_top: button_rect?.top ?? Number.NEGATIVE_INFINITY,
      button_bottom: button_rect?.bottom ?? Number.POSITIVE_INFINITY,
      scrollable: (scroll_element?.scrollHeight ?? 0) > (scroll_element?.clientHeight ?? 0),
      document_width: document.documentElement.scrollWidth,
    };
  });
  expect(layout.scrollable).toBe(true);
  expect(layout.scroll_bottom).toBeLessThanOrEqual(layout.action_top + 1);
  expect(layout.action_bottom).toBeLessThanOrEqual(layout.panel_bottom + 1);
  expect(layout.button_top).toBeGreaterThanOrEqual(layout.action_top);
  expect(layout.button_bottom).toBeLessThanOrEqual(layout.action_bottom);
  expect(layout.document_width).toBeLessThanOrEqual(1_024);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("radio", { name: /Raw Data/ })).toBeInViewport();
  await expect(connect_button).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("windows-minimum-connection-action.png"),
    fullPage: false,
  });
});

test("串口发现三态在 Windows 最小窗口中保持一致反馈", async ({ page }, testInfo) => {
  await installTauriSerialMock(page);
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  const port_select = page.getByLabel("串口设备");
  const connection_status = page.locator("#serial-connection-status");
  const connect_button = page.getByRole("button", { name: "连接设备" });
  const common_state = {
    source: "serial",
    connectionStatus: "disconnected",
    connectionMessage: "等待连接",
    serialRuntimeError: "",
    ports: [],
    serialConfig: { ...DEFAULT_SERIAL_CONFIG, portName: "" },
  };

  await setWorkbenchState(page, {
    ...common_state,
    isRefreshingPorts: true,
    serialPortDiscoveryStatus: "idle",
    serialPortDiscoveryMessage: "",
  });
  await expect(port_select).toHaveText(/正在扫描设备/);
  await expect(port_select).toHaveAttribute("aria-busy", "true");
  await expect(connection_status).toHaveText("正在扫描串口设备");
  await expect(connection_status).toHaveAttribute("data-status", "connecting");
  await expect(connect_button).toHaveAttribute("title", "正在扫描串口设备");
  await page.screenshot({
    path: testInfo.outputPath("serial-discovery-scanning.png"),
    fullPage: false,
  });

  await setWorkbenchState(page, {
    ...common_state,
    isRefreshingPorts: false,
    serialPortDiscoveryStatus: "empty",
    serialPortDiscoveryMessage: "未发现串口设备",
  });
  await expect(port_select).toHaveText(/未发现设备/);
  await expect(connection_status).toHaveText("未发现串口设备");
  await expect(connection_status).toHaveAttribute("data-status", "disconnected");
  await expect(connect_button).toHaveAttribute(
    "title",
    "未发现串口设备，请连接设备后刷新",
  );
  await page.screenshot({
    path: testInfo.outputPath("serial-discovery-empty.png"),
    fullPage: false,
  });

  await setWorkbenchState(page, {
    ...common_state,
    isRefreshingPorts: false,
    serialPortDiscoveryStatus: "error",
    serialPortDiscoveryMessage: "扫描串口失败：串口驱动不可用",
  });
  await expect(connection_status).toHaveText("扫描串口失败：串口驱动不可用");
  await expect(connection_status).toHaveAttribute("data-status", "error");
  await expect(connect_button).toHaveAttribute(
    "title",
    "扫描串口失败：串口驱动不可用",
  );
  await expect(connect_button).toHaveAttribute(
    "aria-describedby",
    "serial-connect-action-hint",
  );
  await expect(connect_button).toHaveAccessibleDescription(
    "扫描串口失败：串口驱动不可用",
  );
  await expect(connect_button).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("serial-discovery-error.png"),
    fullPage: false,
  });
});

test("连接错误后可通过刷新重新发现串口设备", async ({ page }) => {
  await installTauriSerialMock(page, undefined, undefined, 150);
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");
  await expect(page.getByLabel("串口设备")).toHaveValue("COM3");

  await setWorkbenchState(page, {
    source: "serial",
    connectionStatus: "error",
    connectionMessage: "COM3 打开失败：拒绝访问",
    serialRuntimeError: "",
    ports: [],
    serialConfig: { ...DEFAULT_SERIAL_CONFIG, portName: "" },
    isRefreshingPorts: false,
    serialPortDiscoveryStatus: "idle",
    serialPortDiscoveryMessage: "",
  });

  const refresh_button = page.getByRole("button", { name: "刷新串口列表" });
  const connection_status = page.locator("#serial-connection-status");
  await refresh_button.click();
  await expect(refresh_button).toHaveAttribute("aria-busy", "true");
  await expect(connection_status).toHaveText("正在扫描串口设备");
  await expect(connection_status).toHaveAttribute("data-status", "connecting");

  await expect(page.getByLabel("串口设备")).toHaveValue("COM3");
  await expect(connection_status).toHaveText("发现 1 个串口设备");
  await expect(connection_status).toHaveAttribute("data-status", "disconnected");
  await expect(page.getByRole("button", { name: "连接设备" })).toBeEnabled();
});

test("波特率可直接输入且常用值始终可选", async ({ page }, testInfo) => {
  await installTauriSerialMock(page);
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  const baud_rate = page.getByRole("combobox", { name: "波特率" });

  await expect(baud_rate).toHaveValue("115200");
  await page.getByRole("button", { name: "展开常用波特率" }).click();
  const baud_rate_presets = page.getByRole("listbox", { name: "常用波特率" });
  await expect(baud_rate_presets.getByRole("option")).toHaveCount(13);
  await expect(baud_rate_presets.getByRole("option", { name: "115200" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const open_layout = await baud_rate_presets.evaluate((element) => {
    const list_rect = element.getBoundingClientRect();
    const scroller_rect = element
      .closest<HTMLElement>(".connection-panel-scroll")
      ?.getBoundingClientRect();
    const selected_rect = element
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.getBoundingClientRect();
    const combobox = element.closest<HTMLElement>(".baud-rate-combobox");
    const input = combobox?.querySelector<HTMLInputElement>("input");
    const combobox_style = combobox ? getComputedStyle(combobox) : null;
    const input_style = input ? getComputedStyle(input) : null;
    const combobox_rect = combobox?.getBoundingClientRect();
    return {
      list_left: list_rect.left,
      list_right: list_rect.right,
      list_top: list_rect.top,
      list_bottom: list_rect.bottom,
      combobox_left: combobox_rect?.left ?? Number.NEGATIVE_INFINITY,
      combobox_right: combobox_rect?.right ?? Number.POSITIVE_INFINITY,
      scroller_top: scroller_rect?.top ?? Number.NEGATIVE_INFINITY,
      scroller_bottom: scroller_rect?.bottom ?? Number.POSITIVE_INFINITY,
      selected_top: selected_rect?.top ?? Number.NEGATIVE_INFINITY,
      selected_bottom: selected_rect?.bottom ?? Number.POSITIVE_INFINITY,
      focus_shadow: combobox_style?.boxShadow ?? "none",
      input_outline_width: input_style?.outlineWidth ?? "",
      document_width: document.documentElement.scrollWidth,
    };
  });
  expect(open_layout.list_top).toBeGreaterThanOrEqual(open_layout.scroller_top - 1);
  expect(open_layout.list_bottom).toBeLessThanOrEqual(open_layout.scroller_bottom + 1);
  expect(Math.abs(open_layout.list_left - open_layout.combobox_left)).toBeLessThanOrEqual(1);
  expect(Math.abs(open_layout.list_right - open_layout.combobox_right)).toBeLessThanOrEqual(1);
  expect(open_layout.selected_top).toBeGreaterThanOrEqual(open_layout.list_top - 1);
  expect(open_layout.selected_bottom).toBeLessThanOrEqual(open_layout.list_bottom + 1);
  expect(open_layout.focus_shadow).not.toBe("none");
  expect(open_layout.input_outline_width).toBe("0px");
  expect(open_layout.document_width).toBeLessThanOrEqual(1_024);
  await page.screenshot({
    path: testInfo.outputPath("baud-rate-options-windows-minimum.png"),
    fullPage: false,
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: testInfo.outputPath("baud-rate-options-windows-minimum-light.png"),
    fullPage: false,
  });
  await baud_rate_presets.getByRole("option", { name: "9600" }).click();
  await expect(baud_rate).toHaveValue("9600");

  await baud_rate.press("ArrowDown");
  await expect(baud_rate).toHaveAttribute(
    "aria-activedescendant",
    "baud-rate-option-19200",
  );
  await baud_rate.press("ArrowDown");
  await baud_rate.press("ArrowUp");
  await baud_rate.press("Enter");
  await expect(baud_rate).toHaveValue("19200");
  await expect(baud_rate_presets).toBeHidden();

  await baud_rate.press("ArrowUp");
  await expect(baud_rate_presets).toBeVisible();
  await baud_rate.press("Escape");
  await expect(baud_rate_presets).toBeHidden();
  await expect(baud_rate).toHaveValue("19200");

  await baud_rate.fill("250000");
  await baud_rate.hover();
  await page.mouse.wheel(0, -100);
  await expect(baud_rate).toHaveValue("250000");
  await baud_rate.press("Enter");

  await baud_rate.fill("12000001");
  await expect(baud_rate).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "连接设备" })).toBeDisabled();
  await baud_rate.press("Escape");
  await expect(baud_rate).toHaveValue("250000");
  await expect(baud_rate).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByRole("button", { name: "连接设备" })).toBeEnabled();
});

test("串口核心事件监听失败时显示故障并阻止连接", async ({ page }) => {
  await installTauriSerialMock(page, "serial://state");
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  await expect(page.getByText(/串口核心事件监听初始化失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新串口列表" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "连接设备" })).toBeDisabled();
});

test("可选串口状态读取失败时仍允许核心连接", async ({ page }) => {
  await installTauriSerialMock(page, undefined, "get_serial_file_send_state");
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "刷新串口列表" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "连接设备" })).toBeEnabled();
  await expect(page.getByText(/串口核心事件监听初始化失败/)).toHaveCount(0);
});

test("串口初始状态读取失败后仍可刷新并连接", async ({ page }) => {
  await installTauriSerialMock(page, undefined, "get_serial_state");
  await page.setViewportSize({ width: 1_024, height: 680 });
  await page.goto("/");

  const refresh_button = page.getByRole("button", { name: "刷新串口列表" });
  const connect_button = page.getByRole("button", { name: "连接设备" });
  await expect(refresh_button).toBeEnabled();
  await expect(connect_button).toBeEnabled();
  await refresh_button.click();
  await expect(page.getByLabel("串口设备")).toHaveValue("COM3");
  await connect_button.click();
  await expect(page.getByText("COM3 已连接")).toBeVisible();
  await expect(page.getByText(/串口核心事件监听初始化失败/)).toHaveCount(0);
});

test("终端上滚挂起跟随并可回到最新", async ({ page }) => {
  await page.goto("/");
  const entries = Array.from(
    { length: 120 },
    (_, index): TerminalEntry => ({
      id: 10_000 + index,
      direction: "rx",
      timestamp: 1_700_000_000_000 + index,
      text: `stream ${index}`,
      hex: "73 74 72 65 61 6D",
      byteCount: 10,
    }),
  );
  await replaceTerminalEntries(page, entries);
  const viewport = page.getByRole("log", { name: "终端记录" });
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(24);

  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新记录" })).toBeVisible();
  const suspendedScrollTop = await viewport.evaluate((element) => element.scrollTop);

  await replaceTerminalEntries(page, [
    ...entries,
    {
      id: 10_120,
      direction: "rx",
      timestamp: 1_700_000_000_120,
      text: "stream 120",
      hex: "73 74 72 65 61 6D",
      byteCount: 10,
    },
  ]);
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("121 条记录");
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(suspendedScrollTop);

  await page.getByRole("button", { name: "回到最新记录" }).click();
  await expect(page.getByRole("button", { name: "回到最新记录" })).toHaveCount(0);
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(24);

  await replaceTerminalEntries(page, [
    ...entries,
    {
      id: 10_120,
      direction: "rx",
      timestamp: 1_700_000_000_120,
      text: "stream 120",
      hex: "73 74 72 65 61 6D",
      byteCount: 10,
    },
    {
      id: 10_121,
      direction: "rx",
      timestamp: 1_700_000_000_121,
      text: "stream 121",
      hex: "73 74 72 65 61 6D",
      byteCount: 10,
    },
  ]);
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("122 条记录");
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(24);

  await viewport.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 120);
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新记录" })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const autoScroll = page.getByRole("checkbox", { name: "终端自动滚动" });
  await autoScroll.uncheck();
  await autoScroll.check();
  await expect(page.getByRole("button", { name: "回到最新记录" })).toHaveCount(0);
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(24);
});

test("终端满载头删时保持用户浏览锚点", async ({ page }) => {
  await page.goto("/");
  const entries = Array.from(
    { length: 800 },
    (_, index): TerminalEntry => ({
      id: 30_000 + index,
      direction: "rx",
      timestamp: 1_700_000_100_000 + index,
      text: `anchor ${index}`,
      hex: "61 6E 63 68 6F 72",
      byteCount: 10,
    }),
  );
  await replaceTerminalEntries(page, entries);
  const viewport = page.getByRole("log", { name: "终端记录" });
  await viewport.evaluate((element) => {
    element.scrollTop = 2_400;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新记录" })).toBeVisible();

  const anchorBefore = await viewport.evaluate((element) => {
    const viewportTop = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>(".terminal-line")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
    );
    return row
      ? {
          payload: row.querySelector("code")?.textContent ?? "",
          offset: row.getBoundingClientRect().top - viewportTop,
        }
      : null;
  });
  expect(anchorBefore).not.toBeNull();

  await replaceTerminalEntries(page, [
    ...entries.slice(1),
    {
      id: 30_800,
      direction: "rx",
      timestamp: 1_700_000_100_800,
      text: "anchor 800",
      hex: "61 6E 63 68 6F 72",
      byteCount: 10,
    },
  ]);
  await expect
    .poll(() =>
      viewport.evaluate((element, expectedPayload) => {
        const viewportTop = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll<HTMLElement>(".terminal-line")].find(
          (candidate) => candidate.querySelector("code")?.textContent === expectedPayload,
        );
        return row ? row.getBoundingClientRect().top - viewportTop : null;
      }, anchorBefore?.payload ?? ""),
    )
    .toBeCloseTo(anchorBefore?.offset ?? 0, 1);
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("800 条记录");
  await expect(page.getByRole("button", { name: "回到最新记录" })).toBeVisible();
});

test("模拟数据贯通波形与终端", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "设备连接" })).toBeVisible();
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await expect(page.locator(".terminal-line").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".waveform-chart canvas").first()).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(800);

  await expect
    .poll(async () => {
      const recordText = await page.locator(".terminal-toolbar .panel-subtitle").textContent();
      const recordCount = Number(recordText?.match(/\d+/)?.[0] ?? 0);
      const domRowCount = await page.locator(".terminal-line").count();
      return recordCount - domRowCount;
    })
    .toBeGreaterThan(0);

  const canvasStats = await readWaveformCanvasStats(page);
  expect(canvasStats.width).toBeGreaterThan(400);
  expect(canvasStats.height).toBeGreaterThan(200);
  expect(canvasStats.opaquePixels).toBeGreaterThan(50);
  expect(canvasStats.chromaticPixels).toBeGreaterThan(100);

  const terminalCount = async () => {
    const text = await page.locator(".terminal-toolbar .panel-subtitle").textContent();
    return Number(text?.match(/\d+/)?.[0] ?? 0);
  };
  const terminalCountBeforeZoom = await terminalCount();
  const zoomBounds = await page.locator(".waveform-chart .u-over").boundingBox();
  expect(zoomBounds).not.toBeNull();
  if (zoomBounds) {
    await page.mouse.move(
      zoomBounds.x + zoomBounds.width * 0.2,
      zoomBounds.y + zoomBounds.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      zoomBounds.x + zoomBounds.width * 0.75,
      zoomBounds.y + zoomBounds.height * 0.5,
      { steps: 6 },
    );
    await page.mouse.up();
  }
  const returnToLive = page.getByRole("button", { name: "回到实时波形" });
  await expect(returnToLive).toBeVisible();
  await expect(page.getByText("LIVE")).toBeVisible();
  await expect.poll(terminalCount).toBeGreaterThan(terminalCountBeforeZoom);
  await expect
    .poll(async () => (await readWaveformCanvasStats(page)).chromaticPixels)
    .toBeGreaterThan(100);
  await expect(returnToLive).toBeVisible();
  await returnToLive.click();
  await expect(returnToLive).not.toBeVisible();

  const terminalCountBeforeMeasurement = await terminalCount();
  await page.getByRole("button", { name: "开启波形测量" }).click();
  await expect(page.getByText("HISTORY")).toBeVisible();
  const measurementResults = page.getByLabel("波形测量结果");
  await expect(measurementResults).toBeVisible();
  const intervalStatistics = page.getByLabel("A/B 区间统计");
  await expect(intervalStatistics).toBeVisible();
  await expect(page.locator(".waveform-measurement-cursor")).toHaveCount(2);
  await expect
    .poll(terminalCount)
    .toBeGreaterThan(terminalCountBeforeMeasurement);

  const cursorA = page.getByRole("slider", { name: "游标 A 采样点" });
  const cursorB = page.getByRole("slider", { name: "游标 B 采样点" });
  const cursorABeforeClick = Number(await cursorA.inputValue());
  const cursorBBeforeClick = Number(await cursorB.inputValue());
  const plotBounds = await page.locator(".waveform-chart .u-over").boundingBox();
  expect(plotBounds).not.toBeNull();
  if (plotBounds) {
    await page.mouse.click(
      plotBounds.x + plotBounds.width * 0.2,
      plotBounds.y + plotBounds.height * 0.5,
    );
    await page.mouse.click(
      plotBounds.x + plotBounds.width * 0.8,
      plotBounds.y + plotBounds.height * 0.5,
    );
  }
  expect(Number(await cursorA.inputValue())).toBeLessThan(cursorABeforeClick);
  expect(Number(await cursorB.inputValue())).toBeGreaterThan(cursorBBeforeClick);
  await expect(measurementResults).not.toContainText(/NaN|Infinity/);
  await cursorA.focus();
  await page.keyboard.press("Home");
  await cursorB.focus();
  await page.keyboard.press("End");
  await expect(measurementResults).not.toContainText(/NaN|Infinity/);
  await expect(intervalStatistics).not.toContainText(/NaN|Infinity/);
  await page.screenshot({
    path: testInfo.outputPath("desktop-measurement.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭波形测量" }).click();
  await expect(page.getByText("LIVE")).toBeVisible();

  await page.getByRole("textbox", { name: "发送内容" }).fill("ping");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toContainText("ping");

  await page.getByRole("button", { name: "暂停波形显示" }).click();
  await expect(page.getByText("HISTORY")).toBeVisible();
  await page.getByRole("button", { name: "开启波形测量" }).click();
  await page.getByRole("button", { name: "清空波形" }).click();
  await expect(page.getByText("HISTORY")).toBeVisible();
  await expect(page.getByRole("button", { name: "继续波形显示" })).toBeVisible();
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("desktop-workbench.png"),
    fullPage: true,
  });
});

test("独立量程让混合数量级通道保持可读并正确映射测量游标", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const start = 1_800_000_000;
  const timestamps = Array.from({ length: 6 }, (_, index) => start + index);
  const channel = (
    id: string,
    name: string,
    color: string,
    values: number[],
  ) => ({
    id,
    name,
    color,
    visible: true,
    points: timestamps.map((x, index) => ({ x, y: values[index] ?? 0 })),
    lastValue: values.at(-1) ?? 0,
  });
  const speedColor = "#00ff00";
  const currentColor = "#ff00ff";
  const temperatureColor = "#ffff00";
  await setWorkbenchState(page, {
    channels: [
      channel("speed", "转速", speedColor, [1_000, 2_000, 3_000, 4_000, 5_000, 6_000]),
      channel("current", "电流", currentColor, [0.1, 0.18, 0.12, 0.2, 0.14, 0.16]),
      channel("temperature", "温度", temperatureColor, [30, 30, 30, 30, 30, 30]),
    ],
    processedChannels: [],
    extensionChannels: [],
    chartPaused: true,
    chartWindowSeconds: 5,
  });
  await expect(page.locator(".channel-readout")).toHaveCount(3);
  await expect(page.locator(".waveform-chart canvas").first()).toBeVisible();

  const sharedCurrent = await readWaveformColorBounds(page, currentColor);
  expect(sharedCurrent.pixelCount).toBeGreaterThan(5);
  expect(sharedCurrent.span).toBeLessThan(12);

  await page.getByRole("button", { name: "独立" }).click();
  await expect(page.locator(".waveform-panel")).toHaveAttribute(
    "data-scale-mode",
    "independent",
  );
  const focusChannel = page.getByRole("combobox", { name: "独立量程焦点通道" });
  await expect(focusChannel).toHaveValue("speed");

  await expect
    .poll(async () => (await readWaveformColorBounds(page, currentColor)).span)
    .toBeGreaterThan(80);
  expect((await readWaveformColorBounds(page, speedColor)).span).toBeGreaterThan(80);
  expect((await readWaveformColorBounds(page, temperatureColor)).pixelCount).toBeGreaterThan(20);

  await focusChannel.selectOption("current");
  await expect(focusChannel).toHaveValue("current");
  await page.getByRole("button", { name: "开启波形测量" }).click();
  await page.getByRole("combobox", { name: "测量通道" }).selectOption("current");
  const intervalStatistics = page.getByLabel("A/B 区间统计");
  await expect(intervalStatistics.getByText("样本数", { exact: true }).locator("..")).toContainText(
    "4",
  );
  await expect(intervalStatistics.getByText("最小值", { exact: true }).locator("..")).toContainText(
    "0.120",
  );
  await expect(intervalStatistics.getByText("最大值", { exact: true }).locator("..")).toContainText(
    "0.200",
  );
  await expect(intervalStatistics.getByText("均值", { exact: true }).locator("..")).toContainText(
    "0.160",
  );
  await expect(intervalStatistics.getByText("RMS", { exact: true }).locator("..")).toContainText(
    "0.163",
  );
  await expect(intervalStatistics.getByText("峰峰值", { exact: true }).locator("..")).toContainText(
    "0.080",
  );
  const plotHeight = await page.locator(".waveform-chart .u-over").evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const measurementPointTops = await page
    .locator(".waveform-measurement-point")
    .evaluateAll((elements) => elements.map((element) => Number.parseFloat(element.style.top)));
  expect(measurementPointTops).toHaveLength(2);
  expect(
    measurementPointTops.every(
      (top) => Number.isFinite(top) && top >= 0 && top <= plotHeight,
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-independent-scales.png"),
    fullPage: true,
  });
});

test("固定 Y 量程保持稳定映射并可恢复自动量程", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  const start = 1_800_000_100;
  const color = "#00ff00";
  const createChannel = (values: number[]) => ({
    id: "range-test",
    name: "量程测试",
    color,
    visible: true,
    points: values.map((y, index) => ({ x: start + index, y })),
    lastValue: values.at(-1) ?? 0,
  });
  await setWorkbenchState(page, {
    channels: [createChannel([-1, -0.5, 0, 0.5, 1])],
    processedChannels: [],
    extensionChannels: [],
    chartPaused: false,
    chartWindowSeconds: 5,
  });
  await expect(page.locator(".waveform-chart canvas").first()).toBeVisible();
  await expect
    .poll(async () => (await readWaveformColorBounds(page, color)).span)
    .toBeGreaterThan(80);
  const automaticSpan = (await readWaveformColorBounds(page, color)).span;

  await page.getByRole("button", { name: "设置 Y 轴量程" }).click();
  const rangeForm = page.getByRole("form", { name: "Y 轴量程设置" });
  await rangeForm.getByRole("spinbutton", { name: "Y 轴下限" }).fill("-10");
  await rangeForm.getByRole("spinbutton", { name: "Y 轴上限" }).fill("10");
  await rangeForm.getByRole("button", { name: "固定" }).click();

  const waveformPanel = page.locator(".waveform-panel");
  await expect(waveformPanel).toHaveAttribute("data-y-range-mode", "fixed");
  await expect(waveformPanel).toHaveAttribute("data-y-range-min", "-10");
  await expect(waveformPanel).toHaveAttribute("data-y-range-max", "10");
  await expect
    .poll(async () => (await readWaveformColorBounds(page, color)).span)
    .toBeLessThan(automaticSpan * 0.3);
  const narrowFixedSpan = (await readWaveformColorBounds(page, color)).span;

  await setWorkbenchState(page, {
    channels: [createChannel([-5, -2.5, 0, 2.5, 5])],
  });
  await expect
    .poll(async () => (await readWaveformColorBounds(page, color)).span)
    .toBeGreaterThan(narrowFixedSpan * 3);
  const expandedFixedSpan = (await readWaveformColorBounds(page, color)).span;
  await expect(waveformPanel).toHaveAttribute("data-y-range-mode", "fixed");

  const plotBounds = await page.locator(".waveform-chart .u-over").boundingBox();
  expect(plotBounds).not.toBeNull();
  if (plotBounds) {
    await page.mouse.move(plotBounds.x + plotBounds.width * 0.2, plotBounds.y + plotBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      plotBounds.x + plotBounds.width * 0.8,
      plotBounds.y + plotBounds.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
  }
  await expect(page.getByRole("button", { name: "回到实时波形" })).toBeVisible();
  await expect(waveformPanel).toHaveAttribute("data-y-range-mode", "fixed");

  await page.getByRole("button", { name: "设置 Y 轴量程" }).click();
  await rangeForm.getByRole("button", { name: "自动", exact: true }).click();
  await expect(waveformPanel).toHaveAttribute("data-y-range-mode", "auto");
  await expect
    .poll(async () => (await readWaveformColorBounds(page, color)).span)
    .toBeGreaterThan(expandedFixedSpan * 1.4);
  expect(pageErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-fixed-waveform-range.png"),
    fullPage: true,
  });
});

test("终端时间基准按缓存和可见记录计算并跨刷新保留", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await page.goto("/");
  await replaceTerminalEntries(page, [
    {
      id: 41_001,
      direction: "rx",
      timestamp: 1_700_000_000_000,
      text: "first rx",
      hex: "01",
      byteCount: 1,
    },
    {
      id: 41_002,
      direction: "tx",
      timestamp: 1_700_000_000_125,
      text: "first tx",
      hex: "02",
      byteCount: 1,
    },
    {
      id: 41_003,
      direction: "rx",
      timestamp: 1_699_999_999_900,
      text: "late rx line",
      hex: "03",
      byteCount: 1,
    },
    {
      id: 41_004,
      direction: "tx",
      timestamp: 1_700_000_000_900,
      text: "second tx",
      hex: "04",
      byteCount: 1,
    },
  ]);

  const timeMode = page.getByRole("group", { name: "终端时间基准" });
  const timeCells = page.locator(".terminal-line time");
  await expect(
    timeMode.getByRole("button", { name: "ABS，绝对时间", exact: true }),
  ).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await timeMode.getByRole("button", { name: "REL，相对缓存起点", exact: true }).click();
  await expect(timeCells).toHaveText([
    "+00:00:00.000",
    "+00:00:00.125",
    "-00:00:00.100",
    "+00:00:00.900",
  ]);

  await timeMode.getByRole("button", { name: "ΔT，距上一条可见记录", exact: true }).click();
  await expect(timeCells).toHaveText([
    "--",
    "+00:00:00.125",
    "-00:00:00.225",
    "+00:00:01.000",
  ]);
  await page
    .getByRole("group", { name: "终端方向筛选" })
    .getByRole("button", { name: "TX" })
    .click();
  await expect(timeCells).toHaveText(["--", "+00:00:00.775"]);
  await page.screenshot({
    path: testInfo.outputPath("terminal-time-desktop.png"),
    fullPage: true,
  });

  await replaceTerminalEntries(
    page,
    Array.from({ length: 800 }, (_, index): TerminalEntry => ({
      id: 43_000 + index,
      direction: "tx",
      timestamp: 1_700_001_000_000 + index * 20,
      text: `virtual ${index}`,
      hex: "07",
      byteCount: 1,
    })),
  );
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText(
    "800 / 800 条记录",
  );
  await expect
    .poll(async () => {
      const mountedLabels = await page.locator(".terminal-line time").allTextContents();
      return (
        mountedLabels.length > 0 &&
        mountedLabels.every((label) => label === "+00:00:00.020")
      );
    })
    .toBe(true);

  await page.reload();
  await expect(
    page.getByRole("group", { name: "终端时间基准" }).getByRole("button", {
      name: "ΔT，距上一条可见记录",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await replaceTerminalEntries(page, [
    {
      id: 42_001,
      direction: "rx",
      timestamp: 1_700_000_100_000,
      text: "mobile first",
      hex: "05",
      byteCount: 1,
    },
    {
      id: 42_002,
      direction: "rx",
      timestamp: 1_700_000_100_250,
      text: "mobile second",
      hex: "06",
      byteCount: 1,
    },
  ]);
  await page.setViewportSize({ width: 600, height: 700 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  const compactTimeMode = page.getByRole("combobox", { name: "终端时间基准" });
  await expect(compactTimeMode).toHaveValue("interval");
  await expect(page.getByRole("combobox", { name: "终端方向筛选" })).toHaveValue("all");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);

  await page.setViewportSize({ width: 320, height: 568 });
  const mobileBounds = await compactTimeMode
    .evaluate((control) => {
      const controlRect = control.getBoundingClientRect();
      const filterRect = control.closest(".terminal-filter-bar")?.getBoundingClientRect();
      return {
        controlLeft: controlRect.left,
        controlRight: controlRect.right,
        filterLeft: filterRect?.left ?? -1,
        filterRight: filterRect?.right ?? -1,
      };
    });
  expect(mobileBounds.controlLeft).toBeGreaterThanOrEqual(mobileBounds.filterLeft);
  expect(mobileBounds.controlRight).toBeLessThanOrEqual(mobileBounds.filterRight);
  expect(await compactTimeMode.evaluate((control) => control.getBoundingClientRect().height)).toBe(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: testInfo.outputPath("terminal-time-mobile.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("终端按全部缓存或当前筛选视图导出", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await page.goto("/");
  const entries: TerminalEntry[] = [
    {
      id: 44_001,
      direction: "rx",
      timestamp: 1_700_000_200_000,
      text: "ready",
      hex: "72 65 61 64 79",
      byteCount: 5,
    },
    {
      id: 44_002,
      direction: "tx",
      timestamp: 1_700_000_200_100,
      text: "set rate",
      hex: "73 65 74 20 72 61 74 65",
      byteCount: 8,
    },
    {
      id: 44_003,
      direction: "rx",
      timestamp: 1_700_000_200_250,
      text: "fault sensor",
      hex: "66 61 75 6C 74 20 73 65 6E 73 6F 72",
      byteCount: 12,
    },
    {
      id: 44_004,
      direction: "system",
      timestamp: 1_700_000_200_300,
      text: "协议：FireWater → Raw Data",
      hex: "",
      byteCount: 0,
    },
  ];
  await replaceTerminalEntries(page, entries);

  await page
    .getByRole("group", { name: "终端时间基准" })
    .getByRole("button", { name: "相对缓存起点" })
    .click();
  const search = page.getByRole("searchbox", { name: "搜索终端记录" });
  await search.fill("fault");
  await page
    .getByRole("group", { name: "终端方向筛选" })
    .getByRole("button", { name: "RX" })
    .click();
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("1 / 4 条记录");

  const exportTrigger = page.getByRole("button", { name: "导出终端记录" });
  const viewDownloadPromise = page.waitForEvent("download");
  await exportTrigger.click();
  const exportMenu = page.getByRole("menu", { name: "终端导出范围" });
  await expect(exportMenu.getByRole("menuitem", { name: "全部缓存 4 条" })).toBeEnabled();
  await exportMenu.getByRole("menuitem", { name: "当前视图 1 条" }).click();
  const viewDownload = await viewDownloadPromise;
  expect(viewDownload.suggestedFilename()).toMatch(
    /^vofa-ultra-terminal-view-.+\.log$/,
  );
  const viewPath = testInfo.outputPath("terminal-view.log");
  await viewDownload.saveAs(viewPath);
  expect(await readFile(viewPath, "utf8")).toBe(
    `${new Date(entries[2].timestamp).toISOString()}\tRX\t12\tfault sensor`,
  );

  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await search.fill("66 61");
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("1 / 4 条记录");
  const allDownloadPromise = page.waitForEvent("download");
  await exportTrigger.click();
  await exportMenu.getByRole("menuitem", { name: "全部缓存 4 条" }).click();
  const allDownload = await allDownloadPromise;
  expect(allDownload.suggestedFilename()).toMatch(/^vofa-ultra-terminal-all-.+\.log$/);
  const allPath = testInfo.outputPath("terminal-all.log");
  await allDownload.saveAs(allPath);
  expect(await readFile(allPath, "utf8")).toBe(
    entries
      .map(
        (entry) =>
          `${new Date(entry.timestamp).toISOString()}\t${entry.direction.toUpperCase()}` +
          `\t${entry.byteCount}\t${entry.direction === "system" ? entry.text : entry.hex}`,
      )
      .join("\n"),
  );

  await page
    .getByRole("group", { name: "终端方向筛选" })
    .getByRole("button", { name: "全部" })
    .click();
  await search.fill("协议");
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("1 / 4 条记录");
  const systemDownloadPromise = page.waitForEvent("download");
  await exportTrigger.click();
  await exportMenu.getByRole("menuitem", { name: "当前视图 1 条" }).click();
  const systemDownload = await systemDownloadPromise;
  const systemPath = testInfo.outputPath("terminal-system-view.log");
  await systemDownload.saveAs(systemPath);
  expect(await readFile(systemPath, "utf8")).toBe(
    `${new Date(entries[3].timestamp).toISOString()}\tSYSTEM\t0\t${entries[3].text}`,
  );

  await search.fill("FF FF");
  await exportTrigger.click();
  await expect(exportMenu.getByRole("menuitem", { name: "当前视图 0 条" })).toBeDisabled();
  await expect(exportMenu.getByRole("menuitem", { name: "全部缓存 4 条" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(exportTrigger).toBeFocused();

  await search.fill("66 61");
  await page.setViewportSize({ width: 320, height: 568 });
  const appShell = page.locator(".app-shell");
  const sidebar = page.locator(".sidebar");
  if ((await appShell.getAttribute("data-sidebar-open")) === "true") {
    await page.getByRole("button", { name: "关闭侧栏" }).click();
  }
  await expect(appShell).toHaveAttribute("data-sidebar-open", "false");
  await expect(sidebar).toBeHidden();
  await exportTrigger.click();
  const mobileMenuBounds = await exportMenu.boundingBox();
  expect(mobileMenuBounds).not.toBeNull();
  expect(mobileMenuBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((mobileMenuBounds?.x ?? 0) + (mobileMenuBounds?.width ?? 321)).toBeLessThanOrEqual(320);
  for (const menuItem of await exportMenu.getByRole("menuitem").all()) {
    expect(await menuItem.evaluate((item) => item.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: testInfo.outputPath("terminal-export-mobile.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("频谱按帧顺序分析同时间戳数据并适配窄屏", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "设备连接" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await setWorkbenchState(page, {
    isNativeRuntime: true,
    source: "serial",
    connectionStatus: "connected",
  });
  const signal = Array.from({ length: 256 }, (_, index) => {
    const value = 3 + 2 * Math.sin((2 * Math.PI * 32 * index) / 256);
    return value.toFixed(12);
  }).join("\n");
  await ingestProtocolText(page, `${signal}\n`, 1_000);
  await expect(page.locator(".channel-readout")).toHaveCount(1);

  const timestampCount = await page.evaluate(() => {
    type WorkbenchStoreHandle = {
      getState(): { channels: Array<{ points: Array<{ x: number }> }> };
    };
    const runtime = globalThis as typeof globalThis & {
      __vofaUltraE2eStore?: WorkbenchStoreHandle;
    };
    const points = runtime.__vofaUltraE2eStore?.getState().channels[0]?.points ?? [];
    return new Set(points.map((point) => point.x)).size;
  });
  expect(timestampCount).toBe(1);

  await page.getByRole("button", { name: "频谱" }).click();
  await page.getByRole("spinbutton", { name: "频谱采样率" }).fill("256");
  const spectrumResults = page.getByLabel("频谱分析结果");
  await expect(spectrumResults.getByText("Peak").locator("..")).toContainText("32.000 Hz");
  await expect(spectrumResults.getByText("Amp").locator("..")).toContainText("2.000");

  const spectrumCanvas = page.locator(".spectrum-chart canvas").first();
  await expect(spectrumCanvas).toBeVisible();
  const canvasStats = await readWaveformCanvasStats(page);
  expect(canvasStats.width).toBeGreaterThan(400);
  expect(canvasStats.height).toBeGreaterThan(180);
  expect(canvasStats.opaquePixels).toBeGreaterThan(50);
  expect(canvasStats.chromaticPixels).toBeGreaterThan(100);
  await page.screenshot({
    path: testInfo.outputPath("desktop-spectrum.png"),
    fullPage: true,
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const appShell = page.locator(".app-shell");
    if ((await appShell.getAttribute("data-sidebar-open")) === "true") {
      await page.getByRole("button", { name: "关闭侧栏" }).click({ force: true });
      await expect(appShell).toHaveAttribute("data-sidebar-open", "false");
    }
    const layout = await page.locator(".spectrum-control-strip").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const targets = [...element.querySelectorAll<HTMLElement>("button, select, input")].map(
        (target) => {
          const targetRect = target.getBoundingClientRect();
          return {
            left: targetRect.left,
            top: targetRect.top,
            right: targetRect.right,
            bottom: targetRect.bottom,
            width: targetRect.width,
            height: targetRect.height,
          };
        },
      );
      let overlapCount = 0;
      for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < targets.length; rightIndex += 1) {
          const left = targets[leftIndex];
          const right = targets[rightIndex];
          if (
            left &&
            right &&
            Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
            Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
          ) {
            overlapCount += 1;
          }
        }
      }
      return {
        left: rect.left,
        right: rect.right,
        overflow: element.scrollWidth - element.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        overlapCount,
        targets,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(viewport.width);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(layout.overlapCount).toBe(0);
    expect(layout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(
      true,
    );
    const canvasBounds = await spectrumCanvas.boundingBox();
    expect(canvasBounds).not.toBeNull();
    expect(canvasBounds?.height ?? 0).toBeGreaterThanOrEqual(180);
    expect(canvasBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((canvasBounds?.x ?? 0) + (canvasBounds?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
  }

  await page.screenshot({
    path: testInfo.outputPath("mobile-320-spectrum.png"),
    fullPage: true,
  });
});

test("单次触发在后半窗结束时冻结且后台接收继续", async ({ page }) => {
  await page.goto("/");
  await setWorkbenchState(page, {
    isNativeRuntime: true,
    source: "serial",
    connectionStatus: "connected",
  });
  await ingestProtocolText(page, "1,2,3\n", 1_000);
  await expect(page.locator(".channel-readout")).toHaveCount(3);

  await page.getByRole("button", { name: "5s", exact: true }).click();
  await page.getByRole("button", { name: "打开触发设置" }).click();
  await page.getByRole("spinbutton", { name: "触发阈值" }).fill("5");
  await page.getByRole("button", { name: "布防" }).click();
  await expect(page.locator(".waveform-panel")).toHaveAttribute("data-trigger-phase", "armed");
  expect(await readWaveformTriggerSnapshot(page)).toMatchObject({
    phase: "armed",
    threshold: 5,
    previousValue: null,
    pointValues: [1],
  });

  await ingestProtocolText(page, "2,2,3\n", 1_500);
  await expect(page.locator(".waveform-panel")).toHaveAttribute("data-trigger-phase", "armed");
  await ingestProtocolText(page, "10,2,3\n", 2_000);
  await expect(page.locator(".waveform-panel")).toHaveAttribute(
    "data-trigger-phase",
    "triggered",
  );
  await expect(page.locator(".waveform-trigger-line")).toBeVisible();

  await ingestProtocolText(page, "20,2,3\n", 4_500);
  await expect(page.locator(".waveform-panel")).toHaveAttribute("data-trigger-phase", "frozen");
  await expect(page.getByText("HISTORY")).toBeVisible();
  const frozen = await readWaveformTriggerSnapshot(page);
  expect(frozen).toMatchObject({
    phase: "frozen",
    chartPaused: true,
    pointCount: 4,
    rxFrames: 4,
  });

  await ingestProtocolText(page, "30,2,3\n", 5_000);
  const afterFrozen = await readWaveformTriggerSnapshot(page);
  expect(afterFrozen.pointCount).toBe(frozen.pointCount);
  expect(afterFrozen.terminalEntryCount).toBeGreaterThan(frozen.terminalEntryCount);
  expect(afterFrozen.rxFrames).toBeGreaterThan(frozen.rxFrames);

  await page.getByRole("button", { name: "重新布防" }).click();
  await expect(page.locator(".waveform-panel")).toHaveAttribute("data-trigger-phase", "armed");
  await expect(page.getByText("LIVE")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  const triggerLayout = await page.locator(".waveform-trigger-strip").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll<HTMLElement>("button, select, input")].map(
      (target) => {
        const targetRect = target.getBoundingClientRect();
        return { width: targetRect.width, height: targetRect.height };
      },
    );
    return {
      left: rect.left,
      right: rect.right,
      overflow: element.scrollWidth - element.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(triggerLayout.left).toBeGreaterThanOrEqual(0);
  expect(triggerLayout.right).toBeLessThanOrEqual(390);
  expect(triggerLayout.overflow).toBeLessThanOrEqual(1);
  expect(triggerLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(triggerLayout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(
    true,
  );

  for (const viewport of [
    { width: 390, height: 620 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    const canvasBounds = await page.locator(".waveform-canvas-wrap").boundingBox();
    expect(canvasBounds).not.toBeNull();
    expect(canvasBounds?.height ?? 0).toBeGreaterThanOrEqual(180);
    expect(canvasBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((canvasBounds?.y ?? 0) + (canvasBounds?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
  }
});

test("终端按当前显示内容执行字面量搜索和方向过滤", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await replaceTerminalEntries(page, [
    {
      id: 901,
      direction: "rx",
      timestamp: 1_700_000_000_000,
      text: "Temperature .* 23.5",
      hex: "54 65 6D 70",
      byteCount: 18,
    },
    {
      id: 902,
      direction: "rx",
      timestamp: 1_700_000_000_001,
      text: "Voltage 3.3",
      hex: "56 6F 6C 74",
      byteCount: 11,
    },
    {
      id: 903,
      direction: "tx",
      timestamp: 1_700_000_000_002,
      text: "SET RATE",
      hex: "53 45 54",
      byteCount: 8,
    },
  ]);

  const search = page.getByRole("searchbox", { name: "搜索终端记录" });
  const direction = page.getByRole("group", { name: "终端方向筛选" });
  await search.fill(".*");
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("1 / 3 条记录");
  await expect(page.locator(".terminal-line")).toHaveCount(1);
  await expect(page.locator(".terminal-search-match")).toHaveText(".*");

  await direction.getByRole("button", { name: "TX" }).click();
  await expect(page.getByText("没有匹配的终端记录")).toBeVisible();
  await page.getByRole("button", { name: "清空终端搜索" }).click();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toContainText("SET RATE");

  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await search.fill("53 45");
  await expect(page.locator('.terminal-line[data-direction="tx"] code')).toContainText("53 45 54");
  await expect(page.locator(".terminal-search-match")).toHaveText("53 45");

  await direction.getByRole("button", { name: "全部" }).click();
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "TEXT" })
    .click();
  await replaceTerminalEntries(
    page,
    Array.from({ length: 800 }, (_, index): TerminalEntry => ({
      id: 1_000 + index,
      direction: index % 2 === 0 ? "rx" : "tx",
      timestamp: 1_700_000_001_000 + index,
      text:
        index % 2 === 0
          ? `needle ${index % 4 === 0 ? "long payload ".repeat(30) : "payload"} ${index}`
          : `other ${index}`,
      hex: index % 2 === 0 ? "6E 65 65 64 6C 65" : "6F 74 68 65 72",
      byteCount: 16,
    })),
  );
  await search.fill("needle");
  await expect(page.locator(".terminal-toolbar .panel-subtitle")).toHaveText("400 / 800 条记录");
  await expect.poll(() => page.locator(".terminal-line").count()).toBeGreaterThan(0);
  expect(await page.locator(".terminal-line").count()).toBeLessThan(400);
  expect(await page.locator('.terminal-line[data-direction="rx"]').count()).toBe(
    await page.locator(".terminal-line").count(),
  );
  await expect(page.locator(".terminal-search-match").first()).toHaveText("needle");
  await page.screenshot({
    path: testInfo.outputPath("terminal-search-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".terminal-filter-bar")).toBeVisible();
  const mobileLayout = await page.locator(".terminal-filter-bar").evaluate((bar) => {
    const searchField = bar.querySelector<HTMLElement>(".terminal-search-field");
    const searchInput = bar.querySelector<HTMLElement>(".terminal-search-field input");
    const clearButton = bar.querySelector<HTMLElement>(".terminal-search-field button");
    const selects = [
      ...bar.querySelectorAll<HTMLElement>(".terminal-mobile-filter-selects select"),
    ];
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth,
      searchHeight: searchField?.getBoundingClientRect().height ?? 0,
      searchInputHeight: searchInput?.getBoundingClientRect().height ?? 0,
      clearButtonHeight: clearButton?.getBoundingClientRect().height ?? 0,
      selectHeights: selects.map((select) => select.getBoundingClientRect().height),
    };
  });
  expect(mobileLayout.documentOverflow).toBeLessThanOrEqual(1);
  expect(mobileLayout.barOverflow).toBeLessThanOrEqual(1);
  expect(mobileLayout.searchHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.searchInputHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.clearButtonHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.selectHeights).toHaveLength(2);
  expect(mobileLayout.selectHeights.every((height) => height >= 44)).toBe(true);
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("terminal-search-mobile.png"),
    fullPage: true,
  });
});

test("终端跨行原生选择只包含当前显示的 payload", async ({ page }) => {
  await page.goto("/");
  await replaceTerminalEntries(page, [
    {
      id: 951,
      direction: "rx",
      timestamp: 1_700_000_000_000,
      text: "payload-alpha",
      hex: "01 02 03",
      byteCount: 3,
    },
    {
      id: 952,
      direction: "tx",
      timestamp: 1_700_000_000_100,
      text: "payload-beta",
      hex: "04 05 06 07",
      byteCount: 4,
    },
    {
      id: 953,
      direction: "system",
      timestamp: 1_700_000_000_200,
      text: "payload-gamma",
      hex: "08 09 0A 0B 0C",
      byteCount: 5,
    },
  ]);

  const payloads = page.locator(".terminal-line code");
  await expect(payloads).toHaveText(["payload-alpha", "payload-beta", "payload-gamma"]);
  const selectedText = await payloads.evaluateAll((elements) => {
    const first = elements[0];
    const last = elements.at(-1);
    const selection = window.getSelection();
    if (!first || !last || !selection) {
      throw new Error("终端 payload 尚未准备好原生文本选择");
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    selection.removeAllRanges();
    selection.addRange(range);
    const value = selection.toString();
    selection.removeAllRanges();
    return value;
  });

  expect(selectedText).toContain("payload-alpha");
  expect(selectedText).toContain("payload-beta");
  expect(selectedText).toContain("payload-gamma");
  expect(selectedText).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  expect(selectedText).not.toMatch(/\b(?:RX|TX|SYSTEM)\b/);
  expect(selectedText).not.toMatch(/\b\d+ B\b/);
});

test("终端 RX 行记录按所选编码显示并保持原始字节及窄屏布局", async ({ page }, testInfo) => {
  await page.goto("/");
  const recordMode = page.getByRole("group", { name: "接收记录方式" });
  const lineEnding = page.getByRole("combobox", { name: "接收行尾" });
  const textEncoding = page.getByRole("combobox", { name: "接收文本编码" });
  const displayMode = page.getByRole("group", { name: "接收显示格式" });

  await expect(recordMode.getByRole("button", { name: "按读取块记录" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(lineEnding).toBeDisabled();
  await expect(textEncoding).toHaveValue("utf-8");
  await textEncoding.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("searchbox", { name: "搜索终端记录" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(textEncoding).toBeFocused();
  await ingestProtocolBytes(page, [0x41], 1_000);
  await ingestProtocolBytes(page, [0x42], 1_100);
  await expect(page.locator(".terminal-line")).toHaveCount(2);
  await expect(page.locator(".terminal-line code")).toHaveText(["A", "B"]);

  await page.getByRole("button", { name: "清空终端", exact: true }).click();
  await recordMode.getByRole("button", { name: "按文本行记录" }).click();
  await lineEnding.selectOption("crlf");
  const payload = Array.from(new TextEncoder().encode("温度\r\nnext\r\n"));
  await ingestProtocolBytes(page, payload.slice(0, 2), 2_000);
  await ingestProtocolBytes(page, payload.slice(2, 7), 2_100);
  await expect(page.locator(".terminal-line")).toHaveCount(0);
  await ingestProtocolBytes(page, payload.slice(7), 2_200);

  const lines = page.locator(".terminal-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0).locator("code")).toHaveText("温度\\r\\n");
  await expect(lines.nth(1).locator("code")).toHaveText("next\\r\\n");
  await expect(lines.nth(0).locator("small")).toContainText("8 B");
  await expect(lines.nth(1).locator("small")).toContainText("6 B");

  await displayMode.getByRole("button", { name: "HEX" }).click();
  await expect(lines.nth(0).locator("code")).toHaveText("E6 B8 A9 E5 BA A6 0D 0A");
  await expect(lines.nth(1).locator("code")).toHaveText("6E 65 78 74 0D 0A");

  await page.getByRole("button", { name: "清空终端", exact: true }).click();
  await textEncoding.selectOption("gb18030");
  await displayMode.getByRole("button", { name: "TEXT" }).click();
  await ingestProtocolBytes(page, [0xc4], 3_000);
  await ingestProtocolBytes(page, [0xe3, 0xba], 3_100);
  await ingestProtocolBytes(page, [0xc3, 0x0d], 3_200);
  await ingestProtocolBytes(page, [0x0a], 3_300);
  await expect(page.locator(".terminal-line code")).toHaveText("你好\\r\\n");
  await displayMode.getByRole("button", { name: "HEX" }).click();
  await expect(page.locator(".terminal-line code")).toHaveText("C4 E3 BA C3 0D 0A");
  await textEncoding.selectOption("windows-1252");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.locator(".terminal-filter-bar").evaluate((bar) => {
    const modeButtons = [...bar.querySelectorAll<HTMLElement>(".terminal-rx-record-mode button")];
    const lineEndingSelect = bar.querySelector<HTMLElement>(".terminal-rx-line-ending select");
    const encodingSelect = bar.querySelector<HTMLElement>(".terminal-rx-text-encoding select");
    const lastModeButtonRect = modeButtons.at(-1)?.getBoundingClientRect();
    const lineEndingRect = lineEndingSelect?.getBoundingClientRect();
    const encodingRect = encodingSelect?.getBoundingClientRect();
    const horizontalControlGaps = [
      lastModeButtonRect && lineEndingRect
        ? lineEndingRect.left - lastModeButtonRect.right
        : Number.NEGATIVE_INFINITY,
      lineEndingRect && encodingRect
        ? encodingRect.left - lineEndingRect.right
        : Number.NEGATIVE_INFINITY,
    ];
    const rect = bar.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      overflow: bar.scrollWidth - bar.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      modeButtonHeights: modeButtons.map((button) => button.getBoundingClientRect().height),
      lineEndingHeight: lineEndingSelect?.getBoundingClientRect().height ?? 0,
      encodingHeight: encodingSelect?.getBoundingClientRect().height ?? 0,
      encodingWidth: encodingSelect?.getBoundingClientRect().width ?? 0,
      horizontalControlGaps,
    };
  });
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.right).toBeLessThanOrEqual(390);
  expect(mobileLayout.overflow).toBeLessThanOrEqual(1);
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(mobileLayout.modeButtonHeights.every((height) => height >= 44)).toBe(true);
  expect(mobileLayout.lineEndingHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.encodingHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.encodingWidth).toBeGreaterThanOrEqual(100);
  expect(mobileLayout.horizontalControlGaps.every((gap) => gap >= 0)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("terminal-rx-line-mobile.png"),
    fullPage: true,
  });
});

test("协议坏帧提供可清除诊断并在后续合法帧恢复", async ({ page }) => {
  await page.goto("/");
  await ingestProtocolText(page, "broken\n", 1_000);

  await expect(page.locator(".protocol-warning-status")).toContainText("丢帧 1");
  await page.getByRole("button", { name: "通道", exact: true }).click();
  const health = page.getByRole("region", { name: "协议解析健康度" });
  await expect(health).toContainText("已丢弃 1 帧");
  await expect(health).toContainText("最近：包含非有限数值");
  await expect(health).toContainText("FireWater：每行 1–16 个有限数值，命名字段使用 : 或 =");

  await page.getByRole("button", { name: "清空解析统计" }).click();
  await expect(health).toContainText("等待完整帧");
  await expect(page.locator(".protocol-warning-status")).toHaveCount(0);

  await ingestProtocolText(page, "yaw=1.234 pitch=0.567 cur=0.8\n", 1_100);
  await expect(health).toContainText("解析正常");
  await expect(health).toContainText("成功 1");
  await expect(page.getByLabel("数据通道列表").locator(".channel-visibility-button"))
    .toHaveCount(3);
  await expect(page.getByLabel("数据通道列表").locator(".channel-name")).toHaveText([
    "yaw",
    "pitch",
    "cur",
  ]);
  await expect(page.locator(".terminal-line").last()).toContainText(
    "yaw=1.234 pitch=0.567 cur=0.8",
  );

  await page.setViewportSize({ width: 320, height: 700 });
  const layout = await health.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(320);
  expect(layout.documentWidth).toBeLessThanOrEqual(320);
});

test("通道展示配置按协议隔离并随 v13 工作区往返", async ({ page }, testInfo) => {
  await page.goto("/");
  await ingestProtocolText(page, "voltage:12.5,current:2\n", 1_000);
  await page.getByRole("button", { name: "通道", exact: true }).click();

  await page.getByRole("button", { name: "编辑通道 voltage" }).click();
  await page.getByRole("textbox", { name: "channel-0 通道别名" }).fill("母线电压");
  await page.getByRole("textbox", { name: "channel-0 通道单位" }).fill("V");
  await page.getByLabel("channel-0 通道颜色").fill("#abcdef");
  await page.getByRole("button", { name: "保存 voltage 展示配置" }).click();

  const firewaterRow = page.locator(".channel-row").filter({ hasText: "母线电压" });
  await expect(firewaterRow).toContainText("voltage");
  await expect(firewaterRow).toContainText("12.500");
  await expect(firewaterRow).toContainText("V");
  await expect(firewaterRow.locator(".channel-swatch")).toHaveCSS(
    "background-color",
    "rgb(171, 205, 239)",
  );
  await expect(page.locator(".channel-readout").first()).toContainText("母线电压");

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("radio", { name: /JustFloat/ }).click();
  await ingestProtocolBytes(page, [0x00, 0x00, 0x48, 0x43, 0x00, 0x00, 0x80, 0x7f], 2_000);
  await page.getByRole("button", { name: "通道", exact: true }).click();
  await expect(page.getByText("母线电压", { exact: true })).toHaveCount(0);
  await page.locator(".channel-edit-button").first().click();
  await page.getByRole("textbox", { name: "channel-0 通道别名" }).fill("转速");
  await page.getByRole("textbox", { name: "channel-0 通道单位" }).fill("rpm");
  await page.getByRole("button", { name: /保存 .* 展示配置/ }).click();
  await expect(page.locator(".channel-row").filter({ hasText: "转速" })).toContainText("rpm");

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("radio", { name: /FireWater/ }).click();
  await ingestProtocolText(page, "voltage:13.5\n", 3_000);
  await page.getByRole("button", { name: "通道", exact: true }).click();
  await expect(page.locator(".channel-row").filter({ hasText: "母线电压" })).toBeVisible();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  const nameInput = page.getByRole("textbox", { name: "工作区名称" });
  await nameInput.fill("通道展示基准");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  const downloadPath = testInfo.outputPath("channel-presentation-workspace.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    schemaVersion: number;
    config: {
      channelPresentations: {
        firewater: Record<string, { alias: string; unit: string; color: string | null }>;
        justfloat: Record<string, { alias: string; unit: string; color: string | null }>;
      };
    };
  };
  expect(exported).toMatchObject({
    schemaVersion: 13,
    config: {
      channelPresentations: {
        firewater: {
          "channel-0": { alias: "母线电压", unit: "V", color: "#abcdef" },
        },
        justfloat: {
          "channel-0": { alias: "转速", unit: "rpm", color: null },
        },
      },
    },
  });

  await page.getByRole("button", { name: "通道", exact: true }).click();
  await page.getByRole("button", { name: "编辑通道 母线电压" }).click();
  await page.getByRole("button", { name: "恢复 voltage 默认展示" }).click();
  await expect(page.getByText("母线电压", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByLabel("导入工作区文件").setInputFiles(downloadPath);
  await page.getByRole("button", { name: "通道展示基准 (2) 模拟器 · FireWater" }).click();
  await expect(page.getByRole("heading", { name: "放弃未保存更改？" })).toBeVisible();
  await page.getByRole("button", { name: "放弃并切换" }).click();
  await ingestProtocolText(page, "voltage:14.5\n", 4_000);
  await page.getByRole("button", { name: "通道", exact: true }).click();
  await expect(page.locator(".channel-row").filter({ hasText: "母线电压" })).toBeVisible();

  await page.getByRole("button", { name: "编辑通道 母线电压" }).click();
  await page.screenshot({
    path: testInfo.outputPath("desktop-channel-presentation.png"),
    fullPage: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    const mobileLayout = await page.locator(".channel-editor").evaluate((editor) => {
      const rect = editor.getBoundingClientRect();
      const controls = [...editor.querySelectorAll<HTMLElement>("input, button")];
      return {
        left: rect.left,
        right: rect.right,
        overflow: editor.scrollWidth - editor.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        controlHeights: controls.map((control) => control.getBoundingClientRect().height),
      };
    });
    expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
    expect(mobileLayout.right).toBeLessThanOrEqual(width);
    expect(mobileLayout.overflow).toBeLessThanOrEqual(1);
    expect(mobileLayout.documentWidth).toBeLessThanOrEqual(width);
    expect(mobileLayout.controlHeights.every((height) => height >= 44)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`mobile-${width}-channel-presentation.png`),
      fullPage: true,
    });
  }
});

test("处理图预设与转换节点生成派生通道并随 v13 工作区往返", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "处理", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据处理" })).toBeVisible();

  await page.getByRole("combobox", { name: "处理链预设" }).selectOption("scale-output");
  await page.getByRole("button", { name: "添加处理预设" }).click();
  await expect(page.locator(".processing-node")).toHaveCount(3);

  const kindSelect = page.getByRole("combobox", { name: "新增节点类型" });
  const addButton = page.getByRole("button", { name: "添加处理节点" });
  await kindSelect.selectOption("number_to_byte");
  await addButton.click();
  await page.getByRole("combobox", { name: "node-4 数值类型" }).selectOption("f32");
  await kindSelect.selectOption("bytes_to_number");
  await addButton.click();
  await page.getByRole("combobox", { name: "node-5 数值类型" }).selectOption("u8");
  await kindSelect.selectOption("output");
  await addButton.click();
  await page.getByRole("checkbox", { name: "启用处理图" }).check();
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await page.getByRole("button", { name: "处理", exact: true }).click();
  await expect
    .poll(async () => {
      const text = await page.locator(".processing-counters span").first().textContent();
      return Number(text?.match(/\d+/)?.[0] ?? 0);
    })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "通道" }).click();
  await expect(page.getByText(/基础 [1-9]\d*/)).toBeVisible();
  await expect(page.getByText("派生 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("数据通道列表").locator(".channel-row").filter({ hasText: "缩放 1" }))
    .toHaveCount(1);
  await expect(page.getByLabel("数据通道列表").locator(".channel-row").filter({ hasText: "OUT 2" }))
    .toHaveCount(1);

  await page.getByRole("button", { name: "工作区" }).click();
  const nameInput = page.getByRole("textbox", { name: "工作区名称" });
  await nameInput.fill("处理图基准");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  const downloadPath = testInfo.outputPath("processing-workspace.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    schemaVersion: number;
    config: { processingGraph: ProcessingGraphConfig };
  };
  expect(exported.schemaVersion).toBe(13);
  expect(exported.config.processingGraph).toMatchObject({
    enabled: true,
    nodes: [
      { id: "node-1", kind: "input" },
      { id: "node-2", kind: "affine", gain: 1, offset: 0 },
      { id: "node-3", kind: "output", name: "缩放 1" },
      { id: "node-4", kind: "number_to_byte", numericType: "f32" },
      { id: "node-5", kind: "bytes_to_number", numericType: "u8" },
      { id: "node-6", kind: "output", name: "OUT 2" },
    ],
  });

  await page.getByLabel("导入工作区文件").setInputFiles(downloadPath);
  await expect(page.getByText("处理图基准 (2)", { exact: true })).toBeVisible();
  await page
    .locator(".workspace-row")
    .filter({ hasText: "处理图基准 (2)" })
    .locator(".workspace-select")
    .click();
  await expect(page.locator(".workspace-title span")).toContainText("处理图基准 (2)");
  await page.getByRole("button", { name: "处理", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "启用处理图" })).toBeChecked();
  await expect(page.locator(".processing-node")).toHaveCount(6);
  expect(pageErrors).toEqual([]);
});

test("实时 RX 自动应答保持有界运行并随 v13 工作区往返", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "自动化", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自动应答" })).toBeVisible();
  await page.getByRole("button", { name: "添加自动应答规则" }).click();
  await expect(page.getByLabel("规则名称")).toHaveValue("规则 1");
  await expect(page.getByLabel("触发内容")).toHaveValue("0A");
  await expect(page.getByLabel("响应模板")).toHaveValue("ACK");
  await page.getByRole("button", { name: "添加自动应答规则" }).click();
  await expect(page.getByLabel("规则名称")).toHaveValue("规则 2");
  await page.getByLabel("规则名称").fill("尚未保存");
  const rule_list = page.getByRole("list", { name: "自动应答规则" });
  await rule_list.locator(".automation-rule-select").filter({ hasText: "规则 1" }).click();
  await expect(page.getByLabel("规则名称")).toHaveValue("尚未保存");
  await expect(page.getByText("请先保存或还原当前规则修改")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("automation-draft-protection.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "还原规则修改" }).click();
  await rule_list.locator(".automation-rule-select").filter({ hasText: "规则 1" }).click();
  await expect(page.getByLabel("规则名称")).toHaveValue("规则 1");
  await page.getByRole("button", { name: "删除规则 规则 2" }).click();

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await page.getByRole("button", { name: "自动化", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用自动应答" }).check();
  await expect(page.getByText("等待触发")).toBeVisible();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toContainText("ACK", {
    timeout: 5_000,
  });
  await expect
    .poll(async () => {
      const text = await page.getByLabel("自动应答计数").textContent();
      return Number(text?.match(/发送\s*(\d+)/)?.[1] ?? 0);
    })
    .toBeGreaterThan(0);
  await expect(page.getByLabel("规则名称")).toBeDisabled();

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  const downloadPath = testInfo.outputPath("auto-responder-workspace.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    schemaVersion: number;
    config: {
      autoResponderRules: Array<{
        triggerMode: string;
        trigger: string;
        response: string;
        cooldownMs: number;
      }>;
    };
  };
  expect(exported).toMatchObject({
    schemaVersion: 13,
    config: {
      autoResponderRules: [
        {
          triggerMode: "hex",
          trigger: "0A",
          response: "ACK",
          cooldownMs: 1_000,
        },
      ],
    },
  });

  await page.getByRole("button", { name: "自动化", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用自动应答" }).uncheck();
  await expect(page.getByText("已停止")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("姿态视图渲染同帧数据并支持冻结与窄屏配置", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await page.getByRole("tab", { name: "姿态" }).click();

  const configuration = page.getByRole("dialog", { name: "姿态通道配置" });
  await expect(configuration).toBeVisible();
  await configuration.getByRole("combobox", { name: "Roll 姿态通道" }).selectOption("channel-0");
  await configuration.getByRole("combobox", { name: "Pitch 姿态通道" }).selectOption("channel-1");
  await configuration.getByRole("combobox", { name: "Yaw 姿态通道" }).selectOption("channel-2");
  await configuration.getByRole("button", { name: "关闭姿态配置" }).click();

  const scene = page.getByRole("img", { name: "三维姿态视图" });
  const canvas = scene.locator("canvas");
  await expect(scene).toHaveAttribute("data-renderer", "ready");
  await expect(page.locator(".attitude-panel .live-state")).toContainText("LIVE", {
    timeout: 5_000,
  });
  const initialCanvas = await canvasScreenshotStats(canvas);
  expect(initialCanvas.width).toBeGreaterThan(400);
  expect(initialCanvas.height).toBeGreaterThan(200);
  expect(initialCanvas.bytes).toBeGreaterThan(10_000);

  const rollReadout = page.getByLabel("当前姿态值").locator("dd").first();
  await page.getByRole("button", { name: "冻结姿态显示" }).click();
  await expect(page.locator(".attitude-panel .live-state")).toContainText("HOLD");
  const frozenRoll = await rollReadout.textContent();
  const frozenOrientation = await scene.getAttribute("data-rendered-orientation");
  expect(frozenOrientation).not.toBeNull();
  await page.waitForTimeout(500);
  await expect(rollReadout).toHaveText(frozenRoll ?? "");
  await expect(scene).toHaveAttribute("data-rendered-orientation", frozenOrientation ?? "");

  await page.getByRole("button", { name: "继续姿态显示" }).click();
  await expect(page.locator(".attitude-panel .live-state")).toContainText("LIVE");
  await expect.poll(async () => rollReadout.textContent()).not.toBe(frozenRoll);
  await expect
    .poll(async () => scene.getAttribute("data-rendered-orientation"))
    .not.toBe(frozenOrientation);

  const contextLossSupported = await canvas.evaluate((element) => {
    const testCanvas = element as HTMLCanvasElement & {
      contextLossExtension?: WEBGL_lose_context;
    };
    const extension = testCanvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!extension) {
      return false;
    }
    testCanvas.contextLossExtension = extension;
    extension.loseContext();
    return true;
  });
  expect(contextLossSupported).toBe(true);
  await expect(scene).toHaveAttribute("data-renderer", "lost");
  await expect(page.locator(".attitude-state-overlay[role=\"alert\"]")).toContainText(
    "显卡上下文已丢失，正在等待自动恢复",
  );

  await canvas.evaluate((element) => {
    const testCanvas = element as HTMLCanvasElement & {
      contextLossExtension?: WEBGL_lose_context;
    };
    const extension = testCanvas.contextLossExtension;
    delete testCanvas.contextLossExtension;
    extension?.restoreContext();
  });
  await expect(scene).toHaveAttribute("data-renderer", "ready");
  await expect(page.locator(".attitude-state-overlay[role=\"alert\"]")).toHaveCount(0);
  await expect
    .poll(async () => (await canvasScreenshotStats(canvas)).bytes)
    .toBeGreaterThan(10_000);
  const restoredOrientation = await scene.getAttribute("data-rendered-orientation");
  expect(restoredOrientation).not.toBeNull();
  await expect
    .poll(async () => scene.getAttribute("data-rendered-orientation"))
    .not.toBe(restoredOrientation);
  await scene.screenshot({ path: testInfo.outputPath("desktop-attitude-restored.png") });

  const mobileViewports = [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ];
  await page.setViewportSize(mobileViewports[0]);
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");

  for (const viewport of mobileViewports) {
    await page.setViewportSize(viewport);
    if (!(await configuration.isVisible())) {
      await page.getByRole("button", { name: "配置姿态通道" }).click();
    }
    const layout = await configuration.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const targets = [...element.querySelectorAll("button, select")].map((target) => {
        const targetRect = target.getBoundingClientRect();
        return { width: targetRect.width, height: targetRect.height };
      });
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        documentWidth: document.documentElement.scrollWidth,
        targets,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(viewport.width);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(viewport.height);
    expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(layout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
    await configuration.getByRole("button", { name: "关闭姿态配置" }).click();
    await expect(configuration).not.toBeVisible();
    const mobileCanvas = await canvasScreenshotStats(canvas);
    expect(mobileCanvas.width).toBeGreaterThan(200);
    expect(mobileCanvas.height).toBeGreaterThan(100);
    expect(mobileCanvas.bytes).toBeGreaterThan(5_000);
    await page.screenshot({
      path: testInfo.outputPath(`mobile-${viewport.width}-attitude.png`),
      fullPage: true,
    });
  }
  expect(pageErrors).toEqual([]);
});

test("通道监视显示有界统计并支持本地冻结与窄屏布局", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await page.getByRole("tab", { name: "监视" }).click();

  const monitor = page.locator(".channel-monitor-panel");
  const table = page.getByRole("table", { name: "通道实时统计" });
  const firstRow = table
    .getByRole("rowgroup", { name: "基础通道" })
    .locator(".channel-monitor-data-row")
    .first();
  const currentValue = firstRow.locator(".channel-monitor-current-cell");
  const sampleCount = firstRow.locator(".channel-monitor-samples-cell");
  await expect(monitor.getByRole("heading", { name: "通道监视" })).toBeVisible();
  await expect(table).toBeVisible();
  await expect(firstRow).toBeVisible();
  await expect
    .poll(async () => Number.parseInt((await sampleCount.textContent()) ?? "0", 10))
    .toBeGreaterThan(2);
  await expect(table.getByRole("columnheader", { name: "当前" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "变化" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "均值" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "RMS" })).toBeVisible();

  await page.getByRole("button", { name: "冻结通道监视" }).click();
  await expect(monitor.locator(".live-state")).toContainText("HOLD");
  const frozenValue = await currentValue.textContent();
  const frozenSamples = await sampleCount.textContent();
  await page.waitForTimeout(500);
  await expect(currentValue).toHaveText(frozenValue ?? "");
  await expect(sampleCount).toHaveText(frozenSamples ?? "");

  await page.getByRole("button", { name: "继续通道监视" }).click();
  await expect(monitor.locator(".live-state")).toContainText("LIVE");
  await expect.poll(async () => currentValue.textContent()).not.toBe(frozenValue);
  await expect
    .poll(async () => Number.parseInt((await sampleCount.textContent()) ?? "0", 10))
    .toBeGreaterThan(Number.parseInt(frozenSamples ?? "0", 10));
  await page.screenshot({
    path: testInfo.outputPath("desktop-channel-monitor.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");
  await expect(table.getByRole("columnheader", { name: "当前" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "变化" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "样本" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "最小" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "最大" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "均值" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "RMS" })).toBeHidden();
  const mobileLayout = await monitor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll<HTMLElement>("button")].map((target) => {
      const targetRect = target.getBoundingClientRect();
      return { width: targetRect.width, height: targetRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.right).toBeLessThanOrEqual(390);
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(mobileLayout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("mobile-390-channel-monitor.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test("有界命令历史与可取消周期发送形成完整工作流", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();

  const input = page.getByRole("textbox", { name: "发送内容" });
  await input.fill("PING");
  await page.getByRole("button", { name: "展开周期发送设置" }).click();
  await page.getByRole("spinbutton", { name: "发送间隔（毫秒）" }).fill("20");
  await page.getByRole("spinbutton", { name: "发送次数" }).fill("3");
  await page.getByRole("button", { name: "启动" }).click();

  const taskStatus = page.getByRole("status", { name: "周期发送状态" });
  await expect(taskStatus).toContainText("已完成 3 次发送", { timeout: 5_000 });
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(3);
  const historyTrigger = page.getByRole("button", { name: "命令历史，1 条" });
  await historyTrigger.click();
  const historyDialog = page.getByRole("dialog", { name: "命令历史" });
  const historyEntry = historyDialog.getByRole("button", { name: /PING/ });
  await expect(historyDialog).toContainText("×3");
  await expect(historyEntry).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(historyDialog).toHaveCount(0);
  await expect(historyTrigger).toBeFocused();
  await historyTrigger.click();
  await expect(historyDialog.getByRole("button", { name: /PING/ })).toBeFocused();
  await historyTrigger.click();

  await page.getByRole("button", { name: "持续" }).click();
  await page.getByRole("button", { name: "启动" }).click();
  await expect(taskStatus).toContainText("运行中");
  await expect
    .poll(() => page.locator('.terminal-line[data-direction="tx"]').count())
    .toBeGreaterThan(3);
  await input.fill("CHANGED");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(taskStatus).toContainText("已手动停止");

  const stoppedStatus = await taskStatus.textContent();
  await page.waitForTimeout(120);
  await expect(taskStatus).toHaveText(stoppedStatus ?? "");

  await input.fill("");
  await page.getByRole("combobox", { name: "行尾", exact: true }).selectOption("cr");
  await page.getByRole("group", { name: "发送次数模式" }).getByRole("button", {
    name: "次数",
  }).click();
  await page.getByRole("spinbutton", { name: "发送次数" }).fill("1");
  await page.getByRole("button", { name: "启动" }).click();
  await expect(taskStatus).toContainText("已完成 1 次发送", { timeout: 5_000 });
  await page.getByRole("button", { name: "命令历史，2 条" }).click();
  await expect(page.getByRole("dialog", { name: "命令历史" })).toContainText("<CR>");
});

test("GB18030 文本发送使用实际字节并从历史恢复编码", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();

  const encoding = page.getByRole("combobox", { name: "发送文本编码" });
  const input = page.getByRole("textbox", { name: "发送内容" });
  await encoding.selectOption("gb18030");
  await input.fill("中文€");
  await expect(page.getByLabel("命令模板包含 0 个变量，最终 6 字节")).toBeVisible();
  await page.getByRole("button", { name: "发送", exact: true }).click();

  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await expect(page.locator('.terminal-line[data-direction="tx"] code').last()).toHaveText(
    "D6 D0 CE C4 A2 E3",
  );

  await encoding.selectOption("utf-8");
  await page.getByRole("button", { name: "命令历史，1 条" }).click();
  const history = page.getByRole("dialog", { name: "命令历史" });
  await expect(history).toContainText("GB18030");
  await history.getByRole("button", { name: /中文/ }).click();
  await expect(encoding).toHaveValue("gb18030");
});

test("发送栏自动校验尾按帧顺序发送并随 v13 工作区往返", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();

  await page
    .getByRole("group", { name: "发送格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  const checksum = page.getByRole("combobox", { name: "校验" });
  await checksum.selectOption("crc16-modbus-le");
  await page.getByRole("combobox", { name: "行尾", exact: true }).selectOption("lf");
  await page
    .getByRole("textbox", { name: "发送内容" })
    .fill("31 32 33 34 35 36 37 38 39");
  await expect(
    page.getByLabel("命令模板包含 0 个变量，最终 12 字节，校验尾 37 4B"),
  ).toBeVisible();

  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await expect(page.locator('.terminal-line[data-direction="tx"] code').last()).toHaveText(
    "31 32 33 34 35 36 37 38 39 37 4B 0A",
  );

  await checksum.selectOption("none");
  await page.getByRole("button", { name: "命令历史，1 条" }).click();
  const history = page.getByRole("dialog", { name: "命令历史" });
  await expect(history).toContainText("CRC16-MODBUS-LE");
  await history.getByRole("button", { name: /31 32 33 34/ }).click();
  await expect(checksum).toHaveValue("crc16-modbus-le");

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByRole("textbox", { name: "工作区名称" }).fill("校验工作区");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  const downloadPath = testInfo.outputPath("checksum-workspace.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    schemaVersion: number;
    config: { commandChecksum: string };
  };
  expect(exported).toMatchObject({
    schemaVersion: 13,
    config: { commandChecksum: "crc16-modbus-le" },
  });

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await checksum.selectOption("none");
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await page.getByLabel("导入工作区文件").setInputFiles(downloadPath);
  await page.getByRole("button", { name: "校验工作区 (2) 模拟器 · FireWater" }).click();
  await page.getByRole("button", { name: "放弃并切换" }).click();
  await expect(checksum).toHaveValue("crc16-modbus-le");
});

test("Modbus RTU 构帧、单事务和只读轮询经统一链路工作且窄屏可操作", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();
  await page.getByRole("combobox", { name: "校验" }).selectOption("crc16-modbus-le");
  await page.getByRole("button", { name: "打开 Modbus RTU 构帧器" }).click();
  let builder = page.getByRole("dialog", { name: "Modbus RTU 构帧器" });
  await expect(builder.getByLabel("Modbus RTU 帧预览")).toHaveText(
    "01 03 00 00 00 01 84 0A",
  );
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(0);
  await builder.getByRole("button", { name: "填入发送框" }).click();
  await expect(page.getByRole("textbox", { name: "发送内容" })).toHaveValue(
    "01 03 00 00 00 01 84 0A",
  );
  await expect(page.getByRole("combobox", { name: "行尾", exact: true })).toHaveValue("none");
  await expect(page.getByRole("combobox", { name: "校验" })).toHaveValue("none");
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await expect(page.locator('.terminal-line[data-direction="tx"] code')).toHaveText(
    "01 03 00 00 00 01 84 0A",
  );

  await page.getByRole("button", { name: "打开 Modbus RTU 构帧器" }).click();
  builder = page.getByRole("dialog", { name: "Modbus RTU 构帧器" });
  await builder.getByRole("button", { name: "执行一次" }).click();
  await expect(builder.getByText("完成")).toBeVisible();
  await expect(page.getByRole("button", { name: "命令历史，1 条" })).toBeVisible();
  await builder.getByText("完成").click();
  await expect(builder.getByText("0:0")).toBeVisible();
  await expect(builder.getByText("01 03 02 00 00 B8 44")).toBeVisible();

  await builder.getByRole("spinbutton", { name: "Modbus 轮询间隔毫秒" }).fill("100");
  await builder.getByRole("button", { name: "开始轮询" }).click();
  const pollStatus = builder.getByLabel("Modbus RTU 只读轮询状态");
  await expect(pollStatus).toContainText("成功 2");
  await expect(pollStatus.getByText("0:0", { exact: true })).toBeVisible();
  await builder.getByRole("button", { name: "停止轮询" }).click();
  await expect(pollStatus).toContainText("已停止");
  const completedTransactions = builder.locator(
    '.modbus-transaction-result[data-status="completed"]',
  );
  expect(await completedTransactions.count()).toBeGreaterThanOrEqual(3);
  for (const index of [0, 1]) {
    await expect(completedTransactions.nth(index).getByText("TX", { exact: true })).toBeAttached();
    await expect(completedTransactions.nth(index).getByText("RX", { exact: true })).toBeAttached();
  }
  const stoppedCounters = await pollStatus.locator("header > span").last().textContent();
  await page.waitForTimeout(250);
  await expect(pollStatus.locator("header > span").last()).toHaveText(stoppedCounters ?? "");
  await builder.getByRole("button", { name: "关闭 Modbus RTU 构帧器" }).click();

  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.getByRole("button", { name: "打开 Modbus RTU 构帧器" }).click();
  builder = page.getByRole("dialog", { name: "Modbus RTU 构帧器" });
  await builder.getByRole("textbox", { name: "Modbus 站号" }).fill("0");
  await expect(builder.getByRole("status")).toContainText("读取请求不能使用广播站号 0");
  await expect(builder.getByRole("button", { name: "填入发送框" })).toBeDisabled();

  const layout = await builder.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll("button, input, select")]
      .filter((target) => {
        const targetRect = target.getBoundingClientRect();
        return targetRect.width > 0 && targetRect.height > 0;
      })
      .map((target) => {
        const targetRect = target.getBoundingClientRect();
        return { width: targetRect.width, height: targetRect.height };
      });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(320);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(568);
  expect(layout.documentWidth).toBeLessThanOrEqual(320);
  expect(layout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-modbus-builder.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("快捷命令持久载入且只经显式发送产生 TX", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  const input = page.getByRole("textbox", { name: "发送内容" });
  await input.fill("PING-${seq}");
  await page.getByRole("combobox", { name: "行尾", exact: true }).selectOption("cr");
  await page.getByRole("button", { name: "打开快捷命令" }).click();
  const dialog = page.getByRole("dialog", { name: "快捷命令" });
  await dialog.getByRole("textbox", { name: "快捷命令名称" }).fill("状态查询");
  await dialog.getByRole("button", { name: "保存当前草稿为快捷命令" }).click();
  await expect(dialog.getByRole("button", { name: "载入快捷命令 状态查询" })).toBeVisible();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(0);

  await dialog.getByRole("button", { name: "关闭快捷命令" }).click();
  await input.fill("AA");
  await page
    .getByRole("group", { name: "发送格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await page.getByRole("combobox", { name: "行尾", exact: true }).selectOption("none");
  await page.getByRole("button", { name: "打开快捷命令" }).click();
  await page.getByRole("button", { name: "载入快捷命令 状态查询" }).click();
  await expect(input).toHaveValue("PING-${seq}");
  await expect(
    page.getByRole("group", { name: "发送格式" }).getByRole("button", { name: "文本" }),
  ).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("combobox", { name: "行尾", exact: true })).toHaveValue("cr");
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(0);

  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "命令历史，1 条" })).toBeVisible();
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await expect(page.locator('.terminal-line[data-direction="tx"] code')).toHaveText(
    "50 49 4E 47 2D 31 0D",
  );

  await page.reload();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.getByRole("button", { name: "打开快捷命令" }).click();
  const restoredDialog = page.getByRole("dialog", { name: "快捷命令" });
  await expect(restoredDialog.getByRole("button", { name: "载入快捷命令 状态查询" })).toBeVisible();
  const layout = await restoredDialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll("button, input")]
      .filter((target) => {
        const targetRect = target.getBoundingClientRect();
        return targetRect.width > 0 && targetRect.height > 0;
      })
      .map((target) => {
        const targetRect = target.getBoundingClientRect();
        return {
          label: target.getAttribute("aria-label") ?? target.getAttribute("name") ?? target.tagName,
          width: targetRect.width,
          height: targetRect.height,
        };
      });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(320);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(568);
  expect(layout.documentWidth).toBeLessThanOrEqual(320);
  expect(
    layout.targets.filter((target) => target.width < 44 || target.height < 44),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("mobile-quick-commands.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("安全命令变量逐次展开且非法表达式零发送", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await expect(page.getByText("模拟数据正在运行")).toBeVisible();

  const input = page.getByRole("textbox", { name: "发送内容" });
  await input.fill("${seq}");
  await expect(
    page.getByLabel("命令模板包含 1 个变量，最终 1 字节"),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开周期发送设置" }).click();
  await page.getByRole("spinbutton", { name: "发送间隔（毫秒）" }).fill("20");
  await page.getByRole("spinbutton", { name: "发送次数" }).fill("3");
  await page.getByRole("button", { name: "启动" }).click();

  const taskStatus = page.getByRole("status", { name: "周期发送状态" });
  await expect(taskStatus).toContainText("已完成 3 次发送", { timeout: 5_000 });
  const txLines = page.locator('.terminal-line[data-direction="tx"]');
  await expect(txLines).toHaveCount(3);
  await expect(txLines.locator("code")).toHaveText(["1", "2", "3"]);

  const sendFormat = page.getByRole("group", { name: "发送格式" });
  await sendFormat.getByRole("button", { name: "HEX" }).click();
  await input.fill("${seq:u16le}");
  await expect(
    page.getByLabel("命令模板包含 1 个变量，最终 2 字节"),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await page.getByRole("button", { name: "清空终端", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "暂停终端显示" }).click();
  await expect(txLines.locator("code")).toHaveText("01 00");
  const txStats = page.locator(".transfer-stats span").filter({ hasText: "TX" });
  const transmittedBeforeInvalidTemplate = await txStats.textContent();

  await sendFormat.getByRole("button", { name: "文本" }).click();
  await input.fill("${globalThis.process}");
  await expect(page.getByRole("alert")).toContainText("命令变量名称无效");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "启动" })).toBeDisabled();
  await page.waitForTimeout(80);
  await expect(txStats).toHaveText(transmittedBeforeInvalidTemplate ?? "");
  await expect(page.getByRole("button", { name: "命令历史，2 条" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("窄屏布局无页面级横向溢出", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "启动模拟" }).click();
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");
  await expect
    .poll(() =>
      page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "实时波形" })).toBeVisible();
  await page.getByRole("button", { name: "独立" }).click();
  const waveformScaleLayout = await page.locator(".waveform-scale-tools").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll("button, select")).map((control) => {
      const controlRect = control.getBoundingClientRect();
      return { width: controlRect.width, height: controlRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      overflow: element.scrollWidth - element.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      controls,
    };
  });
  expect(waveformScaleLayout.left).toBeGreaterThanOrEqual(0);
  expect(waveformScaleLayout.right).toBeLessThanOrEqual(waveformScaleLayout.viewportWidth);
  expect(waveformScaleLayout.overflow).toBeLessThanOrEqual(1);
  expect(waveformScaleLayout.documentWidth).toBeLessThanOrEqual(
    waveformScaleLayout.viewportWidth,
  );
  expect(
    waveformScaleLayout.controls.every(
      (control) => control.width >= 44 && control.height >= 44,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-independent-scales.png"),
    fullPage: true,
  });
  const mobilePlotBounds = await page.locator(".waveform-chart .u-over").boundingBox();
  expect(mobilePlotBounds).not.toBeNull();
  if (mobilePlotBounds) {
    await page.mouse.move(
      mobilePlotBounds.x + mobilePlotBounds.width * 0.2,
      mobilePlotBounds.y + mobilePlotBounds.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      mobilePlotBounds.x + mobilePlotBounds.width * 0.75,
      mobilePlotBounds.y + mobilePlotBounds.height * 0.5,
      { steps: 6 },
    );
    await page.mouse.up();
  }
  const mobileReturnToLive = page.getByRole("button", { name: "回到实时波形" });
  await expect(mobileReturnToLive).toBeVisible();
  await expect
    .poll(async () => (await readWaveformCanvasStats(page)).chromaticPixels)
    .toBeGreaterThan(100);
  const mobileReturnBounds = await mobileReturnToLive.boundingBox();
  expect(mobileReturnBounds?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(mobileReturnBounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await mobileReturnToLive.click();
  await expect(mobileReturnToLive).not.toBeVisible();
  const measurementButton = page.getByRole("button", { name: "开启波形测量" });
  await expect(measurementButton).toBeEnabled({ timeout: 5_000 });
  await measurementButton.click();
  await expect(page.getByLabel("波形测量结果")).toBeVisible();
  await expect(page.getByLabel("A/B 区间统计")).toBeVisible();
  const measurementBounds = await page.locator(".waveform-measurement-strip").boundingBox();
  expect(measurementBounds).not.toBeNull();
  expect(measurementBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((measurementBounds?.x ?? 0) + (measurementBounds?.width ?? 391)).toBeLessThanOrEqual(390);
  const measurementTargets = await page
    .locator(
      ".waveform-measurement-strip button, " +
        ".waveform-measurement-strip select, " +
        ".waveform-measurement-strip input",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
  expect(measurementTargets.every((rect) => rect.width >= 44 && rect.height >= 44)).toBe(true);
  await page.getByRole("button", { name: "关闭波形测量" }).click();
  const sendFormat = page.getByRole("group", { name: "发送格式" });
  const lineEnding = page.getByRole("combobox", { name: "行尾", exact: true });
  await expect(sendFormat).toBeVisible();
  await expect(lineEnding).toBeVisible();
  await page.getByRole("button", { name: "HEX", exact: true }).last().click();
  await lineEnding.selectOption("crlf");
  await page.getByRole("textbox", { name: "发送内容" }).fill("AA");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "命令历史，1 条" }).click();
  await page
    .getByRole("dialog", { name: "命令历史" })
    .getByRole("button", { name: /AA/ })
    .click();
  await expect(sendFormat.getByRole("button", { name: "HEX" })).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(lineEnding).toHaveValue("crlf");
  await sendFormat.getByRole("button", { name: "文本" }).click();
  await lineEnding.selectOption("none");
  await page.getByRole("button", { name: "展开周期发送设置" }).click();
  await expect(page.locator(".command-workflow")).toBeVisible();
  const converterTxStats = page.locator(".transfer-stats span").filter({ hasText: "TX" });
  const txStatsBeforeConverter = await converterTxStats.textContent();
  await page.getByRole("button", { name: "打开命令参考与校验" }).click();
  const variableDialog = page.getByRole("dialog", { name: "命令参考与校验" });
  await expect(variableDialog).toBeVisible();
  const firstVariable = variableDialog.getByRole("button", { name: /插入发送序号/ });
  await expect(firstVariable).toBeFocused();
  expect(await clippedVisibleHeight(firstVariable)).toBeGreaterThanOrEqual(52);
  await variableDialog.getByRole("tab", { name: "ASCII" }).click();
  const asciiSearch = variableDialog.getByRole("searchbox", { name: "搜索 ASCII 字符" });
  await expect(asciiSearch).toBeFocused();
  await asciiSearch.fill("0D");
  await expect(variableDialog.getByRole("row", { name: "CR 13 0D 回车" })).toBeVisible();
  const asciiSearchBounds = await asciiSearch.boundingBox();
  expect(asciiSearchBounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  await variableDialog.getByRole("tab", { name: "转换" }).click();
  const converterPanel = variableDialog.getByRole("tabpanel", { name: "转换" });
  const converterInput = converterPanel.getByRole("textbox", { name: "转换输入" });
  await expect(converterInput).toBeFocused();
  await converterInput.fill("00 00 80 3F");
  await expect(converterPanel.getByRole("textbox", { name: "规范化 HEX" })).toHaveValue(
    "00 00 80 3F",
  );
  await expect(converterPanel.getByRole("textbox", { name: "数值结果" })).toHaveValue("1");
  await converterPanel.getByRole("combobox", { name: "数值类型" }).selectOption("i16");
  await converterPanel.getByRole("button", { name: "数值转字节" }).click();
  await converterPanel.getByRole("button", { name: "大端 BE" }).click();
  await converterInput.fill("-2");
  await expect(converterPanel.getByRole("textbox", { name: "规范化 HEX" })).toHaveValue("FF FE");
  await expect(converterTxStats).toHaveText(txStatsBeforeConverter ?? "");
  await expect(page.getByRole("button", { name: "命令历史，1 条" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "发送内容" })).toHaveValue("AA");
  const converterLayout = await converterPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targetElements = Array.from(element.querySelectorAll("button, select, textarea"));
    const targets = targetElements.map((target) => {
      const bounds = target.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    const summaryBounds = element
      .querySelector(".data-converter-summary")
      ?.getBoundingClientRect();
    const overlappingSummary = summaryBounds
      ? targetElements
          .filter((target) => {
            const bounds = target.getBoundingClientRect();
            return bounds.bottom > summaryBounds.top && bounds.top < summaryBounds.bottom;
          })
          .map((target) => target.getAttribute("aria-label") ?? target.textContent?.trim())
      : ["missing summary"];
    const occludedTargets = targetElements
      .filter((target) => {
        const bounds = target.getBoundingClientRect();
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        if (
          centerX < rect.left ||
          centerX > rect.right ||
          centerY < rect.top ||
          centerY > rect.bottom
        ) {
          return false;
        }
        const hitTarget = document.elementFromPoint(centerX, centerY);
        return hitTarget !== target && !target.contains(hitTarget);
      })
      .map((target) => target.getAttribute("aria-label") ?? target.textContent?.trim());
    return {
      left: rect.left,
      right: rect.right,
      panelWidth: element.clientWidth,
      panelScrollWidth: element.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      targets,
      overlappingSummary,
      occludedTargets,
    };
  });
  expect(converterLayout.left).toBeGreaterThanOrEqual(0);
  expect(converterLayout.right).toBeLessThanOrEqual(390);
  expect(converterLayout.panelScrollWidth).toBeLessThanOrEqual(converterLayout.panelWidth + 1);
  expect(converterLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(
    converterLayout.targets.filter((target) => target.width < 44 || target.height < 44),
  ).toEqual([]);
  expect(converterLayout.overlappingSummary).toEqual([]);
  expect(converterLayout.occludedTargets).toEqual([]);
  await variableDialog.getByRole("tab", { name: "校验" }).click();
  const checksumInput = variableDialog.getByRole("textbox", { name: "校验输入" });
  await expect(checksumInput).toBeFocused();
  await checksumInput.fill("31 32 33 34 35 36 37 38 39");
  await expect(variableDialog.getByText("0x4B37")).toBeVisible();
  await expect(variableDialog.getByText("低字节在前 37 4B")).toBeVisible();
  await expect(variableDialog.getByText("0xCBF43926")).toBeVisible();
  const xorResult = variableDialog.getByText("0x31", { exact: true });
  const sumResult = variableDialog.getByText("0xDD", { exact: true });
  await expect(xorResult).toBeVisible();
  await expect(sumResult).toBeVisible();
  expect(await clippedVisibleHeight(xorResult)).toBeGreaterThanOrEqual(12);
  expect(await clippedVisibleHeight(sumResult)).toBeGreaterThanOrEqual(12);
  await expect(page.getByRole("textbox", { name: "发送内容" })).toHaveValue("AA");
  const checksumInputBounds = await checksumInput.boundingBox();
  expect(checksumInputBounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "处理", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据处理" })).toBeVisible();
  const processingKind = page.getByRole("combobox", { name: "新增节点类型" });
  const addProcessingNode = page.getByRole("button", { name: "添加处理节点" });
  await addProcessingNode.click();
  await processingKind.selectOption("affine");
  await addProcessingNode.click();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  const undersizedTargets = await page
    .locator('button, select, textarea, input[type="number"]')
    .evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        return visible && (rect.width < 44 || rect.height < 44)
          ? {
              name: element.getAttribute("aria-label") ?? element.textContent?.trim(),
              width: rect.width,
              height: rect.height,
            }
          : null;
      })
      .filter(Boolean),
    );
  expect(undersizedTargets).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("mobile-workbench.png"),
    fullPage: true,
  });
});

test("中窄屏关闭侧栏后活动导航保持可操作", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("visibility", "hidden");
  await expect
    .poll(() =>
      page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);

  const sendComposerLayout = await page.locator(".send-main-row").evaluate((element) => {
    const options = element.querySelector<HTMLElement>(".send-options");
    const payload = element.querySelector<HTMLElement>(".send-payload-field");
    if (!options || !payload) {
      return null;
    }
    const optionsRect = options.getBoundingClientRect();
    const payloadRect = payload.getBoundingClientRect();
    return {
      optionsBottom: optionsRect.bottom,
      optionsScrollWidth: options.scrollWidth,
      optionsWidth: options.clientWidth,
      payloadTop: payloadRect.top,
    };
  });
  expect(sendComposerLayout).not.toBeNull();
  expect(sendComposerLayout?.optionsScrollWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    (sendComposerLayout?.optionsWidth ?? 0) + 1,
  );
  expect(sendComposerLayout?.optionsBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    sendComposerLayout?.payloadTop ?? 0,
  );

  await page.getByRole("button", { name: "通道" }).click();
  await expect(page.getByRole("heading", { name: "数据通道" })).toBeVisible();
});

test("320 px 窄屏测量与底部导航保持可操作", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  const navigationButtons = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button");
  await expect(navigationButtons).toHaveCount(8);
  const bounds = await navigationButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    }),
  );
  expect(bounds.every((rect) => rect.left >= 0 && rect.right <= 320 && rect.width >= 44)).toBe(
    true,
  );
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  await page.getByRole("button", { name: "启动模拟" }).click();
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await page.getByRole("button", { name: "设置 Y 轴量程" }).click();
  const rangeForm = page.getByRole("form", { name: "Y 轴量程设置" });
  await expect(rangeForm).toBeVisible();
  const rangeLayout = await rangeForm.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll("button, input")].map((target) => {
      const targetRect = target.getBoundingClientRect();
      return { width: targetRect.width, height: targetRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(rangeLayout.left).toBeGreaterThanOrEqual(0);
  expect(rangeLayout.right).toBeLessThanOrEqual(320);
  expect(rangeLayout.documentWidth).toBeLessThanOrEqual(320);
  expect(rangeLayout.targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("mobile-320-waveform-range.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(rangeForm).toBeHidden();
  const measurementButton = page.getByRole("button", { name: "开启波形测量" });
  await expect(measurementButton).toBeEnabled({ timeout: 5_000 });
  await measurementButton.click();
  const measurementStrip = page.locator(".waveform-measurement-strip");
  await expect(measurementStrip).toBeVisible();
  await expect(page.getByLabel("波形测量结果")).not.toContainText(/NaN|Infinity/);
  await expect(page.getByLabel("A/B 区间统计")).not.toContainText(/NaN|Infinity/);

  const measurementLayout = await measurementStrip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [
      ...element.querySelectorAll("button, select, input"),
    ].map((target) => {
      const targetRect = target.getBoundingClientRect();
      return { width: targetRect.width, height: targetRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(measurementLayout.left).toBeGreaterThanOrEqual(0);
  expect(measurementLayout.right).toBeLessThanOrEqual(320);
  expect(measurementLayout.documentWidth).toBeLessThanOrEqual(320);
  expect(
    measurementLayout.targets.every((target) => target.width >= 44 && target.height >= 44),
  ).toBe(true);

  await page.screenshot({
    path: testInfo.outputPath("mobile-320-measurement.png"),
    fullPage: true,
  });
  const intervalStatistics = page.getByLabel("A/B 区间统计");
  const statisticsOverflow = await intervalStatistics.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(statisticsOverflow).toBeGreaterThan(0);
  await intervalStatistics.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
  const scrolledStatistics = await intervalStatistics.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const lastItemBounds = element.lastElementChild?.getBoundingClientRect();
    return {
      scrollLeft: element.scrollLeft,
      lastItemVisible:
        lastItemBounds !== undefined && lastItemBounds.right <= bounds.right + 1,
    };
  });
  expect(scrolledStatistics.scrollLeft).toBeGreaterThan(0);
  expect(scrolledStatistics.lastItemVisible).toBe(true);
});

test("390 px 扩展授权控件保持触控尺寸和长文本省略", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "扩展", exact: true }).click();
  await page.evaluate(async () => {
    type WorkbenchStoreHandle = {
      getState(): { extensionState: { revision: number } };
      setState(state: Record<string, unknown>): void;
    };
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("/src/store/workbenchStore.ts"));
    if (!moduleUrl) {
      throw new Error("找不到页面当前使用的工作台 Store 模块");
    }
    const module = await import(/* @vite-ignore */ moduleUrl);
    const store = module.useWorkbenchStore as WorkbenchStoreHandle;
    store.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      replaySessionId: 0,
      extensionInspection: {
        format: "vofa-ultra-extension",
        schemaVersion: 1,
        manifest: {
          id: "io.vofa.reference-parser-with-a-long-identifier",
          version: "1.2.3-alpha.1234567890.abcdefghijklmnopqrstuvwxyz.9876543210",
          name: "Reference telemetry parser with a deliberately long display name",
          description: "用于验证窄屏长文本、省略和扩展授权布局。",
          license: "Apache-2.0 OR MIT",
          apiVersion: 1,
          kind: "protocol-parser",
          capabilities: ["live-rx.read"],
        },
        packageSha256: "a".repeat(64),
        moduleSha256: "b".repeat(64),
        packageBytes: 1_572_864,
        moduleBytes: 1_048_576,
      },
      extensionPackagePath:
        "C:\\extensions\\reference-telemetry-parser-with-a-very-long-file-name.vux",
      extensionMessage: "格式与运行时校验通过，等待授权",
    });
  });

  await expect(page.getByRole("heading", { name: "协议扩展" })).toBeVisible();
  const version = page.locator(".extension-title-row span");
  const versionLayout = await version.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: getComputedStyle(element).overflow,
    textOverflow: getComputedStyle(element).textOverflow,
    title: element.getAttribute("title"),
  }));
  expect(versionLayout.scrollWidth).toBeGreaterThan(versionLayout.clientWidth);
  expect(versionLayout.overflow).toBe("hidden");
  expect(versionLayout.textOverflow).toBe("ellipsis");
  expect(versionLayout.title).toContain("1.2.3-alpha");

  const touchTargets = await page
    .locator(".extension-consent, .extension-actions button")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
  expect(touchTargets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("命名工作区可保存、切换、导出并重新导入", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible();

  const nameInput = page.getByRole("textbox", { name: "工作区名称" });
  await nameInput.fill("面板草稿");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(nameInput).toHaveValue("面板草稿");

  await nameInput.fill("台架副本");
  await page.getByRole("button", { name: "另存为" }).click();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("radio", { name: /JustFloat/ }).click();
  await expect(page.locator(".workspace-title span")).toContainText("未保存");
  await page.getByRole("button", { name: "工作区" }).click();
  await nameInput.fill("非法\u007f名称");
  await page.getByRole("button", { name: "导出当前" }).click();
  await expect(page.getByRole("alert")).toHaveText("工作区名称不能包含控制字符");

  await nameInput.fill("台架导出草稿");
  const savedWorkspaceRow = page.locator(".workspace-row").filter({ hasText: "台架副本" });
  await expect(savedWorkspaceRow).toHaveCount(1);
  await expect(savedWorkspaceRow).toContainText("模拟器 · FireWater");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("台架导出草稿.vofa-workspace.json");
  await expect(page.getByRole("status")).toHaveText("当前工作副本已导出");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const downloadPath = testInfo.outputPath("workspace.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    format: string;
    schemaVersion: number;
    name: string;
    config: { protocol: string };
  };
  expect(exported).toMatchObject({
    format: "vofa-ultra.workspace",
    schemaVersion: 13,
    name: "台架导出草稿",
    config: { protocol: "justfloat" },
  });
  await expect(savedWorkspaceRow).toContainText("模拟器 · FireWater");
  await expect(page.locator(".workspace-title span")).toContainText("未保存");

  await page.getByLabel("导入工作区文件").setInputFiles(downloadPath);
  await expect(
    page.getByRole("button", { name: "台架导出草稿 模拟器 · JustFloat" }),
  ).toBeVisible();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");

  await nameInput.fill("未保存改名");
  await page.getByRole("button", { name: "默认工作区 模拟器 · FireWater" }).click();
  await expect(page.getByRole("heading", { name: "放弃未保存更改？" })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(nameInput).toHaveValue("未保存改名");

  await page.getByRole("button", { name: "默认工作区 模拟器 · FireWater" }).click();
  await page.getByRole("button", { name: "放弃并切换" }).click();
  await expect(page.locator(".workspace-title span")).toContainText("默认工作区");
  await expect(page.locator(".workspace-select:focus")).toContainText("默认工作区");
  await page.getByRole("button", { name: "台架副本 模拟器 · FireWater" }).click();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");
  await expect(page.locator(".workspace-select:focus")).toContainText("台架副本");

  await page.getByRole("button", { name: "删除工作区 台架导出草稿" }).click();
  await expect(page.getByRole("heading", { name: "删除工作区？" })).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("台架导出草稿", { exact: true })).toHaveCount(0);
  await expect(page.locator(".workspace-select:focus")).toContainText("台架副本");

  await page.reload();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(
    page.getByRole("button", { name: "台架副本 模拟器 · FireWater" }),
  ).toBeVisible();
});

test("短窗口仍可操作发送栏", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 520 });
  await page.goto("/");
  await page.getByRole("button", { name: "关闭侧栏" }).click();

  const sendInput = page.getByRole("textbox", { name: "发送内容" });
  const sendButton = page.getByRole("button", { name: "发送", exact: true });
  await expect(sendInput).toBeInViewport();
  await expect(sendButton).toBeInViewport();
  const terminalLayout = await page.locator("#workspace-terminal-panel").evaluate((element) => {
    const panelRect = element.getBoundingClientRect();
    const composerRect = element.querySelector<HTMLElement>(".send-composer")?.getBoundingClientRect();
    const logRect = element.querySelector<HTMLElement>(".terminal-log-shell")?.getBoundingClientRect();
    const statusRect = document.querySelector<HTMLElement>(".status-bar")?.getBoundingClientRect();
    return {
      composerBottom: composerRect?.bottom ?? Number.POSITIVE_INFINITY,
      logHeight: logRect?.height ?? 0,
      panelBottom: panelRect.bottom,
      statusTop: statusRect?.top ?? 0,
    };
  });
  expect(terminalLayout.composerBottom).toBeLessThanOrEqual(terminalLayout.panelBottom + 1);
  expect(Math.abs(terminalLayout.panelBottom - terminalLayout.statusTop)).toBeLessThanOrEqual(1);
  expect(terminalLayout.logHeight).toBeGreaterThanOrEqual(40);
  expect(await clippedVisibleHeight(sendInput)).toBeGreaterThanOrEqual(32);
  expect(await clippedVisibleHeight(sendButton)).toBeGreaterThanOrEqual(32);
  await page
    .getByRole("group", { name: "发送格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  const variableTrigger = page.getByRole("button", { name: "打开命令参考与校验" });
  await variableTrigger.click();
  const variableDialog = page.getByRole("dialog", { name: "命令参考与校验" });
  const firstVariable = variableDialog.getByRole("button", { name: /插入序号 U8/ });
  await expect(firstVariable).toBeFocused();
  expect(await clippedVisibleHeight(firstVariable)).toBeGreaterThanOrEqual(48);
  await page.keyboard.press("Escape");
  await expect(variableDialog).toHaveCount(0);
  await expect(variableTrigger).toBeFocused();
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
});

async function clippedVisibleHeight(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let top = Math.max(0, rect.top);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    let ancestor = element.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if ([style.overflow, style.overflowY].some((value) => value !== "visible")) {
        const ancestorRect = ancestor.getBoundingClientRect();
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
      ancestor = ancestor.parentElement;
    }
    return Math.max(0, bottom - top);
  });
}

async function canvasScreenshotStats(locator: Locator): Promise<{
  width: number;
  height: number;
  bytes: number;
}> {
  const dimensions = await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  const screenshot = await locator.screenshot({ animations: "disabled" });
  return { ...dimensions, bytes: screenshot.byteLength };
}

test("较新版本配置进入只读模式且不会被覆盖", async ({ page }) => {
  const futureValue = JSON.stringify({
    version: 14,
    state: { futureWorkspaceFormat: true, workspaces: [{ id: "future-only" }] },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("vofa-ultra-workbench", value);
  }, futureValue);

  await page.goto("/");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("alert")).toContainText("版本 14 的较新配置");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "另存为" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导入" })).toBeDisabled();

  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("radio", { name: /JustFloat/ }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("vofa-ultra-workbench")),
  ).toBe(futureValue);
});

test("浏览器预览显示会话状态但不开放文件操作", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "记录", exact: true }).click();

  await expect(page.getByRole("heading", { name: "会话记录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始录制" })).toBeDisabled();
  await expect(page.getByText("仅桌面应用支持文件录制")).toBeVisible();
  await expect(page.getByLabel("录制状态")).toContainText("未录制");
  const recordingDirectory = page.getByRole("region", { name: "记录目录" });
  await expect(recordingDirectory).toContainText("系统默认");
  await expect(
    recordingDirectory.getByRole("button", { name: "选择记录目录" }),
  ).toBeDisabled();
  await expect(
    recordingDirectory.getByRole("button", { name: "恢复默认记录目录" }),
  ).toBeDisabled();

  await page.getByRole("tab", { name: "数值" }).click();
  await expect(page.getByRole("button", { name: "开始数值记录" })).toBeDisabled();
  await expect(page.getByText("仅桌面应用支持数值文件记录")).toBeVisible();
  await expect(page.getByLabel("数值记录状态")).toContainText("未记录数值");
  await expect(page.getByRole("region", { name: "记录目录" })).toContainText(
    "系统默认",
  );

  await page.getByRole("tab", { name: "回放" }).click();
  await expect(page.getByRole("button", { name: "打开捕获文件" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "回放最近录制" })).toBeDisabled();
  await expect(page.getByText("仅桌面应用支持捕获文件回放")).toBeVisible();
  await expect(page.getByLabel("回放状态")).toContainText("未打开文件");

  await page.getByRole("tab", { name: "导出" }).click();
  await expect(page.getByRole("button", { name: "选择捕获文件" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "选择位置并导出" })).toBeDisabled();
  await expect(page.getByText("仅桌面应用支持捕获文件导出")).toBeVisible();
  await expect(page.getByLabel("导出状态")).toContainText("等待导出");

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});

test("Raw 回放滑杆只在提交时发送一次定位命令", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriReplayMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("tab", { name: "回放" }).click();
  const slider = page.getByRole("slider", { name: "回放位置" });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute("aria-valuetext", "00:00:01 / 00:00:03");
  expect(Math.abs(Number(await slider.inputValue()) - 1_000_000)).toBeLessThanOrEqual(
    3_500,
  );

  await slider.focus();
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(input, "1400000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    valueSetter?.call(input, "2100000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(slider).toHaveValue("2100000");
  await expect(slider).toHaveAttribute("aria-valuetext", "00:00:02 / 00:00:03");
  expect(await replaySeekCalls(page)).toEqual([]);

  await slider.dispatchEvent("pointerup");
  await expect.poll(() => replaySeekCalls(page)).toHaveLength(1);
  await slider.blur();
  await page.waitForTimeout(50);
  expect(await replaySeekCalls(page)).toEqual([
    { sessionId: 7, generation: 2, targetUs: 2_100_000 },
  ]);

  await expect(page.getByLabel("回放状态")).toContainText("回放已暂停");
  await expect(slider).toHaveValue("2100000");
  expect(pageErrors).toEqual([]);
});

for (const protocol of ["firewater", "justfloat"] as const) {
  test(`${protocol} 回放定位显示后端吸附的协议同步点`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(message.text());
      }
    });
    await installTauriReplayMock(page, protocol, 140_000);
    await page.goto("/");

    await page.getByRole("button", { name: "记录", exact: true }).click();
    await page.getByRole("tab", { name: "回放" }).click();
    const slider = page.getByRole("slider", { name: "回放位置" });
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("title", "拖动定位，位置会吸附到下一协议同步点");

    await slider.evaluate((element) => {
      const input = element as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "2100000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await replaySeekCalls(page)).toEqual([]);
    await slider.dispatchEvent("pointerup");

    await expect.poll(() => replaySeekCalls(page)).toEqual([
      { sessionId: 7, generation: 2, targetUs: 2_100_000 },
    ]);
    await expect(slider).toHaveValue("2240000");
    await expect(page.getByLabel("回放状态")).toContainText("回放已暂停");
    await expect.poll(() => replayStateSnapshot(page)).toMatchObject({
      status: "paused",
      positionUs: 2_240_000,
      timelineRevision: 1,
    });
    expect(pageErrors).toEqual([]);
  });
}

test("播放中切换回放倍速不会重置代次和时间线", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriReplayMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("tab", { name: "回放" }).click();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByLabel("回放状态")).toContainText("正在回放");

  const speed = page.getByLabel("回放倍速");
  await expect(speed).toHaveValue("1");
  await speed.selectOption("2");
  await expect(speed).toHaveValue("2");
  await expect(page.getByLabel("回放状态")).toContainText("Raw Data · VUCAP v2 · 2×");
  await expect(page.getByText(/^2× 00:01 \/ 00:03$/)).toBeVisible();

  expect(await replaySpeedCalls(page)).toEqual([
    { sessionId: 7, generation: 3, speed: 2 },
  ]);
  expect(await replayStateSnapshot(page)).toMatchObject({
    status: "playing",
    generation: 3,
    timelineRevision: 0,
    speed: 2,
    positionUs: 1_000_000,
  });
  expect(pageErrors).toEqual([]);
});

test("自动重连可跨端口恢复同一 USB 设备", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriSerialMock(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "设备连接" })).toBeVisible();
  await expect(page.getByLabel("串口设备")).toHaveValue("COM3");
  const deviceInfo = page.getByRole("group", { name: /已选端口信息/ });
  await expect(deviceInfo).toContainText("Telemetry");
  await expect(deviceInfo).toContainText("Acme Devices");
  await expect(deviceInfo).toContainText("1234:5678");
  await expect(deviceInfo).not.toContainText("唯一身份");
  await expect(deviceInfo).toHaveAccessibleName(/支持唯一设备识别/);
  await expect(deviceInfo).not.toContainText("DEVICE-001");

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await deviceInfo.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("serial-discovery-mobile.png"),
    fullPage: false,
  });
  if (desktopViewport) {
    await page.setViewportSize(desktopViewport);
  }

  const portListCalls = await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { portListCalls: number };
    };
    return testWindow.__TAURI_TEST__.portListCalls;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { portListCalls: number };
    };
    return testWindow.__TAURI_TEST__.portListCalls;
  })).toBeGreaterThan(portListCalls);

  await page.getByRole("checkbox", { name: "自动重连" }).check();
  await page.getByRole("button", { name: "连接设备" }).click();
  await expect(page.getByText("自动重连已待命")).toBeVisible();

  await page.getByRole("checkbox", { name: "DTR" }).uncheck();
  await page.getByRole("checkbox", { name: "RTS" }).uncheck();
  await expect(page.getByRole("checkbox", { name: "DTR" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "RTS" })).not.toBeChecked();
  expect(
    await page.evaluate(() => {
      const testWindow = window as unknown as {
        __TAURI_TEST__: {
          controlLineCalls: Array<{
            generation: number;
            line: "dtr" | "rts";
            asserted: boolean;
          }>;
        };
      };
      return testWindow.__TAURI_TEST__.controlLineCalls;
    }),
  ).toEqual([
    { generation: 1, line: "dtr", asserted: false },
    { generation: 1, line: "rts", asserted: false },
  ]);

  await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { loseDevice(): void };
    };
    testWindow.__TAURI_TEST__.loseDevice();
  });
  await expect(page.getByRole("button", { name: "取消重连" })).toBeEnabled();
  await expect(page.getByLabel("串口恢复")).toContainText("等待重试");

  await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { restoreDevice(): void };
    };
    testWindow.__TAURI_TEST__.restoreDevice();
  });
  await expect(page.getByText("自动重连已待命")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("串口设备")).toHaveValue("COM19");
  await expect(page.getByText("COM19", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);

  await deviceInfo.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("serial-recovery.png"),
    fullPage: true,
  });
});

test("桌面原始捕获与数值记录共用所选会话目录", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriSerialMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "连接设备" }).click();
  await expect(page.getByText("COM3 已连接")).toBeVisible();
  await page.getByRole("button", { name: "记录", exact: true }).click();

  let directory = page.getByRole("region", { name: "记录目录" });
  let selectDirectory = directory.getByRole("button", { name: "选择记录目录" });
  await selectDirectory.click();
  await expect(directory.getByRole("status")).toContainText("系统默认");
  await expect(selectDirectory).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const testWindow = window as unknown as {
        __TAURI_TEST__: {
          recordingDirectoryDialogCalls: number;
          recordingStartRequests: unknown[];
        };
      };
      return {
        dialogCalls: testWindow.__TAURI_TEST__.recordingDirectoryDialogCalls,
        startRequests: testWindow.__TAURI_TEST__.recordingStartRequests.length,
      };
    }),
  ).toEqual({ dialogCalls: 1, startRequests: 0 });

  await selectDirectory.click();
  await expect(directory.getByRole("status")).toContainText("D:\\sessions");
  await page.getByRole("button", { name: "开始录制" }).click();
  await expect(page.getByLabel("录制状态")).toContainText("正在录制");

  await page.getByRole("tab", { name: "数值" }).click();
  directory = page.getByRole("region", { name: "记录目录" });
  selectDirectory = directory.getByRole("button", { name: "选择记录目录" });
  await expect(directory.getByRole("status")).toContainText("D:\\sessions");
  await expect(selectDirectory).toBeDisabled();
  await page.getByRole("button", { name: "开始数值记录" }).click();
  await expect(page.getByLabel("数值记录状态")).toContainText("正在记录数值");

  const requests = await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: {
        recordingStartRequests: Array<{
          command: string;
          request: Record<string, unknown>;
        }>;
      };
    };
    return testWindow.__TAURI_TEST__.recordingStartRequests;
  });
  expect(requests).toHaveLength(2);
  expect(requests).toEqual([
    {
      command: "start_capture",
      request: expect.objectContaining({
        source: "serial",
        protocol: "firewater",
        destinationDirectory: "D:\\sessions",
      }),
    },
    {
      command: "start_numeric_log",
      request: {
        source: "serial",
        protocol: "firewater",
        destinationDirectory: "D:\\sessions",
      },
    },
  ]);
  expect(pageErrors).toEqual([]);
});

test("桌面实时链路批量记录解析后的数值 CSV", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriSerialMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "连接设备" }).click();
  await expect(page.getByText("COM3 已连接")).toBeVisible();
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await page.getByRole("tab", { name: "数值" }).click();
  await page.getByRole("button", { name: "开始数值记录" }).click();
  await expect(page.getByLabel("数值记录状态")).toContainText("正在记录数值");

  await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { emitNumericData(): void };
    };
    testWindow.__TAURI_TEST__.emitNumericData();
  });
  await expect.poll(() =>
    page.evaluate(() => {
      const testWindow = window as unknown as {
        __TAURI_TEST__: { numericLogBatches: unknown[][] };
      };
      return testWindow.__TAURI_TEST__.numericLogBatches.length;
    }),
  ).toBe(1);
  await expect(page.locator("#numeric-panel").getByText("2", { exact: true })).toBeVisible();

  const batches = await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { numericLogBatches: unknown[][] };
    };
    return testWindow.__TAURI_TEST__.numericLogBatches;
  });
  expect(batches).toEqual([
    [
      {
        timestampUnixUs: 1_700_000_000_000_000,
        channelKind: "base",
        channelId: "channel-0",
        channelName: "CH 1",
        value: 1,
      },
      {
        timestampUnixUs: 1_700_000_000_000_000,
        channelKind: "base",
        channelId: "channel-1",
        channelName: "CH 2",
        value: 2,
      },
    ],
  ]);

  await page.evaluate(async () => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { requestClose(): Promise<void> };
    };
    await testWindow.__TAURI_TEST__.requestClose();
  });
  await expect(page.getByLabel("数值记录状态")).toContainText("未记录数值");
  await expect(page.getByText("numeric.csv", { exact: true })).toBeVisible();
  const closeOperations = await page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { closeOperations: string[]; destroyCount: number };
    };
    return {
      closeOperations: testWindow.__TAURI_TEST__.closeOperations,
      destroyCount: testWindow.__TAURI_TEST__.destroyCount,
    };
  });
  expect(closeOperations).toEqual({
    closeOperations: ["append_numeric_log", "stop_numeric_log", "destroy"],
    destroyCount: 1,
  });
  expect(pageErrors).toEqual([]);
});

test("桌面串口原始文件需显式开始并可观察地取消", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
    }
  });
  await installTauriSerialMock(page);
  await page.goto("/");

  await page.getByRole("button", { name: "连接设备" }).click();
  await expect(page.getByText("COM3 已连接")).toBeVisible();

  const fileSendTrigger = page.getByRole("button", { name: "打开文件发送" });
  await fileSendTrigger.click();
  const dialog = page.getByRole("dialog", { name: "原始文件发送" });
  const txStats = page.locator(".transfer-stats span").filter({ hasText: "TX" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始发送" })).toBeDisabled();
  await expect(txStats).toHaveText("TX 0 B");

  await dialog.getByRole("button", { name: "选择", exact: true }).click();
  await expect(dialog.getByText("firmware.bin", { exact: true })).toBeVisible();
  await expect(dialog.getByText("已选择，等待开始")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始发送" })).toBeEnabled();
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(0);
  await expect(txStats).toHaveText("TX 0 B");

  await dialog.getByRole("button", { name: "开始发送" }).click();
  const progress = dialog.getByRole("progressbar", { name: "firmware.bin 发送进度" });
  await expect(progress).toHaveAttribute("value", "2048");
  await expect(dialog.getByText("正在发送", { exact: true })).toBeVisible();
  await expect(dialog.getByText("50.0%", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2.0 KiB / 4.0 KiB", { exact: true })).toBeVisible();
  await expect(txStats).toHaveText("TX 2.0 KB");
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toHaveCount(1);

  await page.getByRole("textbox", { name: "发送内容" }).fill("PING");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "打开 Modbus RTU 构帧器" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "展开周期发送设置" })).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "打开文件发送" }).click();
  }
  await expect(dialog).toBeVisible();
  const mobileLayout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const targets = [...element.querySelectorAll<HTMLElement>("button")]
      .filter((target) => target.offsetParent !== null)
      .map((target) => {
        const targetRect = target.getBoundingClientRect();
        return {
          name: target.getAttribute("aria-label") ?? target.textContent?.trim() ?? "",
          width: targetRect.width,
          height: targetRect.height,
        };
      });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      documentWidth: document.documentElement.scrollWidth,
      targets,
    };
  });
  expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.right).toBeLessThanOrEqual(390);
  expect(mobileLayout.top).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.bottom).toBeLessThanOrEqual(844);
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(
    mobileLayout.targets.filter((target) => target.width < 44 || target.height < 44),
  ).toEqual([]);

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByText("已取消", { exact: true })).toBeVisible();
  await expect(dialog.getByText("文件发送已取消；驱动已缓冲的字节仍可能发出")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始发送" })).toBeEnabled();
  await expect(txStats).toHaveText("TX 2.0 KB");
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("mobile-serial-file-send.png"),
    fullPage: true,
  });
});

async function replaySeekCalls(page: Page): Promise<Record<string, number>[]> {
  return page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { seekCalls: Record<string, number>[] };
    };
    return testWindow.__TAURI_TEST__.seekCalls;
  });
}

async function replaySpeedCalls(page: Page): Promise<Record<string, number>[]> {
  return page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { speedCalls: Record<string, number>[] };
    };
    return testWindow.__TAURI_TEST__.speedCalls;
  });
}

async function replayStateSnapshot(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const testWindow = window as unknown as {
      __TAURI_TEST__: { replayState(): Record<string, unknown> };
    };
    return testWindow.__TAURI_TEST__.replayState();
  });
}

async function installTauriReplayMock(
  page: Page,
  protocol: "raw" | "firewater" | "justfloat" = "raw",
  seekSnapUs = 0,
): Promise<void> {
  await page.addInitScript(({ replayProtocol, replaySeekSnapUs }) => {
    type Callback = (data: unknown) => unknown;
    type InvokeArgs = Record<string, unknown> | undefined;
    const callbacks = new Map<number, Callback>();
    const listeners = new Map<string, number[]>();
    const seekCalls: Record<string, number>[] = [];
    const speedCalls: Record<string, number>[] = [];
    let nextCallbackId = 1;
    let replayState = {
      status: "paused",
      sessionId: 7,
      generation: 2,
      timelineRevision: 0,
      revision: 3,
      path: "C:\\captures\\raw-session.vucap",
      formatVersion: 2,
      header: {
        source: "serial",
        protocol: replayProtocol,
        serialConfig: {
          portName: "COM3",
          baudRate: 115200,
          dataBits: 8,
          stopBits: 1,
          parity: "none",
          flowControl: "none",
        },
        startedAtUnixMs: 1_700_000_000_000,
        timeUnit: "microseconds",
      },
      complete: true,
      speed: 1,
      positionUs: 1_000_000,
      durationUs: 3_500_000,
      dataBytes: 4_096,
      recordCount: 16,
      markerCount: 0,
      message: "",
    };

    const emit = (event: string, payload: unknown) => {
      for (const callbackId of listeners.get(event) ?? []) {
        callbacks.get(callbackId)?.({ event, id: callbackId, payload });
      }
    };

    const invoke = async (command: string, args: InvokeArgs): Promise<unknown> => {
      if (command === "plugin:event|listen") {
        const event = String(args?.event);
        const handler = Number(args?.handler);
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return handler;
      }
      if (command === "plugin:event|unlisten") {
        const event = String(args?.event);
        const eventId = Number(args?.eventId);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((id) => id !== eventId),
        );
        return undefined;
      }
      if (command === "list_serial_ports") {
        return [];
      }
      if (command === "get_serial_state") {
        return { status: "disconnected", portName: "", generation: 0, revision: 0 };
      }
      if (command === "get_serial_file_send_state") {
        return {
          jobId: 0,
          revision: 0,
          generation: 0,
          status: "idle",
          fileName: "",
          totalBytes: 0,
          transmittedBytes: 0,
          message: "",
        };
      }
      if (command === "get_capture_state") {
        return {
          status: "idle",
          sessionId: 0,
          revision: 0,
          formatVersion: 2,
          path: "",
          dataBytes: 0,
          recordCount: 0,
          markerCount: 0,
        };
      }
      if (command === "get_numeric_log_state") {
        return {
          status: "idle",
          sessionId: 0,
          revision: 0,
          path: "",
          outputBytes: 0,
          sampleCount: 0,
        };
      }
      if (command === "get_capture_export_state") {
        return {
          status: "idle",
          phase: "idle",
          jobId: 0,
          revision: 0,
          sourcePath: "",
          destinationPath: "",
          format: "csv",
          direction: "both",
          allowIncomplete: false,
          totalInputBytes: 0,
          processedInputBytes: 0,
          processedDataBytes: 0,
          processedRecords: 0,
          exportedDataBytes: 0,
          exportedRecords: 0,
          outputBytes: 0,
          sourceComplete: false,
        };
      }
      if (command === "get_replay_state") {
        return { ...replayState };
      }
      if (command === "get_replay_markers") {
        return { sessionId: replayState.sessionId, markers: [] };
      }
      if (command === "play_replay") {
        replayState = {
          ...replayState,
          status: "playing",
          generation: replayState.generation + 1,
          revision: replayState.revision + 1,
          message: "",
        };
        return { ...replayState };
      }
      if (command === "set_replay_speed") {
        const speed = Number(args?.speed);
        speedCalls.push({
          sessionId: Number(args?.sessionId),
          generation: Number(args?.generation),
          speed,
        });
        replayState = {
          ...replayState,
          speed,
          revision: replayState.revision + 1,
        };
        return { ...replayState };
      }
      if (command === "seek_replay") {
        const targetUs = Number(args?.targetUs);
        seekCalls.push({
          sessionId: Number(args?.sessionId),
          generation: Number(args?.generation),
          targetUs,
        });
        replayState = {
          ...replayState,
          status: "seeking",
          generation: replayState.generation + 1,
          revision: replayState.revision + 1,
          message: "正在定位回放",
        };
        window.setTimeout(() => {
          replayState = {
            ...replayState,
            status: "paused",
            timelineRevision: replayState.timelineRevision + 1,
            revision: replayState.revision + 1,
            positionUs: Math.min(replayState.durationUs, targetUs + replaySeekSnapUs),
            message: "回放已定位",
          };
          emit("replay://state", { ...replayState });
        }, 100);
        return { ...replayState };
      }
      return undefined;
    };

    const testWindow = window as unknown as {
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
      __TAURI_TEST__: {
        seekCalls: Record<string, number>[];
        speedCalls: Record<string, number>[];
        replayState(): Record<string, unknown>;
      };
    };
    testWindow.__TAURI_INTERNALS__ = {
      invoke,
      metadata: {
        currentWindow: {
          label: "main",
        },
      },
      transformCallback: (callback: Callback, once = false) => {
        const id = nextCallbackId;
        nextCallbackId += 1;
        callbacks.set(id, (data) => {
          if (once) {
            callbacks.delete(id);
          }
          return callback(data);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
    };
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
    testWindow.__TAURI_TEST__ = {
      seekCalls,
      speedCalls,
      replayState: () => ({ ...replayState }),
    };
  }, { replayProtocol: protocol, replaySeekSnapUs: seekSnapUs });
}

async function installTauriSerialMock(
  page: Page,
  failedEvent?: string,
  failedCommand?: string,
  portListDelayMs = 0,
): Promise<void> {
  await page.addInitScript(({ eventToFail, commandToFail, serialPortListDelayMs }) => {
    type Callback = (data: unknown) => unknown;
    type InvokeArgs = Record<string, unknown> | undefined;
    const callbacks = new Map<number, Callback>();
    const listeners = new Map<string, number[]>();
    let nextCallbackId = 1;
    let portListCalls = 0;
    let ports = [
      {
        name: "COM3",
        kind: "usb",
        manufacturer: "Acme Devices",
        product: "Telemetry",
        serialNumber: "DEVICE-001",
        vendorId: 0x1234,
        productId: 0x5678,
      },
    ];
    let serialState = {
      status: "disconnected",
      portName: "",
      generation: 0,
      revision: 0,
    };
    let fileSendState = {
      jobId: 0,
      revision: 0,
      generation: 0,
      status: "idle",
      fileName: "",
      totalBytes: 0,
      transmittedBytes: 0,
      queuedAt: undefined as number | undefined,
      startedAt: undefined as number | undefined,
      endedAt: undefined as number | undefined,
      errorCode: undefined as string | undefined,
      message: "",
    };
    let captureState = {
      status: "idle",
      sessionId: 0,
      revision: 0,
      formatVersion: 2,
      path: "",
      dataBytes: 0,
      recordCount: 0,
      markerCount: 0,
      message: "",
    };
    let numericLogState = {
      status: "idle",
      sessionId: 0,
      revision: 0,
      path: "",
      outputBytes: 0,
      sampleCount: 0,
      message: "",
    };
    const numericLogBatches: unknown[][] = [];
    const recordingStartRequests: Array<{
      command: string;
      request: Record<string, unknown>;
    }> = [];
    const controlLineCalls: Array<{
      generation: number;
      line: "dtr" | "rts";
      asserted: boolean;
    }> = [];
    let recordingDirectoryDialogCalls = 0;
    const closeOperations: string[] = [];
    let destroyCount = 0;

    const emit = (event: string, payload: unknown) => {
      for (const callbackId of listeners.get(event) ?? []) {
        callbacks.get(callbackId)?.({ event, id: callbackId, payload });
      }
    };
    const emitSerialState = () => emit("serial://state", { ...serialState });
    const emitFileSendState = () => emit("serial://file-send", { ...fileSendState });

    const invoke = async (command: string, args: InvokeArgs): Promise<unknown> => {
      if (command === "plugin:event|listen") {
        const event = String(args?.event);
        if (event === eventToFail) {
          throw new Error(`${event} 监听注册失败`);
        }
        const handler = Number(args?.handler);
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return handler;
      }
      if (command === "plugin:event|unlisten") {
        const event = String(args?.event);
        const eventId = Number(args?.eventId);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((id) => id !== eventId),
        );
        return undefined;
      }
      if (command === commandToFail) {
        throw new Error(`${command} 调用失败`);
      }
      if (command === "plugin:window|destroy") {
        closeOperations.push("destroy");
        destroyCount += 1;
        return undefined;
      }
      if (command === "list_serial_ports") {
        portListCalls += 1;
        if (serialPortListDelayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, serialPortListDelayMs));
        }
        return ports.map((port) => ({ ...port }));
      }
      if (command === "get_serial_state") {
        return { ...serialState };
      }
      if (command === "get_serial_file_send_state") {
        return { ...fileSendState };
      }
      if (command === "plugin:dialog|open") {
        const options = args?.options as { directory?: boolean } | undefined;
        if (options?.directory) {
          recordingDirectoryDialogCalls += 1;
          return recordingDirectoryDialogCalls === 1 ? null : "D:\\sessions";
        }
        return "C:\\firmware\\firmware.bin";
      }
      if (command === "connect_serial") {
        const config = args?.config as { portName: string };
        const generation = serialState.generation + 1;
        serialState = {
          status: "connecting",
          portName: config.portName,
          generation,
          revision: serialState.revision + 1,
        };
        emitSerialState();
        await new Promise((resolve) => window.setTimeout(resolve, 25));
        if (serialState.generation !== generation || serialState.status !== "connecting") {
          return { ...serialState };
        }
        serialState = {
          ...serialState,
          status: "connected",
          revision: serialState.revision + 1,
        };
        emitSerialState();
        return { ...serialState };
      }
      if (command === "cancel_serial_connect") {
        if (serialState.status === "connecting") {
          serialState = {
            ...serialState,
            status: "disconnected",
            generation: serialState.generation + 1,
            revision: serialState.revision + 1,
          };
          emitSerialState();
        }
        return { ...serialState };
      }
      if (command === "disconnect_serial") {
        serialState = {
          ...serialState,
          status: "disconnected",
          revision: serialState.revision + 1,
        };
        emitSerialState();
        return { ...serialState };
      }
      if (command === "set_serial_control_line") {
        const generation = Number(args?.generation);
        const line = String(args?.line);
        const asserted = args?.asserted;
        if (serialState.status !== "connected") {
          throw new Error("串口尚未连接");
        }
        if (generation !== serialState.generation) {
          throw new Error("串口连接已发生变化");
        }
        if ((line !== "dtr" && line !== "rts") || typeof asserted !== "boolean") {
          throw new Error("串口控制线参数无效");
        }
        controlLineCalls.push({ generation, line, asserted });
        return undefined;
      }
      if (command === "start_serial_file_send") {
        fileSendState = {
          jobId: 21,
          revision: fileSendState.revision + 1,
          generation: serialState.generation,
          status: "queued",
          fileName: "firmware.bin",
          totalBytes: 4_096,
          transmittedBytes: 0,
          queuedAt: Date.now(),
          startedAt: undefined,
          endedAt: undefined,
          errorCode: undefined,
          message: "等待发送 firmware.bin",
        };
        emitFileSendState();
        window.setTimeout(() => {
          if (fileSendState.status !== "queued") {
            return;
          }
          fileSendState = {
            ...fileSendState,
            revision: fileSendState.revision + 1,
            status: "sending",
            transmittedBytes: 2_048,
            startedAt: Date.now(),
            message: "正在发送 firmware.bin",
          };
          emitFileSendState();
          const bytes = new Uint8Array(2_048);
          bytes.fill(0x41);
          emit("serial://tx", {
            data: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
            byteCount: bytes.length,
            transmittedAt: Date.now(),
            generation: serialState.generation,
          });
        }, 40);
        return { ...fileSendState };
      }
      if (command === "cancel_serial_file_send") {
        if (Number(args?.jobId) !== fileSendState.jobId || fileSendState.status !== "sending") {
          return false;
        }
        fileSendState = {
          ...fileSendState,
          revision: fileSendState.revision + 1,
          status: "cancelling",
          message: "正在取消文件发送",
        };
        emitFileSendState();
        window.setTimeout(() => {
          fileSendState = {
            ...fileSendState,
            revision: fileSendState.revision + 1,
            status: "cancelled",
            endedAt: Date.now(),
            message: "文件发送已取消；驱动已缓冲的字节仍可能发出",
          };
          emitFileSendState();
        }, 20);
        return true;
      }
      if (command === "get_capture_state") {
        return { ...captureState };
      }
      if (command === "start_capture") {
        const request = (args?.request as Record<string, unknown>) ?? {};
        recordingStartRequests.push({ command, request: { ...request } });
        const directory = String(request.destinationDirectory ?? "C:\\captures");
        captureState = {
          status: "recording",
          sessionId: 7,
          revision: captureState.revision + 1,
          formatVersion: 2,
          path: `${directory}\\capture.vucap`,
          dataBytes: 0,
          recordCount: 0,
          markerCount: 0,
          message: "",
        };
        emit("capture://state", { ...captureState });
        return { ...captureState };
      }
      if (command === "get_numeric_log_state") {
        return { ...numericLogState };
      }
      if (command === "start_numeric_log") {
        const request = (args?.request as Record<string, unknown>) ?? {};
        recordingStartRequests.push({ command, request: { ...request } });
        const directory = String(request.destinationDirectory ?? "C:\\captures");
        numericLogState = {
          status: "recording",
          sessionId: 17,
          revision: numericLogState.revision + 1,
          path: `${directory}\\numeric.csv.part`,
          outputBytes: 116,
          sampleCount: 0,
          message: "",
        };
        emit("numeric-log://state", { ...numericLogState });
        return { ...numericLogState };
      }
      if (command === "append_numeric_log") {
        closeOperations.push("append_numeric_log");
        const samples = (args?.samples as unknown[]) ?? [];
        numericLogBatches.push(samples);
        numericLogState = {
          ...numericLogState,
          revision: numericLogState.revision + 1,
          outputBytes: numericLogState.outputBytes + samples.length * 48,
          sampleCount: numericLogState.sampleCount + samples.length,
        };
        emit("numeric-log://state", { ...numericLogState });
        return undefined;
      }
      if (command === "stop_numeric_log") {
        closeOperations.push("stop_numeric_log");
        numericLogState = {
          ...numericLogState,
          status: "idle",
          revision: numericLogState.revision + 1,
          path: numericLogState.path.replace(/\.part$/, ""),
          message: "",
        };
        emit("numeric-log://state", { ...numericLogState });
        return { ...numericLogState };
      }
      if (command === "abort_numeric_log") {
        numericLogState = {
          ...numericLogState,
          status: "error",
          revision: numericLogState.revision + 1,
          message: String(args?.message ?? "数值记录已中止"),
        };
        emit("numeric-log://state", { ...numericLogState });
        return { ...numericLogState };
      }
      if (command === "get_capture_export_state") {
        return {
          status: "idle",
          phase: "idle",
          jobId: 0,
          revision: 0,
          sourcePath: "",
          destinationPath: "",
          format: "csv",
          direction: "both",
          allowIncomplete: false,
          totalInputBytes: 0,
          processedInputBytes: 0,
          processedDataBytes: 0,
          processedRecords: 0,
          exportedDataBytes: 0,
          exportedRecords: 0,
          outputBytes: 0,
          sourceComplete: false,
        };
      }
      if (command === "get_replay_state") {
        return {
          status: "idle",
          sessionId: 0,
          generation: 0,
          timelineRevision: 0,
          revision: 0,
          path: "",
          formatVersion: 0,
          complete: false,
          speed: 1,
          positionUs: 0,
          durationUs: 0,
          dataBytes: 0,
          recordCount: 0,
          markerCount: 0,
        };
      }
      if (command === "get_replay_markers") {
        return { sessionId: 0, markers: [] };
      }
      return undefined;
    };

    const testWindow = window as unknown as {
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
      __TAURI_TEST__: {
        closeOperations: string[];
        controlLineCalls: Array<{
          generation: number;
          line: "dtr" | "rts";
          asserted: boolean;
        }>;
        destroyCount: number;
        emitNumericData(): void;
        loseDevice(): void;
        requestClose(): Promise<void>;
        recordingDirectoryDialogCalls: number;
        recordingStartRequests: Array<{
          command: string;
          request: Record<string, unknown>;
        }>;
        restoreDevice(): void;
        numericLogBatches: unknown[][];
        portListCalls: number;
      };
    };
    testWindow.__TAURI_INTERNALS__ = {
      invoke,
      metadata: {
        currentWindow: {
          label: "main",
        },
      },
      transformCallback: (callback: Callback, once = false) => {
        const id = nextCallbackId;
        nextCallbackId += 1;
        callbacks.set(id, (data) => {
          if (once) {
            callbacks.delete(id);
          }
          return callback(data);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
    };
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
    testWindow.__TAURI_TEST__ = {
      closeOperations,
      controlLineCalls,
      get destroyCount() {
        return destroyCount;
      },
      numericLogBatches,
      get portListCalls() {
        return portListCalls;
      },
      get recordingDirectoryDialogCalls() {
        return recordingDirectoryDialogCalls;
      },
      recordingStartRequests,
      emitNumericData: () => {
        emit("serial://data", {
          data: "MSwyCg==",
          byteCount: 4,
          receivedAt: 1_700_000_000_000,
          generation: serialState.generation,
        });
      },
      requestClose: async () => {
        await Promise.all(
          (listeners.get("tauri://close-requested") ?? []).map((callbackId) =>
            callbacks.get(callbackId)?.({
              event: "tauri://close-requested",
              id: callbackId,
              payload: null,
            }),
          ),
        );
      },
      loseDevice: () => {
        ports = [];
        serialState = {
          ...serialState,
          status: "error",
          revision: serialState.revision + 1,
          errorCode: "read-failed",
          message: "设备已移除",
        } as typeof serialState;
        emitSerialState();
      },
      restoreDevice: () => {
        ports = [
          {
            name: "COM19",
            kind: "usb",
            manufacturer: "Acme Devices",
            product: "Telemetry",
            serialNumber: "DEVICE-001",
            vendorId: 0x1234,
            productId: 0x5678,
          },
        ];
      },
    };
  }, {
    eventToFail: failedEvent ?? null,
    commandToFail: failedCommand ?? null,
    serialPortListDelayMs: portListDelayMs,
  });
}
