# 发布流程与验证清单

这份文档只讲一件事：怎么把这个扩展装进真实浏览器验证一遍，然后打包提交。

要**逐项体验功能**（不是发布验证）看 [TRY-IT.md](TRY-IT.md)。

## 当前发布事实与验证边界

当前待发布构建是扩展 `0.4.4`（`private-composer-r9-send-gate-2026-09-07.1`），随包语义模型为
`r9-electra-chat-augmented/checkpoint-3798`，离线检查点路径为
`artifacts/r9-electra-chat-augmented/checkpoint-3798`，运行阈值为 `0.15`。

这组标识来自 `src/manifest.json` 与 `src/assets/model/runtime_manifest.json`。每次换模型、阈值或版本号，
都必须先重新运行构建、类型检查、单测和真实浏览器自检；旧 R8 的浏览器数字不能作为 R9 的性能或正确性证据。

## 历史 R8 浏览器记录（不代表当前 R9）

`ml/docs/r3-model-card.md` 从 R3 起立着的那条门槛——**本地语义模型能否在真实浏览器里加载并给出
正确结果**——曾由 `npm run test:browser` 在 Chrome 152 上验证。下面的记录保留用于排查回归，
但不是本次 R9 发布的验收结果：

| | |
|---|---|
| 冷启动（首次请求含模型加载） | 386–420 ms |
| 模型加载 | 241–267 ms |
| 后续每次检查 | 81–84 ms |
| 设置页 JS 堆占用 | 约 20 MB |
| CSP / WASM 错误 | 0 |
| 与离线评测的跨度一致性 | 4/4（浏览器回归）、6/6（扩展内自检） |

它当时验证的是四件 Node 与 jsdom 都测不到的事：`chrome.offscreen.createDocument` 在真实浏览器里成功、
ONNX Runtime 的 WASM 在 `script-src 'self' 'wasm-unsafe-eval'` 下加载并实例化、跨两跳
`chrome.runtime` 之后的跨度与离线评测一致、以及冷启动与内存的真实数字。

**它第一次跑起来就抓到两个会让产品彻底不工作的缺陷，两个都是静默的：**

1. **service worker 里两个 `onMessage` 监听器抢应答通道。** `background.ts` 原先无条件 `return true`
   并对任何消息调 `sendResponse`，包括不认识的类型；`neural-host.ts` 也 `return true`。两个都返回 true
   时 Chrome 采用**第一个**调 `sendResponse` 的结果，而 background 对非侧边栏来源立即返回
   `invalid_message`，神经那条要等 offscreen 创建加一次推理，所以每次都输——**内容脚本永远拿不到模型
   提示**。单测抓不到，因为每个监听器都是隔离测的。现由 `tests/message-listener-ownership.test.ts` 钉住。
2. **ORT 的胶水文件没打进包。** `build.mjs` 的注释断言"bundle 版内联了 emscripten 胶水，只需要那个
   .wasm"。这对 bundle 本身成立，对我们的配置不成立：`ort-runner.ts` 把 `env.wasm.wasmPaths` 设成目录
   URL，字符串前缀会让 ORT 把 `ort-wasm-simd-threaded.mjs` 也从那个目录解析，覆盖内联的那份。少了它，
   真实浏览器里报 `no available backend found`，当时表现为 offscreen 记 `ready: false` 后继续走旧的纯规则路径。
   也就是说**模型对每一个装了扩展的人都从来没工作过**。现由 `tests/build.test.ts` 钉住所需文件；
   当前 R9 的发送门控不再把这类失败静默降级为“可直接发送”。

如果自动化在别的机器上不可用，扩展内置的自检页仍然是一分钟内可完成的人工替代，见下一节。装载方式
（自己 spawn Chrome + `connectOverCDP` + CDP `Extensions.loadUnpacked`）与所有试过并失败的路径记在
`tests/browser/launch-extension.mjs` 顶部。

## 为什么仍然保留手动自检

`--load-extension` 在 Chrome 137+ 已被忽略，Playwright 自己 spawn 浏览器时也装不上，Edge 在这台机器上
Node `spawn` 层就 `EACCES`。所以自动化依赖一套很具体的顺序，换机器可能失效。扩展内的自检页
（`diagnostics.html`）不依赖任何自动化，任何人都能在自己浏览器里一分钟内跑完并留下报告。

