import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMath from "remark-math"
import { visit } from "unist-util-visit"
import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "./message"

interface MathNode {
  type: "inlineMath" | "math"
  value: string
  meta: string | null
}

function parseMath(text: string, singleDollarTextMath = false): MathNode[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath })
    .parse(text)
  const nodes: MathNode[] = []
  visit(tree, (node) => {
    if (node.type === "inlineMath" || node.type === "math") {
      const math = node as {
        type: "inlineMath" | "math"
        value: string
        meta?: string | null
      }
      nodes.push({
        type: math.type,
        value: math.value,
        meta: math.meta ?? null,
      })
    }
  })
  return nodes
}

describe("remark-math with singleDollarTextMath: false", () => {
  it("does not parse currency pairs as inlineMath", () => {
    const text =
      "The Pro plan costs $9.99 but the Team plan costs $19.99 per month."
    expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
  })

  it("treats $x$ as literal text (recorded: reverts b23f6a5a)", () => {
    expect(parseMath("$x$")).toEqual([])
    expect(parseMath(normalizeMathDelimiters("$x$"))).toEqual([])
  })

  it("does not parse shell variables as inlineMath", () => {
    expect(parseMath("Set $HOME and $PATH before running.")).toEqual([])
    expect(parseMath("Use $1 and $2 as positional args.")).toEqual([])
  })

  it("keeps single-line \\(...\\) as inline math after normalize", () => {
    const nodes = parseMath(normalizeMathDelimiters("Also \\(x\\)."))
    expect(nodes).toEqual([{ type: "inlineMath", value: "x", meta: null }])
  })

  it("keeps multi-line \\(...\\) at the start of a block (does not drop the first line)", () => {
    const one = parseMath(normalizeMathDelimiters("\\(a\nb\\)"))
    expect(one).toHaveLength(1)
    expect(one[0]?.type).toBe("inlineMath")
    expect(one[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")

    const two = parseMath(normalizeMathDelimiters("\\(a\nb\n\\)"))
    expect(two).toHaveLength(1)
    expect(two[0]?.type).toBe("inlineMath")
    expect(two[0]?.value).toContain("a")
    expect(two[0]?.value).toContain("b")
  })

  it("keeps formula text when the closer sits on a continuation prefix", () => {
    const quote = parseMath(normalizeMathDelimiters("> \\(a\n> b\n> \\)"))
    expect(quote).toHaveLength(1)
    expect(quote[0]?.type).toBe("inlineMath")
    expect(quote[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")

    const list = parseMath(
      normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\) holds.")
    )
    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("inlineMath")
    expect(list[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")
  })

  it("keeps wrapped list-continuation math as inline, not a flow fence", () => {
    const nodes = parseMath(
      normalizeMathDelimiters("- Note that\n  \\(a + b\n  = c\\) holds.")
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe("inlineMath")
    expect(nodes[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("a+b=c")
  })

  it("parses CR / CRLF multiline \\(...\\) as inline math", () => {
    const crlf = parseMath(normalizeMathDelimiters("\\(a\r\n\\)"))
    expect(crlf).toHaveLength(1)
    expect(crlf[0]?.type).toBe("inlineMath")
    expect(crlf[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("a")

    const cr = parseMath(normalizeMathDelimiters("\\(a\rb\\)"))
    expect(cr).toHaveLength(1)
    expect(cr[0]?.type).toBe("inlineMath")
    expect(cr[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")
  })

  it("keeps every closing-line shape inside the formula", () => {
    // Each closing line is ambiguous from the line alone: a list marker,
    // one indented past the marker column, a tab-indented `>`, a `>` with no
    // enclosing blockquote. All are formula text and must survive.
    for (const [raw, keep] of [
      ["Before \\(a\n2. \\) after", "2."],
      ["Before \\(a\n    2. \\) after", "2."],
      ["paragraph\n2. \\(a\n2. \\) after", "2."],
      ["> \\(a\n\t> \\) after", ">"],
      ["> \\(a\n    > \\) after", ">"],
    ] as [string, string][]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.value).toContain(keep)
    }
  })

  it("keeps container continuations inline whatever their shape", () => {
    // Uneven markers, `>>` vs `> >`, a list inside a quote, a quote inside a
    // list at content column 4, and a lazily continued quote whose opening
    // line carries no marker at all.
    for (const raw of [
      "> \\(a\n > b\n > \\)",
      ">> \\(a\n> > b\n> > \\)",
      "> - \\(a\n>   b\n>   \\)",
      "- > \\(a\n  > b\n  > \\)",
      "10. > \\(a\n    > b\n    > \\)\n    > after",
      "> intro\n\\(a\n> b\n> \\)\n> after",
      "> intro\n\\(a\n> \\)\n> after",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.meta).toBeNull()
    }
  })

  it("pads container prefixes wider than three columns", () => {
    for (const raw of [
      "10. Note\n    \\(a\n    b\\)",
      "- outer\n  - inner\n    \\(a\n    b\\)",
      "- a\n  - b\n    - c\n      \\(x\n      y\\)",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.meta).toBeNull()
    }
  })

  it("leaves multi-line inline code alone in LF, CRLF and CR form", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const text = `\`\\(a${eol}b\\)\``
      expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
    }
  })
})

describe("block structure around a normalized formula", () => {
  function blockShape(text: string): string[] {
    const tree = unified()
      .use(remarkParse)
      .use(remarkMath, { singleDollarTextMath: false })
      .parse(text)
    const out: string[] = []
    visit(tree, (node) => {
      if (node.type === "paragraph") out.push("paragraph")
      if (node.type === "listItem") {
        out.push(`listItem(spread=${(node as { spread?: boolean }).spread})`)
      }
    })
    return out
  }

  // Relocating or dropping the closing line to keep `$$` off a line start
  // changes the surrounding block: a relocated prefix-only line is a BLANK
  // line, and a dropped one removes a soft break. Padding does neither.
  it("does not split the paragraph when prose follows the closer", () => {
    expect(blockShape(normalizeMathDelimiters("\\(a\nb\n\\)\nafter"))).toEqual([
      "paragraph",
    ])
    expect(
      blockShape(normalizeMathDelimiters("> \\(a\n> b\n> \\)\n> more text"))
    ).toEqual(["paragraph"])
  })

  it("keeps a list item tight when prose follows the closer", () => {
    expect(
      blockShape(normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\)\n  more"))
    ).toEqual(["listItem(spread=false)", "paragraph"])
    expect(
      blockShape(
        normalizeMathDelimiters("- a\n  \\(x\n  y\n  \\)\n  tail\n- b")
      )
    ).toEqual([
      "listItem(spread=false)",
      "paragraph",
      "listItem(spread=false)",
      "paragraph",
    ])
  })
})

describe("single-dollar math that reads as TeX", () => {
  const values = (text: string) =>
    parseMath(normalizeMathDelimiters(text)).map((node) => node.value)

  it("renders the inline formulas of a typical agent explanation", () => {
    const text =
      "预测的期望值由 $\\sum_i p_i \\cdot v_i$（各桶概率乘以桶中心值）决定。" +
      "预先定义好分桶区间 $[v_{\\min}, v_{\\max}]$，网络输出的都只是归一化概率 $p_i$。"
    expect(values(text)).toEqual([
      "\\sum_i p_i \\cdot v_i",
      "[v_{\\min}, v_{\\max}]",
      "p_i",
    ])
    for (const node of parseMath(normalizeMathDelimiters(text))) {
      expect(node.type).toBe("inlineMath")
    }
  })

  it("keeps prose dollars literal", () => {
    for (const text of [
      "The Pro plan costs $9.99 but the Team plan costs $19.99 per month.",
      "Between $5 and $10_000 a year.",
      "Set $HOME and $PATH before running.",
      "Use $1 and $2 as positional args.",
      "Run `echo $HOME_DIR` and `$PATH`, then $x$.",
      "Spend US$5_000 or $5-$10a.",
      "Literal \\$x_1$ and $a_b $ stay.",
      "${VAR} and ${HOME}_x are shell.",
      "Already $$x_1$$ display.",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(text))
      expect(nodes.map((node) => node.value)).toEqual(
        text.includes("$$x_1$$") ? ["x_1"] : []
      )
    }
  })

  it("leaves dollars inside code alone", () => {
    const text = "```\nprice = $a_1$\n```\nand `$x_i$` inline"
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it("does not span lines", () => {
    expect(values("first $a_1\nsecond b_2$")).toEqual([])
  })
})

describe("single-dollar math at the start of a block", () => {
  it("stays inline instead of opening a display fence", () => {
    for (const text of [
      "$p_i$ is first",
      "- $p_i$ in a list",
      "> $v_{\\max}$ quoted",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(text))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
    }
  })
})
