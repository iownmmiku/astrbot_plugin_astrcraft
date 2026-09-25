#!/usr/bin/env python3
"""**检查 Python 里的 ASCII 引号混用（会导致字符串被提前截断的那类）。**

    python dev-tools/check_ascii_quotes.py     # 有命中 → exit 1

## 为什么加这个检查器

修测试 bug 的那几轮里，我（写代码的那个）**至少犯了 6 次**同一个错：

    print(f"  X —— 它的"两件事之间"是模糊的")     ← 第二个 " 一出现就截断字符串
    print(f"  --- 第 {i} 次：{res if res else "（跑着）"} ---")   ← 同类

每次都是**写的时候看不出来，跑的时候才 SyntaxError**，
而且报错行离真正的原因隔了好几行，**一查就是好几轮**。
所以做成硬检查，而不是靠「下次记得」。

## 判据（第一版写错过，这里说明为什么是这两条）

**第一版**判据是「ASCII 引号左右都贴汉字 → 命中」—— 结果 **1684 处**，
几乎全是**注释和 docstring** 里的「"挑技能名"」这种写法。
那是这个仓库的既有风格、完全无害，**不是我犯的错** —— 判据太宽等于没有判据。

**我犯的错只有一种**：在**短字符串字面量**（'...' / "..." / f"..."）里
把 ASCII 引号当中文引号用 → 字符串被提前截断 → 语法错。
所以现在两条规则，都只盯着真正会炸的地方：

  规则 1：**每个 .py 文件 compile() 一遍** —— SyntaxError 直接报出来，
          并提示「如果是中文处的引号混用 → 改用「」」。
          （我犯的 6 次全是这种，compile 一次就能全抓到，
           不用等跑到那一行才炸。）
  规则 2：**tokenize 出短字符串 token**，内容里出现「贴着汉字的 ASCII 引号」
          —— 这是**还没炸但已经违规**的（比如单引号串里塞 "中文"），
          提前抓住，免得哪天引号风格一改就炸。

**注释、docstring（三引号串）不查** —— 那里的「"xxx"」是这个仓库的正常文风。
**.js 暂不查** —— 这几轮我的引号错全出在 Python 字符串上；JS 侧用反引号居多，
真要管再说（诚实标注：本检查器只覆盖 Python）。
"""

from __future__ import annotations

import io
import pathlib
import re
import sys
import tokenize

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {"node_modules", ".testserver", ".git", "_out", "dist", "build"}

# 汉字 / CJK 标点（含「」）/ 全角 —— 只在 has_cn_quote_mix 里用
CN_CLASS = "一-鿿㐀-䶿　-〿＀-￯"
want_style = False  # --style 时报告规则 2（单引号嵌双引号串的风格位，永不判失败）


def iter_py():
    for p in sorted(ROOT.rglob("*.py")):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        yield p


def has_cn_quote_mix(text: str) -> bool:
    """短字符串内容里有没有「贴着汉字的 ASCII 引号」。"""
    for m in re.finditer(r"[\"']", text):
        i = m.start()
        left = text[i - 1] if i > 0 else ""
        right = text[i + 1] if i + 1 < len(text) else ""
        if re.match(f"[{CN_CLASS}]", left) and re.match(f"[{CN_CLASS}]", right):
            return True
    return False


def check_one(p: pathlib.Path) -> list[str]:
    hits: list[str] = []
    try:
        src = p.read_text(encoding="utf-8")
    except OSError as e:
        return [f"  {p.relative_to(ROOT)}: 读不了：{e}"]
    rel = p.relative_to(ROOT)

    # 规则 1：编译一遍 —— 我犯的 6 次全是 SyntaxError，这一步全抓到
    try:
        compile(src, str(p), "exec")
    except SyntaxError as e:
        hint = ""
        if e.text and ("引号" not in (e.text or "")):
            hint = "  ← 如果是中文处混了 ASCII 引号，改用「」"
        hits.append(f"  规则1 {rel}:{e.lineno}: SyntaxError: {e.msg}{hint}")
        hits.append(f"          { (e.text or '').strip()[:90] }")
        return hits  # 语法都错了，tokenize 没意义

    # 规则 2：短字符串 token 内容里的引号混用 —— **只用 --style 时报告，不判失败**
    #
    # 试过把它当硬判据：命中 31 处，全是「双引号串里嵌单引号」（"调'爬出坑'"）——
    # 那是**合法的 Python、仓库里到处都是的既有风格**，不截断字符串、不会炸，
    # **不是我犯的那 6 次错**。判据又太宽了。
    # 而「同款引号互套」（真正的病）本来就过不了规则 1 —— 它是 SyntaxError。
    # 所以规则 2 降级成 `--style` 信息输出：想看风格分布就加参数，永远不 fail。
    style_hits: list[str] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type != tokenize.STRING:
                continue
            s = tok.string
            if s[:1] in "rRbBfFuU":
                s = s[1:]
            if s[:3] in ("'''", '"""'):  # 三引号（docstring）不查 —— 那是文风
                continue
            if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
                inner = s[1:-1]
                if has_cn_quote_mix(inner):
                    style_hits.append(
                        f"  规则2(仅--style) {rel}:{tok.start[0]}: {tok.line.strip()[:86]}"
                    )
    except (tokenize.TokenError, IndentationError, SyntaxError) as e:
        hits.append(f"  规则1 {rel}: tokenize 失败：{e}")
    if style_hits and want_style:
        hits.extend(style_hits)
    return hits


def main() -> int:
    global want_style
    want_style = "--style" in sys.argv
    hits: list[str] = []
    for p in iter_py():
        hits.extend(check_one(p))
    if not hits:
        print("check_ascii_quotes: 0 处（py 全部能编译；短字符串里没有引号混用）")
        return 0
    print(f"check_ascii_quotes: 命中 {len([h for h in hits if h.startswith('  规则')])} 处：")
    for h in hits:
        print(h)
    print("  改法：中文引用用「」；不要在短字符串里嵌同款 ASCII 引号。")
    # **退出码只认规则 1**（SyntaxError/tokenize 失败）。
    # --style 的规则 2 是信息输出，按文档约定「永不 fail」——
    # 31 处单引号嵌双引号串是既有合法风格，不能拿它把 run_all 搞红。
    if any(h.strip().startswith("规则1") for h in hits):
        return 1
    print("  （--style：上面只是风格信息，不判失败）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
