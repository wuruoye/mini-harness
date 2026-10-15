// 终端里的 Markdown 渲染。模型回复一段段到达：确定不会再变的部分马上输出，可能是格式标记的部分先存着，
// 等能判断了再输出，所以没有格式的文字逐字出现。终端里输出过的内容收不回来，只能等，不能先猜。
// 这里只把文字转成带样式的字符串，不写终端。样式函数由调用方传入：运行时传 node:util 的 styleText，
// 测试时传一个输出 <bold>…</bold> 这类标记的函数。

import { stripVTControlCharacters } from "node:util";

/** 用到的样式，名字和 styleText 的格式名一致 */
export type StyleFormat = "bold" | "italic" | "underline" | "dim" | "cyan" | "green";

/** 给一段文字加样式；styleText 可以直接传进来 */
export type StyleFn = (format: StyleFormat, text: string) => string;

/** 各种写法用的样式 */
export const STYLES = {
  heading: "bold",
  bold: "bold",
  italic: "italic",
  inlineCode: "cyan",
  codeBlock: "green",
  fence: "dim",
  link: "underline",
  linkUrl: "dim",
  quote: "dim",
  rule: "dim",
  tableBorder: "dim",
  tableHeader: "bold",
} satisfies Record<string, StyleFormat>;

/** 分隔线的长度 */
export const RULE_WIDTH = 40;

/**
 * 文字在终端里占几格，表格按它算列宽。
 * - 中日韩文字和全角符号占 2 格，其他字符占 1 格
 * - ANSI 控制序列（比如颜色 \x1b[1m）不占宽度
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const code = char.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b2ff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 渲染一段行内文字（不含换行），返回渲染结果和用掉的字符数。
 * final 为 true 表示这一行已经结束，后面不会再有内容；为 false 表示后面还可能有内容。
 *
 * 从左往右扫描，同一个位置按下面的顺序判断：
 * - 行内代码 `x`：一个反引号到下一个反引号，反引号去掉，中间原样加 STYLES.inlineCode。
 *   两个反引号挨着（中间为空）时，两个都按普通文字输出
 * - 粗体 **x**：开头的 ** 后面紧跟非空白字符；结尾是之后第一个前面紧跟非空白字符的 **。
 *   中间的内容按同样的规则渲染（final 为 true），整体加 STYLES.bold
 * - 斜体 *x*：单个 *（后面不是 *）后面紧跟非空白字符；结尾是之后第一个前面紧跟非空白字符的 *。
 *   中间同样递归渲染，整体加 STYLES.italic
 * - 链接 [文字](地址)：[ 之后第一个 ] 紧跟 (，再到之后第一个 )；文字和地址都不为空，地址不含空白。
 *   输出「文字加 STYLES.link」+ 空格 +「(地址) 加 STYLES.linkUrl」
 * - 不是格式开头的字符原样输出
 *
 * 判断不了的时候：
 * - final 为 false 时，遇到还没出现结尾的开头标记，或者要看下一个字符才能判断、下一个字符还没到
 *   （比如最后一个字符是 *，还不知道是不是 **），就停在这个标记之前：output 是前面渲染好的部分，
 *   consumed 是这个标记的位置。剩下的部分等后面的内容到了，接在前面一起再判断
 * - final 为 true 时，找不到结尾的开头标记按普通文字输出，从它后面一个字符接着扫描；consumed 等于 text.length
 * - 已经能确定不是格式的，不用等：比如 * 后面是空格、] 后面不是 (
 *
 * 保证：一行切成前后两段，前一段用 final 为 false 渲染，把没用掉的部分接到后一段前面再用 final 为 true 渲染，
 * 两次的 output 连起来和整行一次渲染相同
 */
export function renderInline(text: string, final: boolean, style: StyleFn): { output: string; consumed: number } {
  let output = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === i + 1) {
        output += "``";
        i += 2;
        continue;
      }
      if (end !== -1) {
        output += style(STYLES.inlineCode, text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      if (!final) break;
    } else if (char === "*") {
      const marker = text.startsWith("**", i) ? "**" : "*";
      const start = i + marker.length;
      if (start === text.length) {
        if (!final) break;
      } else if (!/\s/.test(text[start]!)) {
        let end = text.indexOf(marker, start + 1);
        while (end !== -1 && /\s/.test(text[end - 1]!)) end = text.indexOf(marker, end + 1);
        if (end !== -1) {
          const inner = renderInline(text.slice(start, end), true, style).output;
          output += style(marker === "**" ? STYLES.bold : STYLES.italic, inner);
          i = end + marker.length;
          continue;
        }
        if (!final) break;
      }
    } else if (char === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd === -1 || (labelEnd > i + 1 && labelEnd + 1 === text.length)) {
        if (!final) break;
      } else if (labelEnd > i + 1 && text[labelEnd + 1] === "(") {
        const start = labelEnd + 2;
        const end = text.indexOf(")", start);
        const url = text.slice(start, end === -1 ? undefined : end);
        if (end !== -1 && url !== "" && !/\s/.test(url)) {
          output += style(STYLES.link, text.slice(i + 1, labelEnd)) + " " + style(STYLES.linkUrl, `(${url})`);
          i = end + 1;
          continue;
        }
        if (end === -1 && !/\s/.test(url) && !final) break;
      }
    }
    output += char;
    i++;
  }
  return { output, consumed: i };
}

