import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ProcessingGraphConfig } from "../src/types/processingGraph";

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

  const canvasStats = await page.locator(".waveform-chart canvas").first().evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (!context) {
      return { width: 0, height: 0, opaquePixels: 0 };
    }
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    for (let index = 3; index < pixels.length; index += 64) {
      if ((pixels[index] ?? 0) > 0) {
        opaquePixels += 1;
      }
    }
    return { width: canvas.width, height: canvas.height, opaquePixels };
  });
  expect(canvasStats.width).toBeGreaterThan(400);
  expect(canvasStats.height).toBeGreaterThan(200);
  expect(canvasStats.opaquePixels).toBeGreaterThan(50);

  const terminalCount = async () => {
    const text = await page.locator(".terminal-toolbar .panel-subtitle").textContent();
    return Number(text?.match(/\d+/)?.[0] ?? 0);
  };
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

test("处理图生成独立派生通道并随 v2 工作区往返", async ({ page }, testInfo) => {
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
  await kindSelect.selectOption("ema");
  await addButton.click();
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
  expect(exported.schemaVersion).toBe(2);
  expect(exported.config.processingGraph).toMatchObject({
    enabled: true,
    nodes: [
      { id: "node-1", kind: "input" },
      { id: "node-2", kind: "ema" },
      { id: "node-3", kind: "output", name: "OUT 1" },
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
  await expect(page.locator(".processing-node")).toHaveCount(3);
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
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(txLines).toHaveCount(4);
  await page
    .getByRole("group", { name: "接收显示格式" })
    .getByRole("button", { name: "HEX" })
    .click();
  await expect(txLines.last().locator("code")).toHaveText("01 00");
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
  const lineEnding = page.getByRole("combobox", { name: "行尾" });
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
  await page.getByRole("button", { name: "插入命令变量" }).click();
  const variableDialog = page.getByRole("dialog", { name: "命令变量" });
  await expect(variableDialog).toBeVisible();
  expect(await clippedVisibleHeight(variableDialog.getByRole("button").first())).toBeGreaterThanOrEqual(
    52,
  );
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
  await expect(navigationButtons).toHaveCount(6);
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
  const variableTrigger = page.getByRole("button", { name: "插入命令变量" });
  await variableTrigger.click();
  const variableDialog = page.getByRole("dialog", { name: "命令变量" });
  const firstVariable = variableDialog.getByRole("button").first();
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

test("较新版本配置进入只读模式且不会被覆盖", async ({ page }) => {
  const futureValue = JSON.stringify({
    version: 3,
    state: { futureWorkspaceFormat: true, workspaces: [{ id: "future-only" }] },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("vofa-ultra-workbench", value);
  }, futureValue);

  await page.goto("/");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("alert")).toContainText("版本 3 的较新配置");
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
  await expect(page.getByLabel("回放状态")).toContainText("Raw Data · 2×");
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
      if (command === "get_capture_state") {
        return {
          status: "idle",
          sessionId: 0,
          revision: 0,
          path: "",
          dataBytes: 0,
          recordCount: 0,
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

    const emit = (event: string, payload: unknown) => {
      for (const callbackId of listeners.get(event) ?? []) {
        callbacks.get(callbackId)?.({ event, id: callbackId, payload });
      }
    };
    const emitSerialState = () => emit("serial://state", { ...serialState });

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
      if (command === "get_capture_state") {
        return {
          status: "idle",
          sessionId: 0,
          revision: 0,
          path: "",
          dataBytes: 0,
          recordCount: 0,
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
        return {
          status: "idle",
          sessionId: 0,
          generation: 0,
          timelineRevision: 0,
          revision: 0,
          path: "",
          complete: false,
          speed: 1,
          positionUs: 0,
          durationUs: 0,
          dataBytes: 0,
          recordCount: 0,
        };
      }
      return undefined;
    };

    const testWindow = window as unknown as {
      __TAURI_INTERNALS__: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
      __TAURI_TEST__: Record<string, () => void>;
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
