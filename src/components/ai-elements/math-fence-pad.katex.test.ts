import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMath from "remark-math"
import katex from "katex"
import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "./message"
import {
  MATH_FENCE_PAD,
  stripMathFencePad,
  type MdastNodeLike,
} from "./streamdown-plugins"

const Z = MATH_FENCE_PAD

/**
 * The string `rehype-katex` will hand to KaTeX: it reads the pre-rendered
 * `data.hChildren` that `mdast-util-math` attaches, not `node.value`.
 */
function katexInput(markdown: string, strip: boolean): string {
  const proc = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath: false })
  const tree = proc.runSync(proc.parse(markdown)) as unknown as MdastNodeLike
  if (strip) stripMathFencePad(tree)
  let found = "<no math node>"
  const walk = (node: MdastNodeLike) => {
    if (node.type === "inlineMath" || node.type === "math") {
      const hChildren = node.data?.hChildren
      found = Array.isArray(hChildren)
        ? (hChildren as { value?: string }[]).map((c) => c.value ?? "").join("")
        : String(node.value)
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children as MdastNodeLike[]) walk(child)
    }
  }
  walk(tree)
  return found
}

const render = (tex: string) =>
  katex.renderToString(tex, { throwOnError: false })

// U+200B is not whitespace to KaTeX — it lexes as a `textord`, which changes
// the spacing class of a terminal operator or punctuation. The pad only has to
// survive micromark's block tokenizer, so it is stripped from the tree before
// rehype-katex reads it.
describe("the math fence pad never reaches KaTeX", () => {
  const bodies = [
    "a,",
    "a+",
    "a=",
    "x^2",
    "\\alpha",
    "\\frac{1}{2}",
    "\\text{hi}",
    "\\begin{aligned} a &= b \\end{aligned}",
    "\\verb|x|",
  ]

  it("renders spacing-sensitive bodies identically to an unpadded source", () => {
    for (const body of bodies) {
      expect(render(katexInput(`x ${Z}$$${body}${Z}$$ y`, true))).toBe(
        render(katexInput(`x $$${body}$$ y`, false))
      )
    }
  })

  it("would differ without the strip — the check above is not vacuous", () => {
    expect(render(katexInput(`x ${Z}$$a,${Z}$$ y`, false))).not.toBe(
      render(katexInput("x $$a,$$ y", false))
    )
  })

  it("strips only the pad the normalizer appended", () => {
    expect(normalizeMathDelimiters("\\(a\nb\\)")).toBe(`${Z}$$a\nb${Z}$$`)
    const node: MdastNodeLike = {
      type: "inlineMath",
      value: `a${Z}b${Z}`,
      data: { hChildren: [{ type: "text", value: `a${Z}b${Z}` }] },
    }
    stripMathFencePad(node)
    expect(node.value).toBe(`a${Z}b`)
  })
})

describe("single-dollar formulas in agent prose", () => {
  function mathInputs(markdown: string): string[] {
    const proc = unified()
      .use(remarkParse)
      .use(remarkMath, { singleDollarTextMath: false })
    const tree = proc.runSync(proc.parse(markdown)) as unknown as MdastNodeLike
    const out: string[] = []
    const walk = (node: MdastNodeLike) => {
      if (node.type === "inlineMath" || node.type === "math") {
        out.push(String(node.value))
        return
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children as MdastNodeLike[]) walk(child)
      }
    }
    walk(tree)
    return out
  }

  it("hands every formula of the sentence to KaTeX, which renders it cleanly", () => {
    const text =
      "HL-Gauss 的优势：预测的期望值由 $\\sum_i p_i \\cdot v_i$（各桶概率乘以桶中心值）决定。" +
      "无论真实 Q 值是 1 还是 10000，只要预先定义好分桶区间 $[v_{\\min}, v_{\\max}]$，" +
      "网络输出的都只是归一化概率 $p_i$，权重范数不需要随奖励尺度膨胀。"
    expect(mathInputs(text)).toEqual([])
    const inputs = mathInputs(normalizeMathDelimiters(text))
    expect(inputs).toEqual([
      "\\sum_i p_i \\cdot v_i",
      "[v_{\\min}, v_{\\max}]",
      "p_i",
    ])
    for (const tex of inputs) {
      expect(render(tex)).not.toContain("katex-error")
    }
  })
})
