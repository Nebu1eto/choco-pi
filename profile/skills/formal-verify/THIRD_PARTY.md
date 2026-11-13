# Third-party code

## pstack `statechart`

`scripts/tlc-output.ts` ports the TLC output parsers from the `statechart` skill of pstack by Lauren Tan: `skills/statechart/scripts/frontends/messages.ts`, `frontends/verdict.ts`, `frontends/trace.ts`, `frontends/value.ts`, `parseState` from `frontends/dot.ts`, and the message codes and value type from `ir.ts`. The port rewrites them to this repository's rules; the file header lists the changes. The recorded outputs in `tests/fixtures/tlc/pstack/` are copied unchanged from pstack's test corpus.

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TLA+ tools

`tlc-setup.ts` downloads `tla2tools.jar` from the tlaplus project's GitHub releases at run time; it is not stored in this repository. The TLA+ tools are distributed under the MIT licence by their authors.
