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
