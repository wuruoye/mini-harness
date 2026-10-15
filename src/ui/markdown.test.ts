import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { styleText } from "node:util";
import {
  displayWidth,
  MarkdownStream,
  renderInline,
  renderMarkdown,
  renderTable,
  RULE_WIDTH,
  STYLES,
  type StyleFn,
} from "./markdown.ts";

/** 把样式写成 <bold>…</bold> 这样的标记，方便断言 */
const tag: StyleFn = (format, text) => `<${format}>${text}</${format}>`;
/** 不加样式 */
const plain: StyleFn = (_format, text) => text;

/** 合并相邻的同样式片段、去掉空的样式片段：<bold>a</bold><bold>b</bold> → <bold>ab</bold> */
function normalize(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<(\w+)><\/\1>/g, "").replace(/<\/(\w+)><\1>/g, "");
  } while (text !== previous);
  return text;
}

function inline(text: string, style: StyleFn = tag): string {
  return renderInline(text, true, style).output;
}

/** 按 sizes 依次切片 push，最后 end，返回拼起来的输出 */
function streamInChunks(text: string, sizes: number[], style: StyleFn = tag): string {
  const stream = new MarkdownStream(style);
  let output = "";
  let start = 0;
  for (const size of sizes) {
    output += stream.push(text.slice(start, start + size));
    start += size;
  }
  output += stream.push(text.slice(start));
  return output + stream.end();
}

