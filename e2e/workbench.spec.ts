import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProcessingGraphConfig } from "../src/types/processingGraph";
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

test("标签组支持标准键盘导航", async ({ page }) => {
  await page.goto("/");

  const waveformTab = page.getByRole("tab", { name: "波形" });
  const attitudeTab = page.getByRole("tab", { name: "姿态" });
  const waveformPanel = page.locator("#workspace-waveform-panel");
  const attitudePanel = page.locator("#workspace-attitude-panel");
  await expectValidTabPanelReferences(page, "工作区视图");
  await expect(waveformPanel).toBeVisible();
  await expect(attitudePanel).toBeHidden();
  await waveformTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(attitudeTab).toBeFocused();
  await expect(attitudeTab).toHaveAttribute("aria-selected", "true");
  await expect(attitudeTab).toHaveAttribute("tabindex", "0");
  await expect(waveformTab).toHaveAttribute("tabindex", "-1");
  await expect(attitudePanel).toBeVisible();
  await expect(waveformPanel).toBeHidden();
  await expect(attitudePanel.getByRole("heading", { name: "3D 姿态" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(waveformTab).toBeFocused();
  await expect(waveformPanel).toBeVisible();
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
    const buttons = [...bar.querySelectorAll<HTMLElement>(".terminal-direction-filter button")];
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth,
      searchHeight: searchField?.getBoundingClientRect().height ?? 0,
      searchInputHeight: searchInput?.getBoundingClientRect().height ?? 0,
      clearButtonHeight: clearButton?.getBoundingClientRect().height ?? 0,
      buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
    };
  });
  expect(mobileLayout.documentOverflow).toBeLessThanOrEqual(1);
  expect(mobileLayout.barOverflow).toBeLessThanOrEqual(1);
  expect(mobileLayout.searchHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.searchInputHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.clearButtonHeight).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.buttonHeights.every((height) => height >= 44)).toBe(true);
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("terminal-search-mobile.png"),
    fullPage: true,
  });
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
  await expect(health).toContainText("FireWater：每行 1–16 个有限数值");

  await page.getByRole("button", { name: "清空解析统计" }).click();
  await expect(health).toContainText("等待完整帧");
  await expect(page.locator(".protocol-warning-status")).toHaveCount(0);

  await ingestProtocolText(page, "1,2,3\n", 1_100);
  await expect(health).toContainText("解析正常");
  await expect(health).toContainText("成功 1");
  await expect(page.getByLabel("数据通道列表").getByRole("button")).toHaveCount(3);
  await expect(page.locator(".terminal-line").last()).toContainText("1,2,3");

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

