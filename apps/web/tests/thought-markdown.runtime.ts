import assert from "node:assert/strict";
import { expect, type Locator, type Page } from "@playwright/test";
import type { evolveDaemon } from "./evolve.runtime";

const longWord = "unbroken".repeat(45);
export const markdownThought = [
  "# Owned Markdown heading",
  "",
  "First line with **strong** and *emphasis* and `inline code`.",
  "Second line remains visible.",
  "",
  "Another paragraph with [external label](https://example.com/path) and https://example.org/bare.",
  "",
  "- First list item\n- Second list item",
  "",
  "> Owned quotation",
  "",
  `\`\`\`text\n${longWord}\n\`\`\``,
  "",
  `| Column one | Column two |\n| --- | --- |\n| ${longWord} | Value |`,
  "",
  `https://example.net/${longWord}`,
  "",
  "[Unsafe action](javascript:alert%281%29) [Relative action](/unsafe) ![Image alternative](https://image.invalid/pixel.png)",
  '<script>window.ownedMarkdownExecuted = true</script><img src="https://image.invalid/raw.png" onerror="window.ownedMarkdownExecuted = true">',
].join("\n");

async function checkReading(page: Page, region: Locator, narrow: boolean): Promise<void> {
  const heading = region.getByRole("heading", { name: "Owned Markdown heading" });
  await expect(heading).toBeVisible();
  assert.notEqual(await heading.evaluate(element => element.tagName), "H1", "thought headings must not compete with the page title");
  await expect(region.locator("strong").filter({ hasText: "strong" })).toBeVisible();
  await expect(region.locator("em").filter({ hasText: "emphasis" })).toBeVisible();
  await expect(region.locator("code").filter({ hasText: "inline code" })).toBeVisible();
  const firstParagraph = region.locator("p").filter({ hasText: "First line with" });
  await expect(firstParagraph.locator("br")).toHaveCount(1);
  await expect(firstParagraph).toContainText("Second line remains visible.");
  await expect(region.locator("p").filter({ hasText: "Another paragraph" })).toBeVisible();
  await expect(region.locator("ul li").filter({ hasText: "First list item" })).toBeVisible();
  await expect(region.locator("blockquote").filter({ hasText: "Owned quotation" })).toBeVisible();
  await expect(region.locator("pre code")).toContainText(longWord);
  await expect(region.locator("table th").filter({ hasText: "Column one" })).toBeVisible();
  await expect(region.locator("table td").filter({ hasText: "Value" })).toBeVisible();
  for (const [name, href] of [["external label", "https://example.com/path"], ["https://example.org/bare", "https://example.org/bare"]] as const) {
    const link = region.getByRole("link", { name: new RegExp(name.replaceAll(".", "\\.")) });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(link).toHaveAttribute("rel", /\bnoreferrer\b/);
    await link.focus(); await expect(link).toBeFocused();
    const indication = await link.evaluate(element => [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), ...((element.getAttribute("aria-describedby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent))].join(" "));
    assert.match(indication, /new (?:tab|window)/i, "new-tab behavior must be announced");
  }
  const markdownBody = heading.locator("..");
  await expect(markdownBody.locator('a[href^="javascript:"], a[href="/unsafe"], img, script, iframe, svg[onload]')).toHaveCount(0);
  assert.equal(await page.evaluate(() => Reflect.get(window, "ownedMarkdownExecuted")), undefined);
  if (narrow) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "thought content must not widen the page");
    for (const selector of ["pre", "table"]) {
      const locallyScrollable = await region.locator(selector).evaluate(element => {
        for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(style.overflowX)) return true;
        }
        return false;
      });
      assert.ok(locallyScrollable, `${selector} needs local horizontal scrolling`);
    }
  }
}

export async function checkThoughtMarkdown(page: Page, origin: string, narrow: boolean, daemon: ReturnType<typeof evolveDaemon>): Promise<void> {
  const remoteImages: string[] = [];
  page.on("request", request => { if (request.url().startsWith("https://image.invalid/")) remoteImages.push(request.url()); });
  for (const author of ["user", "ai"] as const) {
    const id = `idea-markdown-${author}`;
    const response = await page.request.get(`${origin}/api/ideas/${id}?scope=normal&part=view`);
    assert.equal((await response.json()).thought.text, markdownThought, "reading must preserve exact source");
    await page.goto(`${origin}/ideas/${id}`, { waitUntil: "networkidle" });
    await checkReading(page, page.locator("main"), narrow);
    const afterReading = await page.request.get(`${origin}/api/ideas/${id}?scope=normal&part=view`);
    assert.equal((await afterReading.json()).thought.text, markdownThought, "rendering must not change the source returned by the read boundary");
  }
  await page.goto(`${origin}/browse/browse-markdown`, { waitUntil: "networkidle" });
  await checkReading(page, page.getByRole("region", { name: "Selected idea" }), narrow);
  await page.goto(`${origin}/export?thoughtId=export-markdown`, { waitUntil: "networkidle" });
  const setup = page.getByRole("region", { name: "Simple export setup" });
  await expect(setup.getByRole("heading", { name: "Export reading heading" })).toBeVisible();
  const sourceLink = setup.getByRole("link", { name: /External source/ });
  await expect(sourceLink).toHaveAttribute("href", "https://example.com/export-source");
  await expect(sourceLink).toHaveAttribute("target", "_blank");
  await expect(sourceLink).toHaveAttribute("rel", /\bnoopener\b/);
  await expect(sourceLink).toHaveAttribute("rel", /\bnoreferrer\b/);
  if (narrow) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Simple export setup must not widen the page");
  await page.goto(`${origin}/evolve?thoughtId=evolve-markdown`, { waitUntil: "networkidle" });
  if (narrow) await page.getByRole("button", { name: /^starting thought/i }).click();
  await checkReading(page, page.locator("#evolve-starting-context"), narrow);
  await page.getByRole("textbox", { name: "Your contribution" }).fill(markdownThought);
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("evolve-run-1", { exact: false }).first()).toBeVisible();
  const contribution = page.locator("main").locator("section").filter({ hasText: "Owned Markdown heading" }).last();
  await expect(contribution.getByRole("heading", { name: "Owned Markdown heading" })).toBeVisible();
  const admission = daemon.attempts.findLast(call => call.method === "POST" && call.path.endsWith("/evolve"));
  assert.equal(JSON.parse(admission?.body ?? "null").text, markdownThought);
  daemon.setStatus("evolve-run-1", "completed", { outputs: 1, outputText: markdownThought });
  const development = page.locator("article").filter({ hasText: "Development 1" });
  await expect(development.getByRole("button", { name: /expand saved development/i })).toBeVisible({ timeout: 15000 });
  await expect(development.getByRole("heading", { name: "Owned Markdown heading" })).toHaveCount(0);
  await development.getByRole("button", { name: /expand saved development/i }).click();
  await checkReading(page, development, narrow);
  assert.deepEqual(remoteImages, [], "rendering must not request remote images");
}
