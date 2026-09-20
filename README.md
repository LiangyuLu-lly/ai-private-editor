<p align="center">
  <img src="src/assets/icons/icon-128.png" width="96" height="96" alt="AI 私密编辑">
</p>

<h1 align="center">AI 私密编辑</h1>
<p align="center"><strong>AI Private Editor</strong></p>

<p align="center">
  Chromium MV3 本地发送门 · Local send-gate before chat leaves your browser<br>
  <em>GPL-3.0-or-later · 无后端 · no network permission</em>
</p>

<p align="center">
  <a href="#zhongwen">中文</a> · <a href="#english">English</a>
</p>

---

<a id="zhongwen"></a>

## 这是什么

在豆包、DeepSeek、元宝、ChatGPT、Claude、Gemini、Kimi、通义千问、文心一言的**已验证聊天框**里，点发送或粘贴纯文本时，扩展先在**这台电脑**上检查草稿：

- 手机号、邮箱、校验通过的身份证等，可替换成 `[[PHONE_001]]` 这类令牌再交给网站。
- 密钥、严格模式、模型给出的人名/地址候选，会先弹出确认。确认框只列类别和数量，不展示原文。
- 自定义姓名、项目名写进词库；词库只存在本机。

这不是「所有敏感信息都已被挡住」。人名会漏；漏了不会弹窗。网页输入框里的字，页面脚本仍可能读到。

<p align="center">
  <img src="docs/readme/popup.png" width="360" alt="工具栏弹窗：ON 徽章与自定义词库">
</p>
<p align="center"><sub>工具栏弹窗。ON = 本页已接管。首页用来补模型会漏的姓名。</sub></p>

<p align="center">
  <img src="docs/readme/welcome.png" width="520" alt="首次启用页：说明默认档位与姓名漏检">
</p>
<p align="center"><sub>首次启用页。默认「平衡 + 本地神经模型」；没认出的姓名不会提示。</sub></p>

---

<a id="english"></a>

## What this is

On **verified chat composers** for Doubao, DeepSeek, Yuanbao, ChatGPT, Claude, Gemini, Kimi, Qwen, and Ernie, the extension inspects the draft **on this device** before Send or a plain-text paste:

- Structured values (phone, email, checksum-valid national ID, …) can be replaced with tokens such as `[[PHONE_001]]` before the site sees them.
- Secrets, strict mode, and model-proposed names/addresses require confirmation. The dialog lists **kinds and counts**, never the raw string.
- Put real names and project codenames in the local lexicon. It never syncs.

This is **not** “all sensitive text is blocked.” Names leak. A miss produces **no prompt**. Text typed into the page DOM can still be read by the site’s own scripts.

---

## 它做什么、不做什么 / Does / does not

| 做 Does | 不做 Does not |
|---|---|
| 发送前、纯文本粘贴前在本机检查 | 不扫描已有聊天记录 |
| 规则 + 约 12 MB 本地 INT8 学生模型 | 不把草稿上传到本扩展的任何服务器（扩展无网络权限） |
| 工具栏 **ON** / **OFF** 显示本页是否接管 | 不保证找出全部人名、地址 |
| 词库、白名单、策略只存在 `chrome.storage.local` | 不处理附件/图片**内容**、富文本粘贴、网页已发起的上传 |
| 模型不可用时失败闭合：只能取消或明确原文 | 不是等保 / 个保法认证 / DLP |

---

## 发送路径 / Send path

<p align="center">
  <img src="docs/readme/flow.svg" width="920" alt="输入框 → 本机检查 → 令牌或确认 / 未接管则放行 → 网站">
</p>

1. 你在已适配页输入。扩展不改你正在打的字。
2. 点击发送或站点发送快捷键时，先确认编辑器和发送控件还在。
3. **ON**：走本地规则（及可选模型）。命中替换则改为令牌并重放一次发送；命中确认则停住。
4. **OFF / 无徽章**：不接管，网页按原路径发送。不要把这种页面当成已保护。

You type as usual. On Send, if the page is **ON**, the draft is checked locally. Replacements become tokens and are replayed once; confirmations pause the send. **OFF** means native send — do not treat that tab as protected.

<p align="center">
  <img src="docs/readme/confirm.png" width="720" alt="发送前确认：匿名化发送，原文需再点一次">
</p>
<p align="center"><sub>确认框。默认「匿名化发送」。原文发送是危险操作，必须再点一次。</sub></p>

---

## 工具栏状态 / Toolbar

| 徽章 Badge | 中文 | English |
|---|---|---|
| **ON** | 当前编辑器已接管。仍可能漏检。 | Composer is hooked. Misses still go out. |
| **OFF**（工具栏为 `!`） | 本页未通过健康检查，按网页原生发送。 | Health check failed; native send. |
| **—** | 不在支持站点，或仍在检查。 | Unsupported site, or still checking. |

空输入导致发送按钮消失，仍可显示 ON（空闲，不是失效）。输入框里**有字**却找不到发送按钮 → OFF。

An empty composer that hides the send button can still be **ON** (idle, not a broken adapter). Text in the box but no send control → **OFF**.

弹窗左上角的 ON/OFF 与工具栏徽标同源。

---

## 比较稳的 vs 只是辅助 / Reliable vs assistive

**比较稳（格式 + 校验）**  
手机号、邮箱、校验位合法的中国身份证号、Luhn 卡号、护照、车牌、统一社会信用代码、IP、本机路径、API 密钥/令牌、私钥、连接串，以及「标签 + `:`/`：`/`是`/`为`/`叫`」后的值。