test("处理图转换节点生成派生通道并随 v9 工作区往返", async ({ page }, testInfo) => {
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

  const kindSelect = page.getByRole("combobox", { name: "新增节点类型" });
  const addButton = page.getByRole("button", { name: "添加处理节点" });
  await addButton.click();
  await kindSelect.selectOption("number_to_byte");
  await addButton.click();
  await page.getByRole("combobox", { name: "node-2 数值类型" }).selectOption("f32");
  await kindSelect.selectOption("bytes_to_number");
  await addButton.click();
  await page.getByRole("combobox", { name: "node-3 数值类型" }).selectOption("u8");
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
  await expect(page.getByText("派生 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("数据通道列表").getByRole("button").filter({ hasText: "OUT 1" }))
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
  expect(exported.schemaVersion).toBe(9);
  expect(exported.config.processingGraph).toMatchObject({
    enabled: true,
    nodes: [
      { id: "node-1", kind: "input" },
      { id: "node-2", kind: "number_to_byte", numericType: "f32" },
      { id: "node-3", kind: "bytes_to_number", numericType: "u8" },
      { id: "node-4", kind: "output", name: "OUT 1" },
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
  await expect(page.locator(".processing-node")).toHaveCount(4);
  expect(pageErrors).toEqual([]);
});

test("实时 RX 自动应答保持有界运行并随 v9 工作区往返", async ({ page }, testInfo) => {
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
    schemaVersion: 9,
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
  const initialCanvas = await canvasScreenshotSignature(canvas);
  expect(initialCanvas.width).toBeGreaterThan(400);
  expect(initialCanvas.height).toBeGreaterThan(200);
  expect(initialCanvas.bytes).toBeGreaterThan(10_000);
  await expect
    .poll(async () => (await canvasScreenshotSignature(canvas)).hash)
    .not.toBe(initialCanvas.hash);

  const rollReadout = page.getByLabel("当前姿态值").locator("dd").first();
  await page.getByRole("button", { name: "冻结姿态显示" }).click();
  await expect(page.locator(".attitude-panel .live-state")).toContainText("HOLD");
  const frozenRoll = await rollReadout.textContent();
  await page.waitForTimeout(500);
  await expect(rollReadout).toHaveText(frozenRoll ?? "");
  await expect
    .poll(async () => {
      const before = await canvasScreenshotSignature(canvas);
      await page.waitForTimeout(120);
      const after = await canvasScreenshotSignature(canvas);
      return before.hash === after.hash;
    })
    .toBe(true);
  const frozenCanvas = await canvasScreenshotSignature(canvas);

  await page.getByRole("button", { name: "继续姿态显示" }).click();
  await expect(page.locator(".attitude-panel .live-state")).toContainText("LIVE");
  await expect.poll(async () => rollReadout.textContent()).not.toBe(frozenRoll);
  await expect
    .poll(async () => (await canvasScreenshotSignature(canvas)).hash)
    .not.toBe(frozenCanvas.hash);

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
  }

  await page.screenshot({
    path: testInfo.outputPath("mobile-320-attitude.png"),
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
  await page.getByRole("button", { name: "命令历史，1 条" }).click();
  await expect(page.getByRole("dialog", { name: "命令历史" })).toContainText("×3");
  await page.getByRole("button", { name: "命令历史，1 条" }).click();

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
});

test("Modbus RTU 构帧和单事务主站经统一链路工作且窄屏可操作", async ({ page }, testInfo) => {
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
  await builder.getByRole("button", { name: "执行事务" }).click();
  await expect(builder.getByText("完成")).toBeVisible();
  await expect(page.getByRole("button", { name: "命令历史，1 条" })).toBeVisible();
  await builder.getByText("完成").click();
  await expect(builder.getByText("0:0")).toBeVisible();
  await expect(builder.getByText("01 03 02 00 00 B8 44")).toBeVisible();
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
  const measurementButton = page.getByRole("button", { name: "开启波形测量" });
  await expect(measurementButton).toBeEnabled({ timeout: 5_000 });
  await measurementButton.click();
  const measurementStrip = page.locator(".waveform-measurement-strip");
  await expect(measurementStrip).toBeVisible();
  await expect(page.getByLabel("波形测量结果")).not.toContainText(/NaN|Infinity/);

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
  await page.getByRole("button", { name: "保存", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  const downloadPath = testInfo.outputPath("workspace.json");
  await download.saveAs(downloadPath);

  await page.getByLabel("导入工作区文件").setInputFiles(downloadPath);
  await expect(page.getByText("台架副本 (2)", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "台架副本 模拟器 · JustFloat" }).click();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");
  await expect(page.locator(".workspace-select:focus")).toContainText("台架副本");

  await page.getByRole("button", { name: "删除工作区 台架副本 (2)" }).click();
  await expect(page.getByRole("heading", { name: "删除工作区？" })).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("台架副本 (2)", { exact: true })).toHaveCount(0);
  await expect(page.locator(".workspace-select:focus")).toContainText("台架副本");

  await page.reload();
  await expect(page.locator(".workspace-title span")).toContainText("台架副本");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(
    page.getByRole("button", { name: "台架副本 模拟器 · JustFloat" }),
  ).toBeVisible();
});

test("短窗口仍可操作发送栏", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 520 });
  await page.goto("/");
  await page.getByRole("button", { name: "关闭侧栏" }).click();

  await expect(page.getByRole("textbox", { name: "发送内容" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
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

async function canvasScreenshotSignature(locator: Locator): Promise<{
  width: number;
  height: number;
  hash: number;
  bytes: number;
}> {
  const dimensions = await locator.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  const screenshot = await locator.screenshot({ animations: "disabled" });
  let hash = 2_166_136_261;
  for (const byte of screenshot) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return { ...dimensions, hash: hash >>> 0, bytes: screenshot.byteLength };
}

test("较新版本配置进入只读模式且不会被覆盖", async ({ page }) => {
  const futureValue = JSON.stringify({
    version: 10,
    state: { futureWorkspaceFormat: true, workspaces: [{ id: "future-only" }] },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("vofa-ultra-workbench", value);
  }, futureValue);

  await page.goto("/");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("alert")).toContainText("版本 10 的较新配置");
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

  await page.getByRole("tab", { name: "数值" }).click();
  await expect(page.getByRole("button", { name: "开始数值记录" })).toBeDisabled();
  await expect(page.getByText("仅桌面应用支持数值文件记录")).toBeVisible();
  await expect(page.getByLabel("数值记录状态")).toContainText("未记录数值");

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
  await page.getByRole("checkbox", { name: "自动重连" }).check();
  await page.getByRole("button", { name: "连接设备" }).click();
  await expect(page.getByText("自动重连已待命")).toBeVisible();

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

  await page.screenshot({
    path: testInfo.outputPath("serial-recovery.png"),
    fullPage: true,
  });
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

  await page.getByRole("button", { name: "停止数值记录" }).click();
  await expect(page.getByLabel("数值记录状态")).toContainText("未记录数值");
  await expect(page.getByText("numeric.csv", { exact: true })).toBeVisible();
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

async function installTauriSerialMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Callback = (data: unknown) => unknown;
    type InvokeArgs = Record<string, unknown> | undefined;
    const callbacks = new Map<number, Callback>();
    const listeners = new Map<string, number[]>();
    let nextCallbackId = 1;
    let ports = [
      {
        name: "COM3",
        kind: "usb",
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
        return ports.map((port) => ({ ...port }));
      }
      if (command === "get_serial_state") {
        return { ...serialState };
      }
      if (command === "get_serial_file_send_state") {
        return { ...fileSendState };
      }
      if (command === "plugin:dialog|open") {
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
        return { ...numericLogState };
      }
      if (command === "start_numeric_log") {
        numericLogState = {
          status: "recording",
          sessionId: 17,
          revision: numericLogState.revision + 1,
          path: "C:\\captures\\numeric.csv",
          outputBytes: 116,
          sampleCount: 0,
          message: "",
        };
        emit("numeric-log://state", { ...numericLogState });
        return { ...numericLogState };
      }
      if (command === "append_numeric_log") {
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
        numericLogState = {
          ...numericLogState,
          status: "idle",
          revision: numericLogState.revision + 1,
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
        emitNumericData(): void;
        loseDevice(): void;
        restoreDevice(): void;
        numericLogBatches: unknown[][];
      };
    };
    testWindow.__TAURI_INTERNALS__ = {
      invoke,
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
      numericLogBatches,
      emitNumericData: () => {
        emit("serial://data", {
          data: "MSwyCg==",
          byteCount: 4,
          receivedAt: 1_700_000_000_000,
          generation: serialState.generation,
        });
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
            product: "Telemetry",
            serialNumber: "DEVICE-001",
            vendorId: 0x1234,
            productId: 0x5678,
          },
        ];
      },
    };
  });
}
