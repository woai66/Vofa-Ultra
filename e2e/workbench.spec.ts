import { expect, test } from "@playwright/test";

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

  await page.getByRole("textbox", { name: "发送内容" }).fill("ping");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator('.terminal-line[data-direction="tx"]')).toContainText("ping");

  await page.getByRole("button", { name: "暂停波形显示" }).click();
  await expect(page.getByText("HISTORY")).toBeVisible();
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("desktop-workbench.png"),
    fullPage: true,
  });
});

test("窄屏布局无页面级横向溢出", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-sidebar-open", "false");
  await expect
    .poll(() =>
      page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "实时波形" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  const undersizedTargets = await page.locator("button, select, textarea").evaluateAll((elements) =>
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

  await expect(page.getByRole("textbox", { name: "发送内容" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
});

test("较新版本配置进入只读模式且不会被覆盖", async ({ page }) => {
  const futureValue = JSON.stringify({
    version: 2,
    state: { futureWorkspaceFormat: true, workspaces: [{ id: "future-only" }] },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("vofa-ultra-workbench", value);
  }, futureValue);

  await page.goto("/");
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("alert")).toContainText("版本 2 的较新配置");
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

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});