**只是辅助（会漏）**  
人名、地址、账号别名：本地模型给出候选后**一律确认**，不会静默改写。没认出来则无提示，原文按网站路径发出。把真实姓名写进词库。

**Reliable:** structured / checksummed values and labeled fields.  
**Assistive only:** person names, addresses, account aliases. Model hits always confirm; misses are silent. Put real names in the lexicon.

---

## 支持的网站 / Supported sites

| 站点 Site | 主机 Host | 登录态发送 Login-path |
|---|---|---|
| 豆包 Doubao | `www.doubao.com`, `doubao.com` | 需自有账号用合成文本验收 |
| DeepSeek | `chat.deepseek.com` | `/sign_in` 不支持；登录态需验收 |
| 元宝 Yuanbao | `yuanbao.tencent.com` | 公开页已取证；登录态未发布级验证 |
| ChatGPT | `chatgpt.com` | 登录态需合成文本验收 |
| Claude | `claude.ai` | 登录/登出页不支持 |
| Gemini | `gemini.google.com` | 空输入不渲染发送钮，仍可 ON |
| Kimi | `www.kimi.com` | 登录态需验收 |
| 通义 Qwen | `www.qianwen.com` | 登录态需验收 |
| 文心 Ernie | `yiyan.baidu.com`, `wenxin.baidu.com` | 登录态需验收 |

只有当前页编辑器通过健康检查才接管。站点改版后选择器失效 → OFF，网页原生放行。

---

## 安装 / Install

需要 Chromium 116+（Chrome / Edge）。本仓库是源码，不是商店包。

Requires Chromium 116+. This repository is source, not a store package.

```powershell
git clone https://github.com/LiangyuLu-lly/ai-private-editor.git
cd ai-private-editor
npm install
npm test
npm run build
```

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）。
2. 打开「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择本仓库的 `dist/`。
4. 每次重新 `npm run build` 后，在扩展页点「重新加载」，再刷新聊天页。

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Enable Developer mode.
3. Load unpacked → select this repo’s `dist/`.
4. After every `npm run build`, click Reload on the extension, then refresh the chat tab.

`npm run test:browser` 会驱动本机 Chrome 做 offscreen/WASM 抽检；被 CDP 策略拦住时会明确跳过，不能代替扩展里的「本地模型自检」。

`npm run test:browser` drives system Chrome. If CDP blocks temporary extension loads, those cases skip — they do not replace in-extension “本地模型自检”.

---

## 使用 / Usage

1. 打开支持的聊天页，等工具栏或弹窗出现 **ON**。
2. 把会漏的姓名、项目名加进词库（弹窗首页）。只存在这台浏览器。
3. 用**合成文本**试一次，例如 `请联系 13800138000` → 应发出 `[[PHONE_001]]`。
4. 人名请写进词库，或接受「模型漏了就不提示」。
5. 完整逐步清单：[TRY-IT.md](TRY-IT.md)。

1. Open a supported chat page and wait for **ON**.
2. Add names the model will miss on the popup home. Local only.
3. Smoke-test with synthetic text, e.g. `请联系 13800138000` → expect `[[PHONE_001]]`.
4. Put real names in the lexicon, or accept silent misses.
5. Full checklist: [TRY-IT.md](TRY-IT.md).

严格模式、白名单、类别策略、本地审计、配置迁移在 **更多设置**。私密编辑器是侧栏：本地检查后填入网页，**不会代你点发送**。

Strict mode, allowlist, category policy, local audit, and config export live under **更多设置**. The private composer is a side panel: it fills the page after a local check, and **does not click Send**.

---

## 数据边界 / Data boundary

扩展不申请 `<all_urls>`、`tabs`、`webRequest`、剪贴板或同步存储。主机权限仅限上表域名。

草稿走 `content script → service worker → offscreen` 做瞬时本地推理，不写入 IndexedDB / 网络。词库与可选审计摘要（最多 100 条，仅站点 + 结果类别计数，无原文）在 `chrome.storage.local`。

「本地」≠ 网站从未看到原文：你键入网页框的字已经在目标页 DOM 里。完整说明：[PRIVACY.md](PRIVACY.md)。

---

## 开发 / Development

| 命令 Command | 作用 |
|---|---|
| `npm test` | jsdom 单测 |
| `npm run build` | 写出可加载的 `dist/` |
| `npm run test:browser` | 真实 Chrome 抽检 |
| `npm run package` | 商店 zip（见 [RELEASE.md](RELEASE.md)） |

上架文案：[STORE-LISTING.md](STORE-LISTING.md)。商业化/免责提纲：[COMMERCIAL.md](COMMERCIAL.md)。第三方运行时与模型来源：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

随包 INT8 学生（R9 Electra-small，阈值 0.15）是辅助人名/地址/账号别名用的。训练脚本与数据**不在**本仓库。

---

## 许可 / License

源代码：[GNU GPL v3 or later](LICENSE)。

`src/assets/model/` 中的权重派生自 Apache-2.0 的 [`hfl/chinese-electra-small-discriminator`](https://huggingface.co/hfl/chinese-electra-small-discriminator)。OCR 与 ONNX Runtime 见 THIRD_PARTY_NOTICES。派生或上架修改版时，须提供 GPL 要求的对应源代码。
