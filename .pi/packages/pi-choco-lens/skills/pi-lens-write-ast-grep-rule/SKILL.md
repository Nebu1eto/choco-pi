---
name: pi-lens-write-ast-grep-rule
description: Use when writing a new pi-lens ast-grep rule YAML file — covers schema, drop path, gotchas, and NAPI runner constraints
---

# Writing a pi-lens ast-grep Rule

Drop path: `rules/ast-grep-rules/rules/<id>.yml`  
Same `id` as a built-in overrides it. Multiple rules per file: separate with `---`.

## Minimal template

```yaml
id: no-foo-bar
language: TypeScript        # PascalCase — see languages below
severity: warning           # error | warning | info
message: "Avoid foo.bar() — use baz() instead"
note: |
  Longer explanation / fix guidance here.
rule:
  pattern: foo.bar($ARG)
```

## Language values

`TypeScript` `JavaScript` `Python` `Go` `Rust` `Java` `C` `Cpp` `CSharp` `Kotlin` `Ruby` `Php`

## Rule conditions

```yaml
rule:
  pattern: foo($X)          # ast-grep pattern — $X single, $$$ARGS multi
  kind: call_expression     # AST node kind (alternative to pattern)
  regex: "secret|token"     # regex on node text
  has:                      # descendant must match
    pattern: await $$$
  not:
    kind: comment
  any:
    - pattern: foo($X)
    - pattern: bar($X)
  all:
    - pattern: $OBJ.send($$$)
    - not: { kind: await_expression }
```

## Relational & constraint conditions — all supported (native napi, #206)

The runner matches every rule through napi's native engine (`root.findAll({rule,
constraints})`), fed by a faithful `js-yaml` parse. The **full ast-grep grammar works** —
nest freely; nothing is silently skipped:

```yaml
rule:
  kind: call_expression
  inside:                     # ancestor must match
    kind: function_declaration
    stopBy: end               # ↑ search ALL ancestors (default is direct parent)
  has:                        # descendant must match (default: DIRECT child)
    field: arguments          # field constraints work
  follows:                    # immediately-preceding sibling
    pattern: const $X = $V
constraints:                  # metavariable regex constraints work
  X:
    regex: "Error$"
```

⚠ **`has`/`inside` default to the immediate child/parent (`stopBy: neighbor`).** For a
recursive descendant/ancestor search add `stopBy: end`. This is the #1 migration
gotcha — see the `has` note in `reference.md`.

## YAML quoting — REQUIRED (js-yaml will reject the rule otherwise)

The parser is a real YAML parser, so unquoted special chars throw and the rule is
**silently dropped**:

```
❌ message: !!value to coerce boolean    # `!!` is a YAML tag → js-yaml THROWS, rule dropped
✅ message: "!!value to coerce boolean"
❌ message: foo: bar baz                  # bare `:` → parsed as a nested mapping
✅ message: "foo: bar baz"
   Quote any scalar starting with  ! & * ? | > % @ `  or containing  : #
   Quote keyword-like kinds:  kind: "true"   (bare `true` becomes a boolean → invalid kind)
```

## Gotchas

```
❌ Overly broad patterns — filtered out automatically
   $VAR  $NAME  $_  $X  $EXPR  (single bare metavar)

❌ PascalCase language is required
   language: typescript  →  language: TypeScript

❌ $VAR inside strings — matches literal "$VAR", not a metavar
   "from $PATH"  →  use tree-sitter or grep instead

✅ Test in playground: https://ast-grep.github.io/playground.html
✅ Schema + autocomplete: rules/ast-grep-rules/rule-schema.json
✅ Docs: docs/custom-rules.md
```

## Reference doc — read before writing a NAPI-runner-specific or hard-to-express rule

`reference.md` (same directory) covers: ReDoS-safe regex authoring, node-text
string-escape quirks, `has`/`inside` `stopBy` defaults (and when to override
them), the `-js` twin dedup behavior (#657), boolean-parameter matching
across the TS/JS grammars, and precision-over-recall heuristics for
denylist-shaped rules. Read it when a rule isn't matching (or over-matching)
the way you expect, or before shipping a `regex`/`has`-heavy rule.

## Validating a candidate rule against the REAL engine (not the warm MCP cache)

```

# inspect how a PATTERN parses → find the node kind you actually need

ast-grep run -p 'x = false' --lang ts --debug-query=cst file.ts

# match by kind (──kind and ──pattern are mutually exclusive in `run`)

ast-grep run --kind required_parameter --lang ts file.ts

# run ONE rule from an sgconfig against a sample

ast-grep scan -c <sgconfig.yml> --filter '^<id>$' sample.ts

# run the fixture harness for one rule

ast-grep test -c rules/ast-grep-rules/.sgconfig.yml --skip-snapshot-tests --filter '<id>'

```