/**
 * 渲染一个完整的表格。lines 是表格各行的原文（不含换行）；返回的各行用 \n 连接，末尾不带换行。
 * - 每行去掉首尾空白和首尾的 |，按 | 分成单元格，每格去掉首尾空白
 * - 第二行的每一格都匹配 /^:?-+:?$/ 才算表格。不是表格时，每行按普通文字渲染（renderInline，final 为 true）
 * - 第二行（对齐行）不输出，换成表头下面的横线：每列 "─" 重复列宽次，列之间用 "─┼─" 连接，整行加 STYLES.tableBorder
 * - 单元格里的行内格式照常渲染。列数取格子最多的那一行，缺的格当作空字符串
 * - 列宽是这一列渲染后最宽的那格的 displayWidth，按去掉样式后的文字算（用一个不加样式的 StyleFn 渲染一遍）
 * - 每格在右边补空格到列宽，格之间用加了 STYLES.tableBorder 的 " │ " 连接，行首行尾不加边框
 * - 第一行是表头，每格渲染后、补空格之前加 STYLES.tableHeader
 * - 对齐方式（:---:）忽略，都左对齐
 */
export function renderTable(lines: string[], style: StyleFn): string {
  const cells = lines.map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (!cells[1]?.every((cell) => /^:?-+:?$/.test(cell))) {
    return lines.map((line) => renderInline(line, true, style).output).join("\n");
  }

  const columns = Math.max(...cells.map((row) => row.length));
  const rows = cells.filter((_row, index) => index !== 1);
  const widths = Array.from({ length: columns }, (_unused, column) =>
    Math.max(...rows.map((row) => displayWidth(renderInline(row[column] ?? "", true, (_format, text) => text).output))),
  );
  const separator = style(STYLES.tableBorder, " │ ");
  const rendered = rows.map((row, index) => widths.map((width, column) => {
    const cell = row[column] ?? "";
    const plain = renderInline(cell, true, (_format, text) => text).output;
    const content = renderInline(cell, true, style).output;
    return (index === 0 ? style(STYLES.tableHeader, content) : content) + " ".repeat(width - displayWidth(plain));
  }).join(separator));
  rendered.splice(1, 0, style(STYLES.tableBorder, widths.map((width) => "─".repeat(width)).join("─┼─")));
  return rendered.join("\n");
}

type LineKind = "start" | "plain" | "heading" | "fence" | "code" | "table";

/**
 * 流式渲染一条回复的正文：每收到一段文字调用 push，把返回的字符串写到终端；回复结束时调用 end，写出剩下的部分。
 * 一个对象只用于一条回复，下一条回复新建一个。
 *
 * 按行处理，先看一行的开头决定这一行是什么：
 * - 标题：1 到 6 个 # 加空格。# 和空格不输出，后面按行内规则渲染，输出的每一段再加 STYLES.heading
 * - 列表：可以有缩进，-、*、+ 加空格。缩进原样输出，标记和空格换成「• 」，后面按行内规则渲染
 * - 引用：> 开头。输出加了 STYLES.quote 的「│ 」，> 后面紧跟的一个空格不输出，后面按行内规则渲染
 * - 分隔线：整行（去掉末尾空白后）是 3 个以上的 -，或 3 个以上的 *，或 3 个以上的 _。
 *   输出加了 STYLES.rule 的 "─" 重复 RULE_WIDTH 次
 * - 代码块：可以有缩进，3 个以上反引号开头。这一行原样输出，加 STYLES.fence。之后的行都是代码，
 *   直到某一行去掉首尾空白后只剩 3 个以上的反引号，这一行同样原样加 STYLES.fence 输出，代码块结束。
 *   代码行原样输出，不做任何解析，加 STYLES.codeBlock；回复结束时代码块还没结束也照样输出
 * - 表格：| 开头。连续的 | 开头的行一起交给 renderTable，表格结束时一起输出；
 *   表格结束是指下一行开头不是 |，或者调用了 end。最后一行原文带换行的，输出后也补一个换行
 * - 其他：普通段落，按行内规则渲染。有序列表 1. 也当普通文字
 * 换行符原样输出，不加样式。
 *
 * 什么时候先存着：
 * - 一行开头还不能判断是哪种时，比如只收到 #、-、*、> 、两个反引号、几个空格；能判断了马上输出，
 *   这一行剩下的内容照样逐字输出
 * - 分隔线要整行才能判断：开头是 --、**、__ 这种时，存到出现别的字符（确定不是分隔线）或行尾
 * - 行内格式按 renderInline：final 为 false 时没用掉的部分先存着，收到换行时用 final 为 true 渲染完
 * - 代码块里，一行开头只有空白和反引号时先存着，判断是不是代码块结束的那一行
 * - 表格从第一行开始存着，直到表格结束
 *
 * 保证：同一段文字不管切成几段、在哪里切，依次 push 再 end，输出的文字和一次 push 整段相同。
 * 带样式时，同一个样式可能分成几段输出（比如 <bold>a</bold><bold>b</bold>），把相邻的同样式片段合并后相同
 */
