from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "AI私密编辑_使用流程说明报告_P0-P2.docx"

BLUE = "2E74B5"
DARK_BLUE = "1F4D78"
INK = "1F2933"
MUTED = "5E6B78"
LIGHT_BLUE = "E8EEF5"
CALLOUT = "EDF5FC"
WARNING_FILL = "FFF4E5"
WARNING = "9A4D00"
GRID = "C7D4E2"
WHITE = "FFFFFF"

TABLE_WIDTH_DXA = 9360
TABLE_INDENT_DXA = 120
CELL_MARGINS = {"top": 80, "bottom": 80, "start": 120, "end": 120}


def set_run_font(
    run,
    *,
    size: float | None = None,
    color: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    font: str = "Calibri",
    east_asia_font: str = "Microsoft YaHei",
) -> None:
    run.font.name = font
    run._element.rPr.rFonts.set(qn("w:ascii"), font)
    run._element.rPr.rFonts.set(qn("w:hAnsi"), font)
    run._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia_font)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def set_style_font(
    style,
    *,
    size: float,
    color: str = INK,
    bold: bool = False,
    font: str = "Calibri",
    east_asia_font: str = "Microsoft YaHei",
) -> None:
    style.font.name = font
    style._element.rPr.rFonts.set(qn("w:ascii"), font)
    style._element.rPr.rFonts.set(qn("w:hAnsi"), font)
    style._element.rPr.rFonts.set(qn("w:eastAsia"), east_asia_font)
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style.font.bold = bold


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_borders(cell, *, color: str = GRID, size: str = "6") -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right"):
        tag = qn(f"w:{edge}")
        border = borders.find(tag)
        if border is None:
            border = OxmlElement(f"w:{edge}")
            borders.append(border)
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), size)
        border.set(qn("w:space"), "0")
        border.set(qn("w:color"), color)


def set_cell_margins(cell, margins: dict[str, int] = CELL_MARGINS) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for side, value in margins.items():
        node = tc_mar.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_geometry(table, widths_in: list[float], *, indent_dxa: int = TABLE_INDENT_DXA) -> None:
    if abs(sum(widths_in) - 6.5) > 0.01:
        raise ValueError("Table widths must total 6.5 inches / 9360 DXA")

    widths_dxa = [round(width * 1440) for width in widths_in]
    widths_dxa[-1] = TABLE_WIDTH_DXA - sum(widths_dxa[:-1])

    table.autofit = False
    table_pr = table._tbl.tblPr
    tbl_w = table_pr.first_child_found_in("w:tblW")
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        table_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(TABLE_WIDTH_DXA))
    tbl_w.set(qn("w:type"), "dxa")

    tbl_ind = table_pr.first_child_found_in("w:tblInd")
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        table_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(indent_dxa))
    tbl_ind.set(qn("w:type"), "dxa")

    layout = table_pr.first_child_found_in("w:tblLayout")
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        table_pr.append(layout)
    layout.set(qn("w:type"), "fixed")

    grid = table._tbl.tblGrid
    for index, width in enumerate(widths_dxa):
        grid_col = grid.gridCol_lst[index]
        grid_col.set(qn("w:w"), str(width))

    for row in table.rows:
        row.height = None
        tr_pr = row._tr.get_or_add_trPr()
        cant_split = OxmlElement("w:cantSplit")
        tr_pr.append(cant_split)
        for index, cell in enumerate(row.cells):
            width = widths_dxa[index]
            cell.width = Inches(width / 1440)
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(width))
            tc_w.set(qn("w:type"), "dxa")
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            set_cell_margins(cell)
            set_cell_borders(cell)


def mark_header_row(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)
    for cell in row.cells:
        set_cell_shading(cell, LIGHT_BLUE)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(1)
        p.paragraph_format.line_spacing = 1.0
        for run in p.runs:
            set_run_font(run, size=9.5, color=DARK_BLUE, bold=True)


def set_paragraph_rule(paragraph, *, color: str = BLUE, size: str = "12") -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        p_pr.append(p_bdr)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), size)
    bottom.set(qn("w:space"), "5")
    bottom.set(qn("w:color"), color)
    p_bdr.append(bottom)


