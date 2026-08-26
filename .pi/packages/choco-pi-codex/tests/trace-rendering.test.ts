import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { renderTraceAndOutput } from "../src/tools/code-mode/trace-rendering.ts";
import type { RuntimeToolTrace } from "../src/tools/code-mode/types.ts";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function renderCommand(
  cmd: string,
  options: { expanded?: boolean; status?: RuntimeToolTrace["status"]; error?: string } = {},
): string {
  const trace: RuntimeToolTrace = {
    id: "trace-1",
    name: "exec_command",
    input: { cmd },
    status: options.status ?? "done",
    error: options.error,
  };
  return renderTraceAndOutput(
    [trace],
    0,
    [],
    new Container(),
    false,
    { expanded: options.expanded ?? false, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "call-1", cwd: "/workspace" },
    new Map(),
  )
    .render(240)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("collapsed mise summaries parse value-taking global options before the subcommand", () => {
  const commands = [
    "mise -C packages/app run check",
    "mise --cd=packages/app run check",
    "mise -E test run check",
    "mise --env=test run check",
    "mise -j 2 run check",
    "mise --jobs=2 run check",
    "mise --output=quiet run check",
    "mise -C=packages/app run check",
    "mise -Cpackages/app run check",
    "mise -Etest run check",
    "mise -j2 run check",
    "mise -j=2 run check",
  ];
  for (const command of commands) {
    assert.match(renderCommand(command), /Ran Exec command · mise run check$/);
  }
});

test("collapsed mise summaries parse boolean global options before the subcommand", () => {
  const flags = [
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "-y",
    "--yes",
    "--raw",
    "--silent",
    "--no-config",
    "--no-env",
    "--no-hooks",
    "--locked",
  ];
  for (const flag of flags) {
    assert.match(renderCommand(`mise ${flag} install node`), /Ran Exec command · mise install$/);
  }
});

test("collapsed mise run summaries retain task aliases and omit task arguments", () => {
  assert.match(renderCommand("mise run check -- --fix"), /Ran Exec command · mise run check$/);
  assert.match(
    renderCommand("MISE_TRUSTED_CONFIG_PATHS=$PWD mise -C packages/app r build:miomock target"),
    /Ran Exec command · mise run build:miomock$/,
  );
});

test("collapsed mise run summaries retain every parallel task", () => {
  assert.match(
    renderCommand(
      "mise run -f --jobs 2 -n --affected --affected-explain --affected-json lint src ::: test --watch=false ::: check",
    ),
    /Ran Exec command · mise run lint, mise run test, mise run check$/,
  );
  assert.match(
    renderCommand(
      "mise r --output=quiet -C packages/app --affected-base HEAD~1 --affected-head=HEAD check --jobs 99",
    ),
    /Ran Exec command · mise run check$/,
  );
  assert.match(
    renderCommand("mise run -c -q -r -S --force --dry-run --continue-on-error lint ::: test"),
    /Ran Exec command · mise run lint, mise run test$/,
  );
  assert.match(
    renderCommand("mise run -C=packages/app -j2 -oquiet -ssh -tnode@24 check"),
    /Ran Exec command · mise run check$/,
  );
});

test("collapsed mise summaries canonicalize supported subcommands and aliases", () => {
  const commands = new Map([
    ["config", "config"],
    ["cfg", "config"],
    ["toml", "config"],
    ["install", "install"],
    ["i", "install"],
    ["tasks", "tasks"],
    ["t", "tasks"],
    ["task", "tasks"],
    ["use", "use"],
    ["u", "use"],
    ["ls", "ls"],
    ["list", "ls"],
    ["env", "env"],
    ["e", "env"],
    ["trust", "trust"],
    ["upgrade", "upgrade"],
    ["up", "upgrade"],
    ["watch", "watch"],
    ["w", "watch"],
    ["outdated", "outdated"],
    ["which", "which"],
    ["doctor", "doctor"],
    ["dr", "doctor"],
    ["generate", "generate"],
    ["gen", "generate"],
    ["g", "generate"],
  ]);
  for (const [command, summary] of commands) {
    assert.match(renderCommand(`mise ${command} argument`), new RegExp(`mise ${summary}$`));
  }
});

test("collapsed mise exec summaries support separators and shell command strings", () => {
  assert.match(renderCommand("mise exec -- pnpm --version"), /Ran Exec command · mise exec pnpm$/);
  assert.match(
    renderCommand("mise x node@24 -c 'node -v && python -V'"),
    /Ran Exec command · mise exec node$/,
  );
  assert.match(
    renderCommand("mise exec --command='APP_ENV=test pnpm test'"),
    /Ran Exec command · mise exec pnpm$/,
  );
  assert.match(
    renderCommand("mise exec -Etest -c='APP_ENV=test pnpm test'"),
    /Ran Exec command · mise exec pnpm$/,
  );
});

test("collapsed mise summaries compose with shell command chains", () => {
  assert.match(
    renderCommand("mise exec -- pnpm --version && mise tasks ls; git diff --check"),
    /Ran Exec command · mise exec pnpm, mise tasks, git diff$/,
  );
});

test("malformed and unknown mise forms retain the generic mise fallback", () => {
  assert.match(renderCommand("mise run"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run check :::"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise -C"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise --env= run check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise -j --raw run check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise -o quiet run check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise -qv install node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise -vv install node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise --unknown run check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run --jobs"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run --unknown check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run check ::: --output"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec -c"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec -o quiet -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec --output=quiet -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec --no-config -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec --no-env -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec --no-hooks -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run --no-env check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run --no-hooks check"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run lint ::: --jobs 2 test"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise exec --unknown -- node"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise frobnicate task"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise build"), /Ran Exec command · mise$/);
  assert.match(renderCommand("mise run ./scripts/foo.sh"), /Ran Exec command · mise$/);
});

test("non-mise command summaries retain the generic fallback", () => {
  assert.match(
    renderCommand("python3 scripts/check.py && git status --short"),
    /Ran Exec command · python3, git status$/,
  );
});

test("collapsed inline Node.js summaries omit heredoc source", () => {
  const command = `node --input-type=module <<'EOF'
import fs from "node:fs";
const files = [];
for (const file of files) {
  if (fs.existsSync(file)) console.log(file);
}
EOF`;

  assert.match(renderCommand(command), /Ran Exec command · node$/);
});

test("collapsed command summaries omit SQL heredoc bodies", () => {
  const command = `cat <<'SQLEOF' > /tmp/q.sql
\\pset pager off
-- top clients
WITH totals AS (SELECT client_id FROM widgets WHERE active GROUP BY client_id)
SELECT w.name_en FROM widgets w WHERE w.id IN (SELECT client_id FROM totals) GROUP BY w.name_en;
SQLEOF
set -a
. ./.env
set +a
export PGPASSWORD="$DB_PASS"
psql "$DATABASE_URL" -f /tmp/q.sql`;

  const summary = renderCommand(command);
  assert.match(summary, /Ran Exec command · cat, psql$/);
  for (const leakedToken of ["select", "from", "where", "group", "with", "--", "pset", "sqleof"]) {
    assert.doesNotMatch(summary.toLowerCase(), new RegExp(leakedToken));
  }
});

test("collapsed command summaries support quoted and bare heredoc delimiters", () => {
  for (const opening of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
    assert.match(
      renderCommand(`cat ${opening}\nbody command\nEOF\necho done`),
      /Ran Exec command · cat, echo$/,
    );
  }

  assert.match(
    renderCommand("cat <<-'EOF'\n\tbody command\n\tEOF\necho done"),
    /Ran Exec command · cat, echo$/,
  );
});

test("collapsed command summaries omit later and multiple heredoc bodies", () => {
  assert.match(
    renderCommand(`set -e && psql "$URL" <<'SQL'\nSELECT 1;\nSQL\necho done`),
    /Ran Exec command · psql, echo$/,
  );
  assert.match(
    renderCommand("cmd <<A <<B\nfirst body\nA\nsecond body\nB\necho done"),
    /Ran Exec command · cmd, echo$/,
  );
});

test("collapsed command summaries omit unterminated heredocs", () => {
  assert.match(
    renderCommand("cat <<EOF\nSELECT value FROM leaked_body\nwhere false"),
    /Ran Exec command · cat$/,
  );
});

test("collapsed command summaries distinguish heredocs from similar shell text", () => {
  assert.match(renderCommand('grep foo <<< "$var"'), /Ran Exec command · grep$/);
  assert.match(renderCommand('echo "a << b"'), /Ran Exec command · echo$/);
  assert.match(renderCommand("echo 'x <<EOF y'"), /Ran Exec command · echo$/);
});

test("mise failures stay visible and expanded rendering keeps the full command and error", () => {
  const cmd = "mise run check -- --fix";
  const collapsed = renderCommand(cmd, { status: "error", error: "task failed" });
  assert.match(collapsed, /Failed Exec command · mise run check$/);

  const expanded = renderCommand(cmd, {
    expanded: true,
    status: "error",
    error: "task failed",
  });
  assert.match(expanded, /Failed exec_command/);
  assert.match(expanded, /mise run check -- --fix/);
  assert.match(expanded, /task failed/);
});