export class MarkdownStream {
  private readonly style: StyleFn;
  private pending = "";
  private kind: LineKind = "start";
  private inCodeBlock = false;
  private tableLines: string[] = [];
  private tableEndsWithNewline = false;

  constructor(style: StyleFn) {
    this.style = style;
  }

  /** 收下一段文字，返回现在就可以输出的内容，可能是空字符串 */
  push(text: string): string {
    let output = "";
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.pending += text.slice(start, end);
      output += this.finishLine(true);
      start = end + 1;
    }
    this.pending += text.slice(start);
    return output + this.renderPending(false);
  }

  /** 回复结束：按「后面不会再有内容」处理存着的部分，全部返回 */
  end(): string {
    return this.finishLine(false) + this.flushTable();
  }

  /** 只有行开头需要判断块格式；确定之后，后续片段直接按同一种格式处理。 */
  private startLine(final: boolean): string | undefined {
    if (this.inCodeBlock) {
      const trimmed = this.pending.trim();
      if (!final && /^`*$/.test(trimmed)) return undefined;
      if (/^`{3,}$/.test(trimmed)) {
        this.kind = "fence";
        this.inCodeBlock = false;
      } else this.kind = "code";
      return "";
    }

    if (this.pending.startsWith("|")) {
      this.kind = "table";
      return "";
    }
    const heading = /^#{1,6} /.exec(this.pending);
    if (heading) {
      this.kind = "heading";
      this.pending = this.pending.slice(heading[0].length);
      return "";
    }
    if (this.pending.startsWith(">")) {
      if (this.pending.length === 1 && !final) return undefined;
      this.kind = "plain";
      this.pending = this.pending.slice(this.pending[1] === " " ? 2 : 1);
      return this.style(STYLES.quote, "│ ");
    }

    const rule = /^(-{3,}|\*{3,}|_{3,})\s*$/.test(this.pending);
    if (rule && final) {
      this.kind = "plain";
      this.pending = "";
      return this.style(STYLES.rule, "─".repeat(RULE_WIDTH));
    }
    if (!final && (rule || /^(-+|\*+|_+)$/.test(this.pending))) return undefined;

    if (/^\s*`{3,}/.test(this.pending)) {
      this.kind = "fence";
      this.inCodeBlock = true;
      return "";
    }
    const list = /^(\s*)[-*+] /.exec(this.pending);
    if (list) {
      this.kind = "plain";
      this.pending = this.pending.slice(list[0].length);
      return `${list[1]}• `;
    }
    if (!final && (/^\s*$/.test(this.pending) || /^#{1,6}$/.test(this.pending) || /^\s*(?:`{1,2}|[-*+])$/.test(this.pending))) {
      return undefined;
    }
    this.kind = "plain";
    return "";
  }

  private renderPending(final: boolean): string {
    let output = "";
    if (this.kind === "start") {
      // 表格要等下一行的第一个字符，才能确定是否已经结束。
      if (this.tableLines.length > 0 && (this.pending !== "" || final) && !this.pending.startsWith("|")) {
        output += this.flushTable();
      }
      const prefix = this.startLine(final);
      if (prefix === undefined) return output;
      output += prefix;
    }
    if (this.kind === "table") {
      if (final) {
        this.tableLines.push(this.pending);
        this.pending = "";
      }
      return output;
    }
    if (this.kind === "code" || this.kind === "fence") {
      if (this.pending !== "") output += this.style(this.kind === "code" ? STYLES.codeBlock : STYLES.fence, this.pending);
      this.pending = "";
      return output;
    }
    const rendered = renderInline(this.pending, final, this.style);
    if (rendered.output !== "") output += this.kind === "heading" ? this.style(STYLES.heading, rendered.output) : rendered.output;
    this.pending = this.pending.slice(rendered.consumed);
    return output;
  }

  private finishLine(newline: boolean): string {
    let output = this.renderPending(true);
    if (this.kind === "table") this.tableEndsWithNewline = newline;
    else if (newline) output += "\n";
    this.kind = "start";
    return output;
  }

  private flushTable(): string {
    if (this.tableLines.length === 0) return "";
    const output = renderTable(this.tableLines, this.style) + (this.tableEndsWithNewline ? "\n" : "");
    this.tableLines = [];
    this.tableEndsWithNewline = false;
    return output;
  }
}

/** 一次渲染一段完整的文字，结果和 push 整段再 end 相同。回复没有走流式时用 */
export function renderMarkdown(text: string, style: StyleFn): string {
  const stream = new MarkdownStream(style);
  return stream.push(text) + stream.end();
}
