// 生成 Chrome Web Store 需要的截图与宣传图。
//
// 截图是**真拍**的，在真实 Chrome 里装载 dist 之后截。手绘或拼接的商店图片是审核驳回的常见原因，而且
// 一旦界面改了就会与实物不符。可自动化的前提是 tests/browser/launch-extension.mjs 那套装载顺序
// （自己 spawn Chrome + connectOverCDP + CDP Extensions.loadUnpacked），那里记着所有试过并失败的路径。
//
// 商店尺寸要求：截图 1280x800 或 640x400，宣传小图 440x280，宣传大图 1400x560。截图按 1280x800 拍，
// 宣传图用 SVG 画出来再由浏览器截成 PNG——项目里没有位图工具链，而浏览器本来就在跑。
//
// 用法：node scripts/capture-store-assets.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { launchWithExtension, repositoryRoot, waitFor } from "../tests/browser/launch-extension.mjs";

const outputDirectory = resolve(repositoryRoot, "release", "store-assets");
const SHOT = { width: 1280, height: 800 };

// 供截图用的假聊天页。用 route 拦一个已适配的站点域名，这样内容脚本会真的注入——截图里出现的
// 拦截确认框是扩展真实产生的，不是摆拍的。
const FAKE_SITE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AI 助手</title>
<style>
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body { margin:0; font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif; background:#f6f7f9; color:#1f2328;
         display:flex; flex-direction:column; height:100vh }
  header { padding:14px 22px; background:#fff; border-bottom:1px solid #e3e5e8; font-weight:600 }
  main { flex:1; padding:26px 22px; display:flex; flex-direction:column; gap:16px; overflow:auto }
  .bubble { max-width:640px; padding:12px 16px; border-radius:12px; background:#fff; border:1px solid #e3e5e8 }
  .me { align-self:flex-end; background:#e8f0fe; border-color:#cfe0fd }
  footer { padding:16px 22px 24px; background:#fff; border-top:1px solid #e3e5e8 }
  .composer { display:flex; gap:10px; align-items:flex-end; max-width:900px; margin:0 auto }
  textarea { flex:1; min-height:76px; resize:none; padding:12px 14px; border:1px solid #d6d9dd;
             border-radius:10px; font:inherit }
  .ds-button { width:44px; height:44px; border-radius:50%; background:#1a73e8; color:#fff;
               display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none;
               font-weight:700 }
</style></head>
<body>
  <header>AI 助手</header>
  <main>
    <div class="bubble">你好，有什么可以帮你？</div>
    <div class="bubble me">帮我把这段客户交接说明整理成正式邮件。</div>
    <div class="bubble">好的，请把内容发给我。</div>
  </main>
  <footer>
    <!--
      这段 DOM 刻意匹配 src/sites/deepseek.ts 的真实选择器：placeholder 含"发送消息"的 textarea，
      以及唯一一个 div[role=button].ds-button--primary.ds-button--filled.ds-button--circle。
      不匹配的话适配器判定为未验证、不拦截发送，而拦截确认框正是最重要的那张截图。
    -->
    <div class="composer">
      <textarea id="composer" placeholder="给 DeepSeek 发送消息"></textarea>
      <div id="send" role="button"
           class="ds-button ds-button--primary ds-button--filled ds-button--circle">↑</div>
    </div>
  </footer>
</body></html>`;

const DRAFT = "客户交接：对接人周妍舒，手机 13843029571，寄样地址武汉市洪山区霁虹街95号，发票邮箱 zhou@example.test。";

/** 宣传图用 SVG 画，再截成 PNG。项目里没有位图工具链，浏览器已经在跑。 */
function promoSvg(width, height, { title, subtitle, note }) {
  const titleSize = Math.round(height * 0.13);
  const subtitleSize = Math.round(height * 0.075);
  const noteSize = Math.round(height * 0.055);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f2b46"/><stop offset="1" stop-color="#12405f"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g transform="translate(${Math.round(width * 0.075)}, ${Math.round(height * 0.5)})">
    <text x="0" y="${-titleSize * 0.35}" fill="#ffffff" font-family="system-ui, 'Microsoft YaHei', sans-serif"
          font-size="${titleSize}" font-weight="700">${title}</text>
    <text x="0" y="${subtitleSize * 1.1}" fill="#a8c7e6" font-family="system-ui, 'Microsoft YaHei', sans-serif"
          font-size="${subtitleSize}">${subtitle}</text>
    <text x="0" y="${subtitleSize * 1.1 + noteSize * 1.9}" fill="#7fa6c9"
          font-family="system-ui, 'Microsoft YaHei', sans-serif" font-size="${noteSize}">${note}</text>
  </g>
</svg>`;
}

const PROMOS = [
  {
    name: "promo-small-440x280.png",
    width: 440,
    height: 280,
    copy: { title: "AI 私密编辑", subtitle: "发送前，在本机替换敏感信息", note: "不联网 · 不上传 · 不记录" },
  },
  {
    name: "promo-large-1400x560.png",
    width: 1400,
    height: 560,
    copy: { title: "AI 私密编辑", subtitle: "发送给 AI 之前，先在这台设备上替换敏感信息", note: "本地规则 + 本地模型 · 不联网 · 不上传 · 不记录" },
  },
];

await mkdir(outputDirectory, { recursive: true });
const { context, extensionId, browserVersion, close } = await launchWithExtension({ port: 9223 });
const captured = [];

try {
  console.log(`browser: ${browserVersion}`);
  console.log(`extension: ${extensionId}`);

  const shoot = async (page, name) => {
    const target = resolve(outputDirectory, name);
    await page.screenshot({ path: target });
    captured.push(name);
    console.log(`  ${name}`);
  };

  // 1. 首次运行页。它是默认值改动的知情同意配套，也是新用户看到的第一屏。
  const welcome = await waitFor(
    () => context.pages().find((page) => page.url().endsWith("/welcome.html")) ?? null,
  );
  if (welcome !== null) {
    await welcome.setViewportSize(SHOT);
    await welcome.waitForTimeout(400);
    await shoot(welcome, "01-welcome.png");
  }

  // 2. 真实站点上的发送拦截。这是产品的核心动作，必须是扩展自己弹出来的。
  await context.route("https://chat.deepseek.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FAKE_SITE_HTML }),
  );
  const site = await context.newPage();
  await site.setViewportSize(SHOT);
  await site.goto("https://chat.deepseek.com/");
  await site.waitForTimeout(1200);
  await site.fill("#composer", DRAFT);
  // 打字后等一下：模型复核是 debounce 的，语义候选要等它跑完才会出现在确认框里。
  await site.waitForTimeout(2500);
  await site.click("#send");
  const dialogAppeared = await waitFor(
    async () => (await site.locator("#privacy-composer-confirmation").count()) > 0,
    { attempts: 24 },
  );
  console.log(`  确认框出现: ${dialogAppeared === true}`);
  await site.waitForTimeout(400);
  await shoot(site, "02-send-confirmation.png");

  // 3. 设置页。
  const popup = await context.newPage();
  await popup.setViewportSize(SHOT);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForTimeout(800);
  await shoot(popup, "03-settings.png");

  // 4. 自检页跑完之后的样子。它是"模型真的在本机跑"的证据，也是审核最可能追问的那一点。
  const diagnostics = await context.newPage();
  await diagnostics.setViewportSize(SHOT);
  await diagnostics.goto(`chrome-extension://${extensionId}/diagnostics.html`);
  await diagnostics.click("#run-selfcheck");
  await waitFor(async () => (await diagnostics.locator("#report").inputValue()).length > 0, { attempts: 60 });
  await diagnostics.waitForTimeout(400);
  await shoot(diagnostics, "04-self-check.png");

  // 5. 宣传图。
  const canvas = await context.newPage();
  for (const promo of PROMOS) {
    await canvas.setViewportSize({ width: promo.width, height: promo.height });
    await canvas.setContent(
      `<html><body style="margin:0">${promoSvg(promo.width, promo.height, promo.copy)}</body></html>`,
    );
    await canvas.waitForTimeout(200);
    await shoot(canvas, promo.name);
  }

  await writeFile(
    resolve(outputDirectory, "MANIFEST.txt"),
    [
      `生成时间：${new Date().toISOString()}`,
      `浏览器：${browserVersion}`,
      `扩展 id：${extensionId}`,
      "",
      "截图为真实 Chrome 中装载 dist 后拍摄，未经拼接或修饰。",
      "重新生成：node scripts/capture-store-assets.mjs",
      "",
      ...captured.map((name) => `- ${name}`),
    ].join("\n"),
    "utf8",
  );
} finally {
  await close();
}

console.log(`\n共 ${captured.length} 张，输出在 ${outputDirectory}`);
