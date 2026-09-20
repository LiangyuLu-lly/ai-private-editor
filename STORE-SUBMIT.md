# Chrome / Edge 上架（人必须点的那几步）

仓库**不能**登录你的开发者帐号、不能代缴 Chrome 一次性 $5、不能代填营业执照实名。下面是已经备好的材料和你要点的按钮。

## 已经备好

| 项 | 位置 |
|---|---|
| 上传包 | `release/AI-私密编辑-0.4.4.zip`（约 18 MB，43 文件） |
| 商店文案 | [STORE-LISTING.md](STORE-LISTING.md) |
| 隐私政策公网 URL | 见下方 GitHub Pages（提交前确认能无登录打开） |
| 权限理由 | 打包日志已打印；与 STORE-LISTING「权限理由」表一致 |
| 图标 | `src/assets/icons/icon-128.png`（商店还要 128 图，包内已有） |

**还缺、必须你本地出的**

- 商店截图 1280×800（至少 1 张，建议 4 张）：`npm run store:assets` 在真实 Chrome 装载 `dist` 后拍。改过弹窗 UI 后，旧图不要用。
- Chrome Web Store 开发者帐号（[注册](https://chrome.google.com/webstore/devconsole)，约 $5，需与发行主体实名一致）。
- Microsoft 合作伙伴中心帐号（[Edge 扩展](https://partner.microsoft.com/dashboard/microsoftedge/overview)）。
- 联系邮箱：填进两家商店，并与隐私页询问渠道一致。

Edge 与 Chrome 用**同一 zip**。本仓库尚未做 Edge 登录态发送验收；上架时不要写「Edge 已完整验证」，只写 Chromium 116+。

---

## 隐私政策 URL

启用 GitHub Pages 后（`docs/`）：

```
https://liangyulul-lly.github.io/ai-private-editor/privacy.html
```

打不开就先用（公开仓库、无需登录）：

```
https://github.com/LiangyuLu-lly/ai-private-editor/blob/main/PRIVACY.md
```

---

## Chrome Web Store

1. 打开 https://chrome.google.com/webstore/devconsole  
2. 缴注册费（若尚未缴）。  
3. **新增商品** → 上传 `release/AI-私密编辑-0.4.4.zip`。  
4. 从 [STORE-LISTING.md](STORE-LISTING.md) 粘贴：名称、简短说明、详细说明、单一用途。  
5. 类别：隐私与安全。语言：简体中文。  
6. 图标：`icon-128.png`。截图：1280×800，至少一张。  
7. 隐私实践：全部数据类型选**不收集**；远程代码选**不使用**；粘贴 STORE-LISTING「数据处理声明」。  
8. 权限理由：逐条粘贴 `storage` / `sidePanel` / `offscreen` / 主机权限。  
9. 隐私权政策 URL：上面的 `privacy.html`。  
10. 分发：公开。地区按你能承担的法务选（不确定就先仅中国或仅自己能解释的地区）。  
11. **提交审核**。

审核常见问：`offscreen` 为什么要、WASM 是不是远程代码。答：WASM 与模型都在 zip 的 `vendor/`、`assets/model/`，不下载。

---

## Edge Add-ons

1. 打开 https://partner.microsoft.com/dashboard/microsoftedge/overview  
2. 用 Microsoft 帐号完成开发者注册（可能要手机/支付验证）。  
3. **创建新扩展**，上传**同一个** `AI-私密编辑-0.4.4.zip`。  
   若 Chrome 已上架，也可用「从 Chrome 网上应用店导入」，再改文案。  
4. 名称、说明、隐私 URL、截图与 Chrome 相同。  
5. 声明：不收集用户数据；无远程代码。  
6. 提交。

Edge 审核有时比 Chrome 快，有时会问主机权限列表，把 11 个域名原样贴上。

---

## 不要写进商店的句子

零泄露、个保法/等保认证、DLP、找出全部人名、Edge 登录态已发布级验证、元宝/Claude 登录态已保护。

---

## 提交后

审核要几天到几周。被拒把拒信全文留下，对照权限与单一用途改一版再传，不要改 zip 里的检测逻辑来「看起来更强」。
