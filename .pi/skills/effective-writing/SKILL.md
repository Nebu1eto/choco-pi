---
name: effective-writing
description: Draft or revise substantive user-facing prose artifacts such as documentation, reports, tickets, review comments, messages, and presentation copy; do not load for routine coding updates.
---

# Effective Writing

Use this skill when prose is the task's primary deliverable. Do not insert this checklist or internal drafting notes into the artifact.

## Frame the writing

Before drafting, identify purpose, audience, evidence boundary, claim type, output language, and target syntax. Missing evidence narrows the claim; never fill the gap with generalities.

## Evidence and claims

- Distinguish facts, interpretations, probabilities, and speculation. Claim strength follows evidence strength; one or two sources are never "consensus." Prefer named primary sources over unnamed experts.
- Every citation must support the exact adjacent claim. Never invent or approximate links, titles, authors, dates, or quotes.
- Do not assert causation beyond the evidence. Explain the mechanism behind causal claims and state material uncertainty. Never present worker reports, tool output, or unobserved behavior as verified fact.

## Language and style

- Use concrete facts, simple words, direct verbs, and natural paragraph flow. Write idiomatically; do not carry over another language's word order. Use established domain terms.
- Strip generic AI phrasing, inflated significance, decorative abstraction, and repeated summaries. Avoid theatrical negation and false suspense.

## Structure and medium

- Use headings only for real sections, lists only for parallel content, and tables only when clearer than prose. Use the platform's actual syntax; never invent fields.
- Every paragraph does one job: evidence, reasoning, mechanism, limitation, or implication. Order supporting material as claim, evidence, reasoning, limitation, then implication.
- Add a diagram only when structure carries information prose cannot. Expect one for an architecture description, a review report tracing a value through code, or an execution plan showing units and parallel work. Omit it when linear; use only renderer-supported types: `flowchart`/`graph`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`.

## English output

- Avoid generic model vocabulary and habitual metaphors such as "surface" or "contract." Name the actual limitation. Avoid teacher-mode openings, excess em dashes, and filler such as "I hope this helps."

## Japanese output

- 動作主体を主語にし、確立した専門用語を使う。受動的な結果列挙や曖昧な指示語は避ける。
- 一文一行、段落間は空行を入れる。コード・差分・ログはコードブロックに入れる。
- 一段落一話題とし、冒頭文で話題を示し、因果の主張には機序を示す。
- 見出しは説明的にする。未検証の例や挙動を検証済みのように書かない。

## Final audit

Before returning prose, remove unsupported significance, vague sourcing, inflated language, repetition, and tool artifacts. Verify citations and URLs. Re-read non-English prose without reference to the source language and fix literal translations. Confirm every paragraph adds information and the ending does not restate it.