具体是四件 Node 与 jsdom 都测不到的事：

1. `chrome.offscreen.createDocument` 在真实浏览器里能否成功——所有现有测试都把它打了桩。
2. ONNX Runtime 的 WASM 能否在 `script-src 'self' 'wasm-unsafe-eval'` 下加载并实例化。
   `tests/manifest.test.ts` 只断言了这个 CSP **字符串**存在，不等于 Chrome 会接受一次动态
   `import()` 去实例化 WASM。**而且 CSP 拒绝是静默的**：离屏文档记下 `ready: false`，扩展退化成
   纯规则，用户看不到任何报错。
3. 跨过两跳 `chrome.runtime` 之后的跨度是否与离线评测一致（结构化克隆、UTF-16 偏移、消息校验器
   都在这条路上）。
4. 冷启动与内存在浏览器里到底多少。

试过并确认不可行的路径，记下来免得重复踩（全部在 Chrome 152 上）：

| 路径 | 结果 |
|---|---|
| `--load-extension` | 被忽略。加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 或 `--enable-unsafe-extension-debugging` 都一样；即使命令行完全由我们控制，`/json/list` 里也只有 Chrome 自带的组件扩展 |
| Playwright `launchPersistentContext` + CDP `loadUnpacked` | 返回 id，但扩展不可达：`chrome://extensions` 列表为空、扩展页 `ERR_BLOCKED_BY_CLIENT`、内容脚本不注入、无 service worker target |
| `Target.createTarget({newWindow:true})` | 新窗口里导航到扩展页仍失败（`chrome-error://chromewebdata`） |
| 两阶段：装进持久化 profile 后重启 | 同样 `ERR_BLOCKED_BY_CLIENT` |
| Edge 151 | Node `spawn` 直接 `EACCES`，尽管 PowerShell 里直接运行 msedge.exe 正常、ACL 也允许执行 |

**可行的那一条**：自己 `spawn` chrome.exe（不经 Playwright），带 `--remote-debugging-port` 与
`--enable-unsafe-extension-debugging`，然后 `chromium.connectOverCDP` 连上去，再用 CDP
`Extensions.loadUnpacked` 装载。这样扩展在 `chrome://extensions` 里是 enabled、扩展页返回 200、
`chrome.runtime` 可用、service worker 与 offscreen 都能起来。实现在
`tests/browser/launch-extension.mjs`。当 Chrome 阻止 CDP 临时装载扩展页时，该神经用例会明确标为跳过；
跳过不关闭真实浏览器门槛，仍必须运行下方的扩展内置自检。

## 当前本地语义发送门控

默认档为 **balanced + 本地神经模型**。输入时的缓存只用于预热：用户点击发送后，扩展会先拦下原生
提交，并对**最终草稿原文**执行本地语义复核；它不依赖“打字时恰好已命中缓存”。

复核成功后才进入既有检测、确认与匿名化发送路径。缓存未命中、模型不可用、推理失败或草稿超过
5,000 个字符时，扩展会显示“本地语义复核未完成”，用户只能选择**仅本次按原文发送**或取消。
该路径没有“模型失败后静默按纯规则放行原文”的降级。

R8 时的盲测数字只保留在历史模型卡中，不能用于推断 R9 的当前指标。

安装时会打开一次 `welcome.html`，把开的是什么、代价多少讲清楚，并提供一键"改成更少提示"（也就是
旧的那一档）。**默认值改了但用户不知道，才是不能接受的那一种。** 详见
`src/shared/custom-terms.ts` 里 `DEFAULT_ADVANCED_SETTINGS` 上方的注释。

## 一、装载并跑自检

```powershell
npm run build
```

然后：

1. 打开 `chrome://extensions/`，右上角打开**开发者模式**。
2. 点**加载已解压的扩展程序**，选择仓库里的 `dist` 目录。
3. **新开一个窗口**。新装的扩展不会出现在装载之前就存在的窗口里，这一步不能省。
4. 首次安装会自动打开说明页（`welcome.html`）。顺便确认它真的弹了——那是默认设置的配套告知。
5. 点扩展图标 → **本地模型自检** → **开始自检**。
6. 把"报告"框里的文本复制出来存档。

