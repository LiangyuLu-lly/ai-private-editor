import { getSiteAdapter } from "./registry.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

export type SiteAdapterHealth =
  /**
   * 输入框已确认，扩展可以在这个 composer 上挂拦截。
   *
   * `sendControl` 允许为 null：多数站点在输入框为空时**根本不渲染**发送按钮（ChatGPT 换成语音按钮、
   * Gemini 直接不插入），那是空闲状态而不是适配失效。把它当失效会让扩展在每个站点、每次打开页面时
   * 误报，还会连带关掉粘贴拦截、输入时语义检查和侧栏填入——这些都只需要输入框。
   *
   * 发送控件此刻是否存在、是否可用，由 pre-send.ts 在真实发送那一刻回答。
   */
  | { state: "ready"; adapter: SiteAdapter; editor: EditableElement; sendControl: SendControl | null }
  | { state: "unsupported" }
  | {
      state: "unverified";
      adapter: SiteAdapter;
      reason: "editor_not_found" | "composer_root_not_found";
    };

export function assessSiteAdapterHealth(document: Document, url: URL): SiteAdapterHealth {
  const adapter = getSiteAdapter(url);
  if (adapter === null) {
    return { state: "unsupported" };
  }

  const editor = adapter.findEditor(document);
  if (editor === null) {
    return { state: "unverified", adapter, reason: "editor_not_found" };
  }

  const sendControl = adapter.findSendControl(document, editor);

  /*
   * 发送按钮当前是否存在、是否可用，**都不在**健康检查的判断范围内。
   *
   * 这里原先有一句 `if (adapter.isSendControlDisabled(sendControl)) return unverified`，它让扩展在
   * 每个支持的站点、每次打开页面时都误报。所有 AI 聊天站在输入框为空时都会禁用（或不渲染）发送按钮，
   * 而那是**空闲状态**，不是适配失效。后果有两个，都在真实浏览器里复现过：
   *
   *   1. 一打开页面就弹"当前页面未验证（发送按钮当前不可用），敏感文本可能按原文发送"，工具栏挂橙色
   *      警告。先随便打几个字才会变成绿色。第一印象就是一次假警报，而反复出现的假警报会训练用户忽略
   *      真警报。
   *   2. `state !== "ready"` 会挡住侧边栏的填入路径（content.ts 里返回 `editor_not_found`），所以
   *      刚打开页面时"私密编辑器 → 填入网页"根本用不了。
   *
   * 分层应当是：健康检查回答"能不能挂上拦截"，`pre-send.ts` 在真实发送那一刻回答"现在能不能动作"。
   * 后者本来就独立检查了 `isSendControlDisabled`（pre-send.ts 两处），所以这里去掉不会放过任何东西：
   * 按钮真的不可用时，发送路径仍然会走 `warnManualSend()`。
   *
   * 也没有改用"输入框为空时才放过"这种写法，那样会引入新的竞态：用户打下第一个字符时输入框已非空、
   * 而站点可能还没来得及启用按钮，于是第一次击键就误报一次。
   *
   * 后来发现只放过"禁用"还不够：豆包把禁用状态写进了选择器（`:not([disabled])`），而 ChatGPT 和 Gemini
   * 在空输入时是把发送按钮**换掉或不渲染**，`findSendControl` 直接返回 null。所以 `sendControl` 改成可
   * 为 null，判断一律下沉到 pre-send。
   *
   * 代价要说清楚：站点改版把发送按钮选择器打断时，这里也会得到 null，与"空闲"不可区分。因此
   *   - pre-send 的点击识别在 `sendControl === null` 时一定返回 false，不会误接管别的按钮；
   *   - Enter 和表单提交仍然会被拦截（它们本来就不需要发送按钮），比旧行为多保护一层；
   *   - 徽标那一层用"输入框里有没有字"来区分：有字却仍找不到发送按钮才报未验证（见 content.ts），
   *     这样既不会在空白页面误报，也不会在选择器真的失效时假称已保护。
   */

  // composer 归属检查只在真的拿到发送控件时才有意义：它要验证的是"输入框和发送按钮属于同一个
  // composer"，发送按钮此刻不存在时没有可验证的配对关系。
  if (adapter.findComposerRoot !== undefined && sendControl !== null) {
    const composerRoot = adapter.findComposerRoot(document, editor, sendControl);
    if (composerRoot === null || !composerRoot.contains(editor) || !composerRoot.contains(sendControl)) {
      return { state: "unverified", adapter, reason: "composer_root_not_found" };
    }
  }

  return { state: "ready", adapter, editor, sendControl };
}