def add_field(run, field: str) -> None:
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = field
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, separate, text, end])


def add_text(paragraph, text: str, *, bold: bool = False, color: str = INK, size: float = 11, italic: bool = False) -> None:
    run = paragraph.add_run(text)
    set_run_font(run, size=size, color=color, bold=bold, italic=italic)


def add_styled_paragraph(
    doc: Document,
    text: str = "",
    *,
    style: str = "Normal",
    alignment: WD_ALIGN_PARAGRAPH | None = None,
) -> object:
    paragraph = doc.add_paragraph(style=style)
    if alignment is not None:
        paragraph.alignment = alignment
    if text:
        add_text(paragraph, text)
    return paragraph


def configure_document(doc: Document) -> None:
    section = doc.sections[0]
    section.page_width = Inches(8.27)
    section.page_height = Inches(11.69)
    section.left_margin = Inches(0.885)
    section.right_margin = Inches(0.885)
    section.top_margin = Inches(0.68)
    section.bottom_margin = Inches(0.62)
    section.header_distance = Inches(0.3)
    section.footer_distance = Inches(0.32)

    normal = doc.styles["Normal"]
    set_style_font(normal, size=11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    h1 = doc.styles["Heading 1"]
    set_style_font(h1, size=16, color=BLUE, bold=True)
    h1.paragraph_format.space_before = Pt(18)
    h1.paragraph_format.space_after = Pt(10)
    h1.paragraph_format.keep_with_next = True
    h1.paragraph_format.keep_together = True

    h2 = doc.styles["Heading 2"]
    set_style_font(h2, size=13, color=BLUE, bold=True)
    h2.paragraph_format.space_before = Pt(14)
    h2.paragraph_format.space_after = Pt(7)
    h2.paragraph_format.keep_with_next = True
    h2.paragraph_format.keep_together = True

    h3 = doc.styles["Heading 3"]
    set_style_font(h3, size=12, color=DARK_BLUE, bold=True)
    h3.paragraph_format.space_before = Pt(10)
    h3.paragraph_format.space_after = Pt(5)
    h3.paragraph_format.keep_with_next = True

    caption = doc.styles.add_style("Guide Caption", WD_STYLE_TYPE.PARAGRAPH)
    set_style_font(caption, size=9, color=MUTED)
    caption.paragraph_format.space_before = Pt(4)
    caption.paragraph_format.space_after = Pt(7)
    caption.paragraph_format.line_spacing = 1.1

    small = doc.styles.add_style("Guide Small", WD_STYLE_TYPE.PARAGRAPH)
    set_style_font(small, size=9.5, color=MUTED)
    small.paragraph_format.space_before = Pt(0)
    small.paragraph_format.space_after = Pt(4)
    small.paragraph_format.line_spacing = 1.15

    code = doc.styles.add_style("Guide Code", WD_STYLE_TYPE.PARAGRAPH)
    set_style_font(code, size=9.5, color=INK, font="Consolas", east_asia_font="Microsoft YaHei")
    code.paragraph_format.space_before = Pt(2)
    code.paragraph_format.space_after = Pt(2)
    code.paragraph_format.line_spacing = 1.1

    configure_running_parts(section)


def configure_running_parts(section) -> None:
    header = section.header
    header.is_linked_to_previous = False
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    add_text(p, "AI 私密编辑", bold=True, color=DARK_BLUE, size=8.5)
    add_text(p, "  |  使用流程说明报告", color=MUTED, size=8.5)

    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    add_text(p, "v0.1.0  |  2026-08-26  |  第 ", color=MUTED, size=8.5)
    page_run = p.add_run()
    set_run_font(page_run, size=8.5, color=MUTED)
    add_field(page_run, "PAGE")
    add_text(p, " 页", color=MUTED, size=8.5)


def add_masthead(doc: Document) -> None:
    kicker = doc.add_paragraph()
    kicker.paragraph_format.space_before = Pt(8)
    kicker.paragraph_format.space_after = Pt(2)
    add_text(kicker, "MVP 使用参考", bold=True, color=BLUE, size=9.5)

    title = doc.add_paragraph()
    title.paragraph_format.space_before = Pt(0)
    title.paragraph_format.space_after = Pt(3)
    add_text(title, "AI 私密编辑", bold=True, color=INK, size=25)

    subtitle = doc.add_paragraph()
    subtitle.paragraph_format.space_before = Pt(0)
    subtitle.paragraph_format.space_after = Pt(12)
    add_text(subtitle, "中文 AI 聊天网页的发送与粘贴前本地脱敏、策略和词库管理流程", color=DARK_BLUE, size=14)

    metadata = doc.add_table(rows=4, cols=2)
    set_table_geometry(metadata, [1.875, 4.625])
    metadata_rows = [
        ("版本", "v0.1.0 本地脱敏、词库、白名单、类别策略、审计与配置迁移原型"),
        ("适用人群", "在中文 AI 聊天网页中直接输入并发送文本的普通用户"),
        ("支持范围", "豆包、DeepSeek、元宝 Beta、ChatGPT、Claude 网页聊天页；认证后发送路径须以合成文本验收"),
        ("文档性质", "操作说明；自定义词条仅保存在此浏览器本地，不构成“网页从未看到原文”或“完整安全保证”的承诺"),
    ]
    for row, (label, detail) in zip(metadata.rows, metadata_rows, strict=True):
        set_cell_shading(row.cells[0], LIGHT_BLUE)
        p_label = row.cells[0].paragraphs[0]
        p_label.paragraph_format.space_before = Pt(0)
        p_label.paragraph_format.space_after = Pt(0)
        add_text(p_label, label, bold=True, color=DARK_BLUE, size=9.5)
        p_detail = row.cells[1].paragraphs[0]
        p_detail.paragraph_format.space_before = Pt(0)
        p_detail.paragraph_format.space_after = Pt(0)
        add_text(p_detail, detail, size=9.5)

    rule = doc.add_paragraph()
    rule.paragraph_format.space_before = Pt(10)
    rule.paragraph_format.space_after = Pt(4)
    set_paragraph_rule(rule, color=BLUE, size="12")


def add_callout(doc: Document, *, title: str, body: str, warning: bool = False) -> None:
    table = doc.add_table(rows=1, cols=1)
    set_table_geometry(table, [6.5])
    cell = table.cell(0, 0)
    set_cell_shading(cell, WARNING_FILL if warning else CALLOUT)
    set_cell_borders(cell, color="E2C992" if warning else "B8D4EC", size="8")
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(1)
    p.paragraph_format.line_spacing = 1.2
    add_text(p, title, bold=True, color=WARNING if warning else DARK_BLUE, size=10.5)
    p = cell.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.2
    add_text(p, body, color=INK, size=10)


def add_table(
    doc: Document,
    headers: list[str],
    rows: list[list[str]],
    widths: list[float],
    *,
    font_size: float = 9.4,
) -> None:
    table = doc.add_table(rows=1, cols=len(headers))
    set_table_geometry(table, widths)
    for cell, header in zip(table.rows[0].cells, headers, strict=True):
        p = cell.paragraphs[0]
        add_text(p, header, bold=True, color=DARK_BLUE, size=9.5)
    mark_header_row(table.rows[0])

    for values in rows:
        row = table.add_row()
        for cell, value in zip(row.cells, values, strict=True):
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            add_text(p, value, size=font_size)
    set_table_geometry(table, widths)


def add_code_block(doc: Document, label: str, value: str) -> None:
    label_p = doc.add_paragraph(style="Guide Small")
    add_text(label_p, label, bold=True, color=MUTED, size=9.5)
    table = doc.add_table(rows=1, cols=1)
    set_table_geometry(table, [6.5])
    cell = table.cell(0, 0)
    set_cell_shading(cell, "F5F8FB")
    set_cell_borders(cell, color="D8E2ED", size="6")
    p = cell.paragraphs[0]
    p.style = "Guide Code"
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    add_text(p, value, color=INK, size=9.2)



def add_main_content(doc: Document) -> None:
    doc.add_paragraph("使用目标与数据边界", style="Heading 1")
    body = doc.add_paragraph()
    add_text(
        body,
        "AI 私密编辑让用户直接在受支持 AI 网页的聊天输入框中输入。用户点击发送、按正常 Enter、触发表单提交或向已验证编辑器粘贴纯文本时，扩展先确认适配边界，再在浏览器本地检查当前文本：普通替换模式会把可替换的结构化敏感信息和用户保存的自定义敏感词变成令牌文本；严格模式、类别策略和高风险凭证会先停止操作并按策略请求确认。",
    )

    add_callout(
        doc,
        title="先明确这一条",
        body="用户直接输入网页聊天框的原文会存在于目标网页 DOM，页面脚本可能读取它。扩展不上传、不调用后端、不拦截网页网络请求；聊天草稿、原文和完整检测结果不持久化。用户主动添加的词条、白名单、策略和审计开关保存到本浏览器；审计开启时只保存站点、结果、类别和数量。未适配或适配健康检查失败时，扩展不会假装已经保护该页面。",
        warning=True,
    )

    doc.add_paragraph("当前可处理的内容", style="Heading 2")
    add_table(
        doc,
        ["处理方式", "内容范围", "发送行为"],
        [
            ["确认或阻止", "API 密钥、访问令牌、私钥、连接字符串和明确标签的高风险凭证", "按类别策略确认原文或始终阻止；原文留在编辑器"],
            ["令牌替换", "手机号、邮箱、有效身份证号、Luhn 有效卡号、IPv4、本机路径", "写入 [[PHONE_001]] 等令牌，再重放一次站点发送控件"],
            ["自定义替换", "用户保存的字面量自定义敏感词", "写入 [[CUSTOM_001]] 等令牌，再重放一次站点发送控件"],
            ["严格或策略确认", "严格模式下的可替换结构化信息和“发送前确认”类别", "停止当前操作，原文保留；取消、一次性原文或本会话允许由用户选择"],
            ["未命中", "规则没有识别到的无害文本或语义信息", "不改写、不提示，按网站原有路径发送"],
            ["粘贴边界", "富文本、图片、附件、音频、截图、已有聊天记录和规则外语义", "不会扫描或自动识别；仅纯文本粘贴进入已验证编辑器前可本地处理"],
        ],
        [1.12, 3.02, 2.36],
    )

    doc.add_paragraph("无感发送流程", style="Heading 1")
    add_table(
        doc,
        ["步骤", "用户动作", "扩展与网页结果"],
        [
            ["1", "在豆包、DeepSeek、元宝 Beta、ChatGPT 或 Claude 的网页输入框正常输入", "原文暂时位于网页输入框；扩展不维护侧栏草稿"],
            ["2", "点击发送、按正常 Enter、触发表单提交或向已验证编辑器粘贴纯文本", "内容脚本在捕获阶段确认站点、编辑器和发送控件均已验证；富文本粘贴保持网页原有路径"],
            ["3", "词库状态与本地规则检查", "健康检查失败走网页原生路径；词库加载或读取失败时停止已识别的非空发送和纯文本粘贴；就绪后按高风险、严格模式和类别策略决定匿名化、确认或阻止"],
            ["4", "替换后站点发送", "令牌文本写回网页输入框，已验证控件仅被程序化触发一次"],
            ["5", "替换后的控件不可用或页面变化", "令牌文本保留在输入框，显示“请手动发送”；不构造网络请求或重试"],
        ],
        [0.55, 2.42, 3.53],
    )

    add_code_block(doc, "合成替换样例", "请联系 13800138000，邮箱 li@example.com。")
    add_code_block(doc, "网页实际发送文本", "请联系 [[PHONE_001]]，邮箱 [[EMAIL_001]]。")
    add_code_block(doc, "合成自定义词样例", "请整理青岚项目的测试安排。")
    add_code_block(doc, "网页实际发送文本", "请整理 [[CUSTOM_001]] 的测试安排。")
    add_code_block(doc, "合成阻断样例", "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ")

    doc.add_page_break()

    doc.add_paragraph("首次使用", style="Heading 1")
    doc.add_paragraph("加载扩展", style="Heading 2")
    add_table(
        doc,
        ["浏览器", "操作"],
        [
            ["Chrome", "打开 chrome://extensions，开启“开发者模式”，选择“加载已解压的扩展程序”，选择项目中的 dist 文件夹。"],
            ["Edge", "打开 edge://extensions，开启“开发人员模式”，选择“加载解压缩的扩展”，选择项目中的 dist 文件夹。"],
        ],
        [1.18, 5.32],
    )
    note = doc.add_paragraph(style="Guide Small")
    add_text(
        note,
        "前提：浏览器版本需满足 Chromium 114 或更高版本。每次重新构建后，在扩展管理页点击重新加载，并刷新已经打开的受支持聊天页。",
        color=MUTED,
        size=9.5,
    )

    doc.add_paragraph("管理本地词库和策略", style="Heading 2")
    add_table(
        doc,
        ["步骤", "操作", "结果"],
        [
            ["1", "点击浏览器工具栏中的“AI 私密编辑”图标", "打开本地词库弹窗；词条、白名单、策略和审计开关仅保存在此浏览器本地，不同步或上传"],
            ["2", "选择个人、工作、项目或其他分组，在多行框中每行输入一个词条后点击“添加”", "整批词条按插入顺序保存；任一有效行重复、超长或超额时整批不保存"],
            ["3", "用搜索和分组筛选查看词条；使用“删除”移除单条词，或选择“清空全部”", "筛选只影响弹窗显示；每条最长 120 个字符、最多 100 条；清空全部需要确认"],
            ["4", "按需开启“严格模式”，或在“策略”视图设置自动匿名化、发送前确认或始终阻止", "命中可替换信息时按所选策略执行；始终阻止可通过白名单或调整策略解除"],
            ["5", "在“白名单”“审计”“迁移”视图管理精确放行、本地摘要和配置 JSON", "白名单可设全局或单站点；审计默认关闭且不含原文；导出 JSON 含词条和白名单，不能分享给无关人员"],
        ],
        [0.55, 3.15, 2.80],
    )
    add_callout(
        doc,
        title="词库未就绪时不发送",
        body="词库正在加载或读取失败时，扩展会停止已识别的非空发送动作，原文留在网页输入框。它不会把异常状态当作空词库放行。",
        warning=True,
    )
    add_callout(
        doc,
        title="严格模式只控制已验证发送路径",
        body="严格模式不会扩大站点范围，也不会在未适配或适配健康检查失败的页面拦截任意按钮。高风险密钥、访问令牌、私钥和连接字符串无论模式如何都会优先阻断。",
        warning=True,
    )

    doc.add_paragraph("打开支持页面", style="Heading 2")
    add_table(
        doc,
        ["站点", "正确入口", "使用前确认"],
        [
            ["豆包", "www.doubao.com 或 doubao.com 的聊天页面", "页面存在聊天输入框；首次配置词条时使用扩展图标"],
            ["DeepSeek", "chat.deepseek.com 的已登录聊天页面", "不要在 /sign_in 登录页输入或测试"],
            ["元宝 Beta", "yuanbao.tencent.com 的聊天页面", "公开未登录页面不拦截；认证后仅用合成文本完成发送路径验收"],
            ["ChatGPT", "chatgpt.com 的新对话或聊天页面", "仅当前精确 Composer 和发送按钮通过健康检查时接管；使用合成文本验收"],
            ["Claude", "claude.ai 的聊天页面", "仅唯一 ProseMirror 和发送按钮通过健康检查时接管；认证后路径需自有账号验收"],
        ],
        [1.10, 3.20, 2.20],
    )
    p = doc.add_paragraph()
    add_text(p, "加载后直接在网页聊天输入框输入并发送。日常发送无需打开弹窗；扩展没有侧栏、出站预览、填入网页按钮或后台服务。")

    doc.add_paragraph("发送后的三种结果", style="Heading 2")
    add_table(
        doc,
        ["结果", "页面变化", "用户应做什么"],
        [
            ["已匿名化发送", "网页收到令牌文本；右下角短暂显示类别与数量", "继续正常对话；提示不展示原文"],
            ["已阻止发送", "原文保留在输入框；没有新的聊天消息", "移除或改写高风险凭证后再发送"],
            ["需要确认或已取消", "原文保留在输入框；没有新的聊天消息或粘贴结果", "选择取消、一次性原文或本会话允许；本会话允许刷新页面即失效"],
            ["始终阻止", "原文保留；没有原文绕过按钮", "调整该类别策略，或只对白名单中明确认可的精确值放行"],
            ["词库未就绪", "原文保留在输入框；显示词库加载或读取失败提示", "等待词库就绪或检查弹窗中的本地词库后重试"],
            ["请手动发送", "令牌文本保留在输入框；页面控件未能确认", "检查令牌文本后手动点击发送，或刷新页面等待适配更新"],
            ["无提示", "扩展未命中规则，网页按原行为发送", "确认未命中内容可以交给目标网站"],
        ],
        [1.35, 2.78, 2.37],
    )

    doc.add_page_break()

    doc.add_paragraph("真实浏览器验收", style="Heading 1")
    p = doc.add_paragraph()
    add_text(p, "自动化单元测试不能替代当前网页版本的真实回归。发布前，请在 Chrome 和 Edge 分别对可登录的支持站点使用下列合成数据验证。")

    add_table(
        doc,
        ["检查项", "动作", "通过标准"],
        [
            ["替换", "输入手机号和邮箱样例，分别点击发送和按正常 Enter", "只提交 [[PHONE_001]]、[[EMAIL_001]] 等令牌"],
            ["自定义替换", "在工具栏弹窗添加“青岚项目”，关闭并重开弹窗后发送自定义词样例", "词条仍存在，网页只提交 [[CUSTOM_001]]"],
            ["严格模式", "开启严格模式后发送手机号或“青岚项目”样例", "不创建新的网页消息，编辑器保留完全相同的原文"],
            ["词库同步到标签页", "在支持页面打开后新增“客户编号-A17”", "无需刷新该标签页即可识别新增词条"],
            ["阻断", "输入合成密钥样例，分别点击发送和按正常 Enter", "不创建新的网页消息，原文仍在输入框"],
            ["纯文本粘贴", "向已验证编辑器粘贴手机号或邮箱样例", "编辑器只获得令牌文本；富文本粘贴保持原网页路径"],
            ["白名单和策略", "添加单站点白名单；分别选择发送前确认和始终阻止", "白名单原文放行；确认可取消；始终阻止无原文绕过"],
            ["本地审计", "开启审计后完成匿名化、取消和阻止操作", "弹窗只显示站点、操作、结果、类别和数量，不显示原文或令牌"],
            ["配置迁移", "生成配置 JSON，再导入一份合成配置", "导出不含审计记录或会话令牌；导入确认后原子替换，非法 JSON 不改变配置"],
            ["无匹配", "输入“请把这段无害测试文本改短。”", "维持网站原有发送行为，扩展不显示提示"],
            ["编辑边界", "Shift+Enter 换行；中文输入法候选确认", "不提前发送，不改写输入内容"],
            ["未适配或不健康页面", "打开 DeepSeek /sign_in、其他网站，或在测试夹具中移除编辑器/发送控件", "不自动写入、阻止、重放或显示保护成功提示"],
            ["元宝 Beta", "在自有已登录账号中，用合成文本测试发送锚点点击、正常 Enter、严格模式和输入法组合输入", "令牌或阻断行为与已验证规则一致；公开未登录或布局不唯一时不接管发送"],
            ["ChatGPT / Claude", "在自有登录态用合成文本测试点击、Enter、纯文本粘贴和确认路径", "若图标为 ! 则不接管；Claude 真实认证路径必须记录为已验证或未验证，不能以单元测试代替"],
        ],
        [1.08, 3.12, 2.30],
    )

    add_callout(
        doc,
        title="验收记录的边界",
        body="只有实际登录、加载扩展并在当前网页中看到令牌消息后，才能宣称真实站点验证通过。认证受限、浏览器不可用或站点 DOM 变化时，应记录为“未验证”，不能以单元测试替代。",
        warning=True,
    )

    doc.add_paragraph("隐私边界与责任", style="Heading 1")
    add_table(
        doc,
        ["阶段", "数据位置与行为", "用户应确认的事项"],
        [
            ["网页输入", "原文位于目标页面 DOM；扩展无法阻止页面脚本读取。", "不要把无法承受泄露风险的未知内容直接键入目标网页。"],
            ["本地配置", "用户添加的自定义敏感词、固定分组、白名单、类别策略和审计开关保存于 chrome.storage.local，不进行 Chrome 同步或上传。", "确认要保存的字面量符合自身的数据分类要求；可单条删除、清空或用已验证配置替换。"],
            ["本地审计", "默认关闭；开启后最多保存 100 条仅有站点、操作、结果、类别和数量的摘要。", "不记录原文、令牌或字段标签；可随时单独清空。"],
            ["本地检查", "扩展在浏览器内运行确定性规则；不调用后端、不读取 Cookie 或会话令牌。", "规则可能漏检或误检。"],
            ["健康检查", "站点、编辑器或发送控件未通过验证时，扩展走网页原生路径且不声称已保护。", "未适配页面不能视为受到本扩展保护。"],
            ["令牌发送", "仅复用一次已验证站点控件；不代理、复制或重放网络请求。", "确认令牌后的语义仍符合发送意图。"],
            ["未命中发送", "扩展不改变原站点事件。", "确认原文可以交给目标 AI 网站。"],
        ],
        [1.18, 3.22, 2.10],
    )

    add_callout(
        doc,
        title="不覆盖的风险",
        body="姓名、地址、业务语义、图片、附件、语音、规则外的密钥格式、恶意浏览器扩展和操作系统级记录器不在本工具防护范围内。此工具不替代个人审阅、组织数据分类制度或目标服务的安全评估。",
        warning=True,
    )

    doc.add_paragraph("已知范围与发布前提醒", style="Heading 1")
    add_table(
        doc,
        ["项目", "当前状态"],
        [
            ["已接入", "豆包、DeepSeek、元宝 Beta、ChatGPT、Claude 网页聊天页的精确 DOM 适配；仅纯文本粘贴进入已验证编辑器前可本地处理。"],
            ["尚不支持", "附件、图片、音频、截图、富文本粘贴和已有网页输入内容扫描。"],
            ["元宝 Beta 限制", "公开未登录页面的发送控件会原生放行。认证后的点击、Enter、严格阻断和输入法路径须在自有账号中以合成文本完成验收后，才能视为发布级验证。"],
            ["Claude 验收限制", "本环境未完成 Claude 登录态真实发送链路验收。若当前 DOM 不唯一或图标显示 !，扩展走网页原生路径，不能声称已保护。"],
            ["站点变化", "网页前端结构更新可能导致适配健康检查失败；此时扩展走网页原生路径。已开始的替换无法重放时，令牌文本会保留，用户可手动发送。"],
            ["公开发布", "发布到 Chrome Web Store 或 Edge Add-ons 前，需托管公开隐私政策 URL，并补全发行主体、联系渠道、适用地区和权利请求方式。"],
        ],
        [1.30, 5.20],
    )

    closing = doc.add_paragraph()
    closing.paragraph_format.space_before = Pt(14)
    closing.paragraph_format.space_after = Pt(0)
    set_paragraph_rule(closing, color="A7C7E5", size="6")
    add_text(closing, "推荐操作顺序：先在工具栏管理词条、白名单和策略，再正常输入、发送或粘贴纯文本；看到确认或阻断则审阅决定，看到令牌则确认结果，未命中或未适配页面则按网站原有路径处理。", bold=True, color=DARK_BLUE, size=10.5)

def main() -> None:
    document = Document()
    configure_document(document)
    add_masthead(document)
    add_main_content(document)

    document.core_properties.title = "AI 私密编辑使用流程说明报告"
    document.core_properties.subject = "v0.1.0 本地发送与粘贴前脱敏、白名单、策略、审计和配置迁移浏览器扩展使用说明"
    document.core_properties.author = "AI 私密编辑项目组"
    document.core_properties.keywords = "AI, 隐私, 脱敏, 自定义敏感词, 浏览器扩展, 使用流程"
    document.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    main()