设置页顶部的语义审查状态行现在也会说明模型的**运行时**状态（已就绪并给出加载耗时 / 尚未加载 /
加载失败及原因），而不只是"已启用"。状态由 offscreen 文档经 `chrome.storage.session` 发布——设置页
不发消息，`tests/build.test.ts` 断言打包后的 `popup.js` 不含 `sendMessage`，那是一条隐私属性。

自检页会给出：offscreen 是否就绪、模型加载耗时、冷启动与逐条耗时、此页 JS 堆占用，以及 6 条草稿
的预期跨度与实测跨度逐条比对。

**怎么判断通过**：状态行显示"全部通过"，且 6/6 一致。预期跨度由
`scripts/emit-selfcheck-expectations.mjs` 从出货产物算出，那条路径由金标准夹具钉住与 Python 参考
一致——所以"一致"意味着这个浏览器的行为等于离线评测的行为。

**常见的不通过与含义**：

| 现象 | 含义 |
|---|---|
| `offscreen 文档就绪：否`，且报错含 CSP / WebAssembly | 扩展页 CSP 下 WASM 加载被拒。这是门槛的核心项，必须解决而不是绕过 |
| `模型产物：读取失败` | `src/assets/model` 三件套没打包进 `dist`。`npm run build` 会在这种情况下打 warning 而不是报错，因为纯规则模式是受支持的配置 |
| 某几条跨度不一致 | 浏览器 WASM 内核与离线 native CPU 内核的差异。已知一条 402 字的多窗口草稿会有 6-7 处 argmax 翻转；如果**单窗口**草稿也不一致，那是移植缺陷，不是内核差异 |
| 全部为空且 offscreen 就绪 | 阈值或标签顺序读错了，看 `runtime_manifest.json` |

自检**不覆盖**：真实站点上的发送拦截、粘贴保护、附件提醒，以及 R9 的“最终草稿复核”门控。
那些要在支持的站点上手动试。至少完成一次：在 `local_neural` 模式下输入无锚词的人名后立即点击发送；
原站点不能先收到原文，随后应进入检测/确认流程。再用模型不可用或超过 5,000 字的草稿复测，预期只能
看到“仅本次按原文发送”或取消，不能静默发送。

## 二、模型换了以后必须重做的事

出货产物换了（换检查点、换阈值、重新导出），下面每一步都要重做，否则夹具和自检会与实际行为脱节：

```powershell
# 1. 数值一致性
cd ml
.venv\Scripts\python.exe -m chinese_pii_training.verify_onnx `
  --model artifacts/<新检查点> `
  --onnx reports/generated/r7/<导出目录>/model.onnx `
  --int8 ../src/assets/model/model.int8.onnx

# 2. 重新生成 parity 夹具（从 src/assets/model 读，不要指向别的导出目录）
.venv\Scripts\python.exe reports\generated\r7\emit_parity_fixtures.py
cd ..

# 3. 端到端 smoke，与 Python 参考逐位比
node scripts/smoke-neural-runner.mjs

# 4. 重新生成自检预期，并把输出贴进 src/diagnostics.ts
npm run selfcheck:expectations