/** 固定种子的随机数，切分方式每次一样 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

test("styleText 可以直接当样式函数", () => {
  const style: StyleFn = styleText;
  assert.equal(typeof style, "function");
});

describe("displayWidth", () => {
  test("中日韩文字和全角符号占 2 格，ANSI 控制序列不占宽度", () => {
    assert.equal(displayWidth(""), 0);
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("a中b"), 4);
    assert.equal(displayWidth("，"), 2);
    assert.equal(displayWidth("\x1b[1m中\x1b[22m"), 2);
  });

  test("emoji 占 2 格，组合符号和零宽连接符不占宽度", () => {
    assert.equal(displayWidth("👍"), 2);
    assert.equal(displayWidth("👨‍👩‍👧"), 2);
    assert.equal(displayWidth("❤️"), 2);
    assert.equal(displayWidth("e\u0301"), 1);
  });
});

describe("renderInline", () => {
  test("行内代码、粗体、斜体、链接", () => {
    assert.equal(inline("用 `pnpm test` 跑"), "用 <cyan>pnpm test</cyan> 跑");
    assert.equal(inline("**粗** 和 *斜*"), "<bold>粗</bold> 和 <italic>斜</italic>");
    assert.equal(inline("[文档](https://x.dev)"), "<underline>文档</underline> <dim>(https://x.dev)</dim>");
  });

  test("粗体里面的格式递归渲染，行内代码里面原样输出", () => {
    assert.equal(inline("**a `b` c**"), "<bold>a <cyan>b</cyan> c</bold>");
    assert.equal(inline("`**x**`"), "<cyan>**x**</cyan>");
  });

  test("样式名取自 STYLES", () => {
    const named: StyleFn = (format, text) => `[${format}:${text}]`;
    assert.equal(inline("`a`", named), `[${STYLES.inlineCode}:a]`);
  });

  test("不构成格式的标记原样输出", () => {
    for (const text of [
      "a * b",
      "2*3",
      "**未结束",
      "** 不是粗体**",
      "数组 [1, 2]",
      "[a](有 空格)",
      "[](x)",
      "``",
      "结尾 *",
    ]) {
      assert.equal(inline(text), text, text);
    }
  });

  test("final 为 false 时停在还没结束的开头标记之前", () => {
    assert.deepEqual(renderInline("前面 **粗", false, tag), { output: "前面 ", consumed: 3 });
    assert.deepEqual(renderInline("a *", false, tag), { output: "a ", consumed: 2 });
    assert.deepEqual(renderInline("看 [文档]", false, tag), { output: "看 ", consumed: 2 });
    assert.deepEqual(renderInline("用 `代", false, tag), { output: "用 ", consumed: 2 });
  });

  test("final 为 false 时，已经能确定不是格式的不用等", () => {
    for (const text of ["a * b", "x [1] y", "普通文字", "**粗** 完"]) {
      assert.equal(renderInline(text, false, tag).consumed, text.length, text);
    }
  });

  test("在任意位置切成两段渲染，结果和整行一次渲染相同", () => {
    const lines = [
      "前 **粗** 中 *斜* 后",
      "用 `a*b` 和 [链接](https://x.dev) 以及 [1, 2]",
      "2*3 和 a * b，还有 **未结束",
      "*a**b* 和 ``空``",
      "**a `b` c** [x](y",
    ];
    for (const line of lines) {
      const whole = inline(line);
      for (let k = 0; k <= line.length; k++) {
        const first = renderInline(line.slice(0, k), false, tag);
        assert.ok(first.consumed <= k);
        const rest = renderInline(line.slice(first.consumed), true, tag);
        assert.equal(first.output + rest.output, whole, `${line} 在 ${k} 处切开`);
      }
    }
  });
});

describe("renderTable", () => {
  test("表头加粗，对齐行换成横线，按显示宽度补空格", () => {
    const border = tag(STYLES.tableBorder, " │ ");
    assert.equal(
      renderTable(["| 名称 | 说明 |", "|---|---|", "| a | **粗** |"], tag),
      [
        `<bold>名称</bold>${border}<bold>说明</bold>`,
        tag(STYLES.tableBorder, "─────┼─────"),
        `a   ${border}<bold>粗</bold>  `,
      ].join("\n"),
    );
  });

  test("列数取最多的一行，缺的格当作空；对齐方式忽略", () => {
    assert.equal(renderTable(["| a | b |", "|:-|--:|", "| c |"], plain), ["a │ b", "──┼──", "c │  "].join("\n"));
  });

  test("第二行不是对齐行时，每行按普通文字渲染", () => {
    assert.equal(renderTable(["| a |", "| **b** |"], tag), "| a |\n| <bold>b</bold> |");
    assert.equal(renderTable(["| a |"], tag), "| a |");
  });
});

describe("MarkdownStream", () => {
  function render(text: string): string {
    return normalize(renderMarkdown(text, tag));
  }

  test("标题：去掉 #，整行加粗，里面的行内格式照常渲染", () => {
    assert.equal(render("# 标题\n正文"), "<bold>标题</bold>\n正文");
    assert.equal(render("## 用 `x`\n"), "<bold>用 <cyan>x</cyan></bold>\n");
    assert.equal(render("#不是标题"), "#不是标题");
    assert.equal(render("####### 七个"), "####### 七个");
  });

  test("列表标记换成圆点，保留缩进；有序列表原样", () => {
    assert.equal(render("- 一\n  * 二\n+ **三**"), "• 一\n  • 二\n• <bold>三</bold>");
    assert.equal(render("1. 一\n2. 二"), "1. 一\n2. 二");
  });

  test("引用", () => {
    assert.equal(render("> 引用 *斜*\n>紧挨"), "<dim>│ </dim>引用 <italic>斜</italic>\n<dim>│ </dim>紧挨");
  });

  test("分隔线要整行才能确定", () => {
    const rule = `<dim>${"─".repeat(RULE_WIDTH)}</dim>`;
    assert.equal(render("---\n后面"), `${rule}\n后面`);
    assert.equal(render("***"), rule);
    assert.equal(render("___  \n"), `${rule}\n`);
    assert.equal(render("--flag 参数"), "--flag 参数");
    assert.equal(render("**粗**开头"), "<bold>粗</bold>开头");
  });

  test("代码块里不做解析，结束行也加 fence 样式", () => {
    assert.equal(
      render("```ts\nconst a = **1**;\n\n`x`\n```\n后面 **粗**"),
      "<dim>```ts</dim>\n<green>const a = **1**;</green>\n\n<green>`x`</green>\n<dim>```</dim>\n后面 <bold>粗</bold>",
    );
    assert.equal(render("  ```\n  code\n  ```"), "<dim>  ```</dim>\n<green>  code</green>\n<dim>  ```</dim>");
    assert.equal(render("```\nabc"), "<dim>```</dim>\n<green>abc</green>");
  });

  test("表格结束时交给 renderTable 一起输出", () => {
    const table = ["| a | b |", "|---|---|", "| 1 | 2 |"];
    const rendered = normalize(renderTable(table, tag));
    assert.equal(render(`前\n${table.join("\n")}\n后`), `前\n${rendered}\n后`);
    assert.equal(render(table.join("\n")), rendered);
    assert.equal(render(`${table.join("\n")}\n\n后`), `${rendered}\n\n后`);
    assert.equal(render(`${table.join("\n")}\n`), `${rendered}\n`);
  });

  test("普通文字马上输出，格式标记等到能判断时再输出", () => {
    const stream = new MarkdownStream(tag);
    assert.equal(stream.push("普通文字"), "普通文字");
    assert.equal(normalize(stream.push("，这是 **粗")), "，这是 ");
    assert.equal(normalize(stream.push("体** 完")), "<bold>粗体</bold> 完");
    assert.equal(stream.end(), "");
  });

  test("标题确定之后，后面的内容逐字输出", () => {
    const stream = new MarkdownStream(tag);
    assert.equal(stream.push("#"), "");
    assert.equal(stream.push(" "), "");
    assert.equal(normalize(stream.push("标")), "<bold>标</bold>");
  });

  test("没等到结尾的标记，在行尾或 end 时原样输出", () => {
    assert.equal(normalize(new MarkdownStream(tag).push("a **b\n")), "a **b\n");
    const stream = new MarkdownStream(tag);
    assert.equal(normalize(stream.push("a **b")), "a ");
    assert.equal(normalize(stream.end()), "**b");
  });

  test("表格在结束前不输出", () => {
    const stream = new MarkdownStream(tag);
    assert.equal(stream.push("| a |"), "");
    assert.equal(stream.push("\n|-|\n| 1 |"), "");
    assert.equal(normalize(stream.end()), normalize(renderTable(["| a |", "|-|", "| 1 |"], tag)));
  });

  test("不管怎么切分，输出都和一次渲染整段相同", () => {
    const doc = [
      "# 标题 **粗**",
      "普通段落，有 `code`、*斜体* 和 [链接](https://example.com)，还有 2*3 和 a * b。",
      "- 列表 **一**",
      "  * 子项",
      "> 引用",
      "---",
      "```ts",
      "const x = `模板 ${1}`;",
      "**不解析**",
      "```",
      "| 名称 | 说明 |",
      "|---|---|",
      "| a | **粗** |",
      "结尾 **没有闭合",
    ].join("\n");
    const whole = render(doc);
    const wholePlain = renderMarkdown(doc, plain);

    const oneByOne = Array.from({ length: doc.length }, () => 1);
    assert.equal(normalize(streamInChunks(doc, oneByOne)), whole);
    assert.equal(streamInChunks(doc, oneByOne, plain), wholePlain);

    for (let k = 0; k <= doc.length; k++) {
      assert.equal(normalize(streamInChunks(doc, [k])), whole, `在 ${k} 处切开`);
    }

    const random = seededRandom(42);
    for (let round = 0; round < 50; round++) {
      const sizes: number[] = [];
      for (let total = 0; total < doc.length; ) {
        const size = 1 + Math.floor(random() * 8);
        sizes.push(size);
        total += size;
      }
      assert.equal(normalize(streamInChunks(doc, sizes)), whole, `第 ${round} 轮随机切分`);
    }
  });
});