# 5. 全量回归
npx tsc --noEmit; npx vitest --run; npm run build
```

`tests/build.test.ts` 会检查 `src/diagnostics.ts` 里记录的产物名与 `dist` 实际打包的一致，
`scripts/package-extension.mjs` 也会——所以忘了第 4 步会在打包时被拦下，不会静默发出去。

## 三、打包

```powershell
npm run package
```

产物在 `release/`。这个命令会先构建再做发布前检查，任何一项不过就不出压缩包。检查项与理由：

- **保留文件名**：`dist` 里任何以 `_` 开头的条目都会让 Chrome 拒绝加载**整个扩展**
  （`Cannot load extension with file or directory name __neural-eval.mjs`）。九个离线评测脚本
  以前都往 `dist` 写 `__*.mjs` 临时 bundle，导致"扩展能不能装"取决于最后跑过哪个脚本。现在它们
  写到 `.harness-tmp/`（`scripts/harness-paths.mjs`），并且构建、单测、打包三处都断言这条性质。
- **manifest 完整性**：名称、描述长度（≤132）、版本号格式、四个尺寸的图标、`manifest_version: 3`、
  CSP 含 `'wasm-unsafe-eval'`。
- **权限逐条有说明**：`permissions` 与脚本里的 `PERMISSION_JUSTIFICATIONS` 必须完全对应，多一个
  少一个都不过。隐私类扩展被拒最常见的原因就是权限没解释清楚。同时拒绝 `tabs` 权限和
  `<all_urls>` 之类的宽泛 host 匹配。
- **自检与产物一致**：见上一节。
- **模型三件套与 ORT WASM 都在包里**；模型缺失只 warning（纯规则模式受支持），但 WASM 缺失会失败。
- **`PRIVACY.md` 与 `THIRD_PARTY_NOTICES.md` 存在**。

当前包体：37 个文件，解包 43.17 MB，压缩后 18.03 MB。最大的五个是 ORT WASM 13.32 MB、
学生模型 12.3 MB、英文 OCR 数据 3.9 MB、tesseract 胶水 3.7 MB、tesseract WASM 2.7 MB。

## 四、提交商店时要准备的

命令输出里会把权限说明逐条打出来，直接抄。除此之外需要人工填的：

- **单一用途说明**：在支持的 AI 聊天网页上，发送前于本地识别并替换敏感信息。
- **首次运行行为**：安装后会打开一个本地说明页（`welcome.html`），说明默认启用了哪一档以及如何调低。
  不含任何远程请求。
- **数据处理声明**：不收集、不传输任何用户数据。检测、模型推理、OCR 全部在本机完成；
  自定义词条只存 `chrome.storage.local`，不使用 `chrome.storage.sync`。详见 `PRIVACY.md`。
- **远程代码说明**：无远程代码。ONNX Runtime 与 tesseract 的 WASM 都随包分发
  （`dist/vendor/`），模型权重随包分发（`dist/assets/model/`）。
- **`offscreen` 与 WASM 为什么必要**：见权限说明里那一条，审核最可能问这个。
- **截图与商店图**：已生成在 `release/store-assets/`，四张 1280×800 截图为真实浏览器实拍，
  另有 440×280 与 1400×560 宣传图。重新生成：`npm run store:assets`。逐项文案见
  [STORE-LISTING.md](STORE-LISTING.md)。

## 五、当前状态

| 项 | 状态 |
|---|---|
| 当前扩展版本 | `0.4.4`（`private-composer-r9-send-gate-2026-09-07.1`） |
| 出货模型 | `r9-electra-chat-augmented/checkpoint-3798` @0.15 |
| 出货默认值 | balanced + 本地神经模型（见上文；首次安装有说明页与一键调低） |
| 构建、单测、类型检查 | 已通过：前端关键回归 290/290、ML 测试 167/167、TypeScript 无错误 |
| ONNX 数值一致性与跨度一致性 | 已通过：R9 parity 夹具与 runtime manifest 的 artifact、阈值、窗口和标签一致 |
| **真实 Chrome 验证** | 已通过 `npm run test:browser`：Chrome 153，8/8；冷启动 397 ms，模型加载 255 ms，后续 79–82 ms，popup heap 19.5 MB，控制台错误 0 |
| **真实 Edge 验证** | 尚未完成；不能用 Chrome 结果代替 Edge |
| **真实站点认证发送** | ChatGPT/Claude/Gemini 等仍需在用户自有登录态用合成文本逐站验收最终草稿门控 |
| 商店截图与宣传图 | 必须确认截图显示当前 R9 行为后再上传 |
| 商店上架文案 | 见 [STORE-LISTING.md](STORE-LISTING.md)，不得引用未经 R9 复测的性能或基准数字 |
| 发布前检查与打包 | 已通过 `npm run package`；`release/AI-私密编辑-0.4.4.zip`，37 个文件，18.03 MB，SHA-256 `1F9A836CDD81B011A80840E0D439F2A5415E47CD216F57D5CA8BBE4E0AD55BA7` |

剩余发布门槛是 Edge 实测、支持站点认证发送路径和最终草稿门控的人工验收；Chrome offscreen/WASM 自检与当前 R9
打包链路已经留证，不能把这些已通过项误写成所有浏览器和站点都已通过。
