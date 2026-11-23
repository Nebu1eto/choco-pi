import { isFiniteNumber, isString } from "./runtime-guards.ts";
import { createSubsystemLogger } from "./extension-log.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.ts";
import { detectFileRole } from "./file-role.ts";
import { findGlobalBinary } from "./package-manager.ts";
import { isMeasuredDuration, toMeasuredDurationMs } from "./run-duration.ts";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.ts";

export interface TestResult {
  file: string;
  sourceFile: string;
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  duration?: number;
  error?: string;
}

export interface TestFailure {
  name: string;
  message: string;
  location?: string;
  stack?: string;
}

export interface RunnerConfig {
  configFiles: string[];
  command: string;
  binName?: string;
  args: (testFile: string, cwd: string) => string[];
  parseJson: boolean;
}

const SOURCE_TO_TEST_PATTERNS: Array<{
  ext: string;
  testExts: string[];
  dirs: string[];
}> = [
  {
    ext: ".ts",
    testExts: [".test.ts", ".spec.ts"],
    dirs: ["__tests__", "tests", ".", "__tests__"],
  },
  {
    ext: ".tsx",
    testExts: [".test.tsx", ".spec.tsx"],
    dirs: ["__tests__", "tests", ".", "__tests__"],
  },
  {
    ext: ".js",
    testExts: [".test.js", ".spec.js"],
    dirs: ["__tests__", "tests", ".", "__tests__"],
  },
  {
    ext: ".jsx",
    testExts: [".test.jsx", ".spec.jsx"],
    dirs: ["__tests__", "tests", ".", "__tests__"],
  },
  {
    ext: ".py",
    testExts: ["test_*.py", "*_test.py"],
    dirs: ["tests", "test", ".", "."],
  },
  { ext: ".go", testExts: ["_test.go"], dirs: [".", ".", ".", "."] },
  { ext: ".rs", testExts: [".rs"], dirs: ["tests", "tests", "src", "."] },
  { ext: ".php", testExts: ["Test.php"], dirs: ["tests"] },
  { ext: ".ex", testExts: ["_test.exs"], dirs: ["test"] },
];

const MAX_NODE_MODULES_WALK_UP = 5;

const MAX_PYTEST_RECURSE_DEPTH = 3;

interface RUNNERSValues extends Record<string, RunnerConfig> {}
export const RUNNERS: RUNNERSValues = {
  vitest: {
    configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
    command: "npx",
    binName: "vitest",
    args: (testFile, _cwd) => ["vitest", "run", testFile, "--reporter=json", "--passWithNoTests"],
    parseJson: true,
  },
  jest: {
    configFiles: ["jest.config.ts", "jest.config.js", "jest.config.json", ".jestrc.js"],
    command: "npx",
    binName: "jest",
    args: (testFile, _cwd) => ["jest", testFile, "--json", "--passWithNoTests", "--forceExit"],
    parseJson: true,
  },
  pytest: {
    configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
    command: "python",
    args: (testFile, _cwd) => ["-m", "pytest", testFile, "--tb=short", "-q"],
    parseJson: false,
  },
  go: {
    configFiles: ["go.mod"],
    command: "go",
    args: (testFile, cwd) => {
      const relPath = path.relative(cwd, testFile);
      const pkgDir = path.dirname(relPath);
      return ["test", `-run`, ".", `./${pkgDir === "." ? "." : pkgDir}`];
    },
    parseJson: false,
  },
  cargo: {
    configFiles: ["Cargo.toml"],
    command: "cargo",
    args: (_testFile, _cwd) => ["test", "--no-fail-fast"],
    parseJson: false,
  },
  dotnet: {
    configFiles: ["*.csproj", "*.sln"],
    command: "dotnet",
    args: (_testFile, _cwd) => ["test", "--no-build"],
    parseJson: false,
  },
  gradle: {
    configFiles: ["build.gradle", "build.gradle.kts", "settings.gradle"],
    command: process.platform === "win32" ? "gradlew.bat" : "./gradlew",
    args: (_testFile, _cwd) => ["test", "--no-daemon"],
    parseJson: false,
  },
  maven: {
    configFiles: ["pom.xml"],
    command: "mvn",
    args: (_testFile, _cwd) => ["test", "-q"],
    parseJson: false,
  },
  rspec: {
    configFiles: [".rspec", "spec/spec_helper.rb"],
    command: "bundle",
    binName: "bundle",
    args: (testFile, _cwd) => ["exec", "rspec", testFile],
    parseJson: false,
  },
  minitest: {
    configFiles: ["Gemfile"],
    command: "ruby",
    args: (testFile, _cwd) => ["-Itest", testFile],
    parseJson: false,
  },
  phpunit: {
    configFiles: ["phpunit.xml", "phpunit.xml.dist", "composer.json"],
    command: "phpunit",
    args: (testFile, _cwd) => [testFile],
    parseJson: false,
  },
  mix: {
    configFiles: ["mix.exs"],
    command: "mix",
    args: (testFile, _cwd) => ["test", testFile],
    parseJson: false,
  },
};

export function stripWrapperArgs(binName: string, args: string[]): string[] {
  if (args[0] === binName) return args.slice(1);
  if (args[0] === "-m" && args[1] === binName) return args.slice(2);
  return args;
}

export class TestRunnerClient {
  private log: (msg: string) => void;
  private availableRunners: Map<string, boolean> = new Map();
  private failedTestsByRunner: Map<string, Set<string>> = new Map();
  private vitestTestGlobsCache: Map<string, { include?: string[]; exclude?: string[] } | null> =
    new Map();

  constructor(verbose = false) {
    this.log = verbose ? createSubsystemLogger("test-runner") : () => {};
  }

  detectRunner(
    cwd: string,
    sourceFilePath?: string,
  ): { runner: string; config: RunnerConfig } | null {
    for (const [name, config] of Object.entries(RUNNERS)) {
      const cacheKey = `${cwd}:${name}:config`;
      if (this.availableRunners.has(cacheKey)) {
        if (this.availableRunners.get(cacheKey)) {
          return { runner: name, config };
        }
        continue;
      }

      const found = config.configFiles.some((cf) => {
        if (name === "pytest" && cf === "pyproject.toml") {
          const pyprojectPath = path.join(cwd, cf);
          if (!fs.existsSync(pyprojectPath)) return false;
          try {
            const pyproject = fs.readFileSync(pyprojectPath, "utf-8");
            return pyproject.includes("[tool.pytest.ini_options]");
          } catch {
            return false;
          }
        }
        if (name === "phpunit" && cf === "composer.json") {
          const composerPath = path.join(cwd, cf);
          if (!fs.existsSync(composerPath)) return false;
          try {
            const composer = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
            const allDeps = {
              ...composer.require,
              ...composer["require-dev"],
            };
            return Boolean(allDeps["phpunit/phpunit"]);
          } catch {
            return false;
          }
        }
        return fs.existsSync(path.join(cwd, cf));
      });

      this.availableRunners.set(cacheKey, found);
      if (found) {
        this.log(`Detected runner via config: ${name}`);
        return { runner: name, config };
      }
    }

    const packageJsonPath = path.join(cwd, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      if (allDeps.vitest) {
        this.log("Detected vitest in package.json");
        this.availableRunners.set(`${cwd}:vitest:config`, true);
        return { runner: "vitest", config: RUNNERS.vitest };
      }
      if (allDeps.jest) {
        this.log("Detected jest in package.json");
        this.availableRunners.set(`${cwd}:jest:config`, true);
        return { runner: "jest", config: RUNNERS.jest };
      }
      if (allDeps.pytest || allDeps["pytest-cov"]) {
        this.log("Detected pytest in package.json (unusual)");
        this.availableRunners.set(`${cwd}:pytest:config`, true);
        return { runner: "pytest", config: RUNNERS.pytest };
      }
    } catch (err) {
      void err;
    }

    const hoistedVitest = this.findHoistedNodeModulesPackage(cwd, "vitest");
    if (hoistedVitest) {
      this.log(`Detected vitest in node_modules (${hoistedVitest})`);
      return { runner: "vitest", config: RUNNERS.vitest };
    }
    const hoistedJest = this.findHoistedNodeModulesPackage(cwd, "jest");
    if (hoistedJest) {
      this.log(`Detected jest in node_modules (${hoistedJest})`);
      return { runner: "jest", config: RUNNERS.jest };
    }

    for (const name of ["go", "cargo", "dotnet", "gradle", "maven"]) {
      const config = RUNNERS[name];
      const found = config.configFiles.some((cf) => {
        if (cf.includes("*")) {
          try {
            const files = fs.readdirSync(cwd);
            return files.some((f) => new RegExp(cf.replace(/\*/g, ".*")).test(f));
          } catch {
            return false;
          }
        }
        return fs.existsSync(path.join(cwd, cf));
      });
      if (found) {
        this.log(`Detected ${name} from config file`);
        return { runner: name, config };
      }
    }

    const isPythonSource = isString(sourceFilePath) && sourceFilePath.endsWith(".py");
    if (!isPythonSource) return null;

    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const result = safeSpawn(whichCmd, ["pytest"], {
        timeout: 2000,
      });
      if (result.status === 0) {
        this.log("Detected pytest globally");
        return { runner: "pytest", config: RUNNERS.pytest };
      }
    } catch (err) {
      void err;
    }

    return null;
  }

  private findHoistedNodeModulesPackage(cwd: string, packageName: string): string | null {
    let dir = path.resolve(cwd);
    for (let level = 0; level <= MAX_NODE_MODULES_WALK_UP; level++) {
      const nodeModulesPath = path.join(dir, "node_modules");
      if (fs.existsSync(path.join(nodeModulesPath, packageName))) {
        return nodeModulesPath;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private findPytestMatchRecursive(
    rootDir: string,
    pattern: string,
    basename: string,
    maxDepth: number,
  ): string | null {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;

      let entries: import("node:fs").Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          if (
            entry.name === pattern ||
            (entry.name.startsWith("test_") &&
              entry.name.endsWith(".py") &&
              entry.name.includes(basename))
          ) {
            return fullPath;
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
          queue.push({ dir: fullPath, depth: depth + 1 });
        }
      }
    }

    return null;
  }

  private relativeSourceDir(sourceFilePath: string, cwd: string): string | null {
    const dir = path.dirname(sourceFilePath);
    const relDir = path.relative(cwd, path.resolve(cwd, dir));
    if (!relDir || relDir === "." || relDir.startsWith("..") || path.isAbsolute(relDir)) {
      return null;
    }
    return relDir;
  }

  parseVitestTestGlobs(cwd: string): { include?: string[]; exclude?: string[] } | null {
    if (this.vitestTestGlobsCache.has(cwd)) {
      return this.vitestTestGlobsCache.get(cwd) ?? null;
    }

    const candidates = [...RUNNERS.vitest.configFiles, "vitest.config.mts"];

    let content: string | null = null;
    for (const cf of candidates) {
      try {
        content = fs.readFileSync(path.join(cwd, cf), "utf-8");
        break;
      } catch {
        continue;
      }
    }

    let result: { include?: string[]; exclude?: string[] } | null = null;
    if (content !== null) {
      const include = this.extractGlobArrayLiteral(content, "include");
      const exclude = this.extractGlobArrayLiteral(content, "exclude");
      if (include || exclude) {
        result = {};
        if (include) result.include = include;
        if (exclude) result.exclude = exclude;
      }
    }

    this.vitestTestGlobsCache.set(cwd, result);
    return result;
  }

  private extractGlobArrayLiteral(content: string, key: string): string[] | undefined {
    const arrayMatch = content.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
    if (!arrayMatch) return undefined;

    const body = arrayMatch[1];
    const literalPattern = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g;
    const literals: string[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = literalPattern.exec(body)) !== null) {
      const between = body.slice(lastEnd, match.index).trim();
      if (between !== "" && !/^,$/.test(between)) return undefined;
      literals.push(match[1] ?? match[2] ?? match[3] ?? "");
      lastEnd = literalPattern.lastIndex;
    }
    const trailing = body.slice(lastEnd).trim();
    if (trailing !== "" && trailing !== ",") return undefined;

    return literals.length > 0 ? literals : undefined;
  }

  private isTestFile(sourceFilePath: string, cwd: string, runner: string): boolean {
    let result = detectFileRole(sourceFilePath) === "test";

    if (runner === "vitest") {
      const globs = this.parseVitestTestGlobs(cwd);
      if (globs) {
        const rel = path.relative(cwd, path.resolve(cwd, sourceFilePath)).replace(/\\/g, "/");
        const matches = (globs_: string[] | undefined, filter?: (g: string) => boolean) =>
          !!globs_?.some((g) => (!filter || filter(g)) && minimatch(rel, g, { dot: true }));

        if (matches(globs.exclude)) {
          result = false;
        } else if (!result && matches(globs.include, (g) => this.isNarrowTestGlob(g))) {
          result = true;
        }
      }
    }

    return result;
  }

  private isNarrowTestGlob(glob: string): boolean {
    const testDirPattern = /^(tests?|specs?|__tests__)$/i;
    for (const segment of glob.split("/")) {
      if (segment.includes("*") || segment.includes("?")) break;
      if (testDirPattern.test(segment)) return true;
    }

    const lastWildcard = Math.max(glob.lastIndexOf("*"), glob.lastIndexOf("?"));
    const suffix = lastWildcard >= 0 ? glob.slice(lastWildcard + 1) : glob;
    const dotSegments = suffix.split(".").filter(Boolean);
    return dotSegments.length >= 2;
  }

  findTestFile(
    sourceFilePath: string,
    cwd: string,
    runnerOverride?: string,
  ): { testFile: string; runner: string } | null {
    const ext = path.extname(sourceFilePath);
    const basename = path.basename(sourceFilePath, ext);
    const dir = path.dirname(sourceFilePath);
    const patterns = SOURCE_TO_TEST_PATTERNS.find((p) => p.ext === ext);
    if (!patterns) return null;

    const detected = runnerOverride
      ? { runner: runnerOverride, config: RUNNERS[runnerOverride] }
      : this.detectRunner(cwd, sourceFilePath);
    if (!detected) return null;

    const relDir = this.relativeSourceDir(sourceFilePath, cwd);

    for (let i = 0; i < patterns.testExts.length; i++) {
      const testExt = patterns.testExts[i];
      const testDir = patterns.dirs[i];

      if (testExt.includes("*")) {
        const pattern = testExt.replace(/\*/g, basename);
        const searchDirs =
          testDir === "."
            ? [dir]
            : relDir
              ? [path.join(cwd, testDir, relDir), path.join(cwd, testDir)]
              : [path.join(cwd, testDir)];

        for (const searchDir of searchDirs) {
          let files;
          try {
            files = fs.readdirSync(searchDir);
          } catch (err) {
            void err;
            continue;
          }

          const match = files.find(
            (f) =>
              f === pattern || (f.startsWith("test_") && f.endsWith(".py") && f.includes(basename)),
          );
          if (match) {
            const testPath = path.join(searchDir, match);
            this.log(`Found test file: ${testPath}`);
            return { testFile: testPath, runner: detected.runner };
          }
        }

        if (testDir !== ".") {
          const recursiveMatch = this.findPytestMatchRecursive(
            path.join(cwd, testDir),
            pattern,
            basename,
            MAX_PYTEST_RECURSE_DEPTH,
          );
          if (recursiveMatch) {
            this.log(`Found test file (recursive): ${recursiveMatch}`);
            return { testFile: recursiveMatch, runner: detected.runner };
          }
        }
      } else {
        const testFilename = basename + testExt;
        const searchPaths = [
          path.join(dir, testFilename),
          path.join(dir, "__tests__", testFilename),
          ...(relDir
            ? [
                path.join(cwd, "tests", relDir, testFilename),
                path.join(cwd, "__tests__", relDir, testFilename),
              ]
            : []),
          path.join(cwd, "tests", testFilename),
          path.join(cwd, "__tests__", testFilename),
          ...this.sourceRootMirroredCandidates(dir, cwd, testDir, testFilename),
        ];

        for (const testPath of searchPaths) {
          if (fs.existsSync(testPath)) {
            this.log(`Found test file: ${testPath}`);
            return { testFile: testPath, runner: detected.runner };
          }
        }
      }
    }

    const importMatch = this.findTestFileByImport(sourceFilePath, cwd);
    if (importMatch) {
      return { testFile: importMatch, runner: detected.runner };
    }

    return null;
  }

  getTestRunTarget(
    sourceFilePath: string,
    cwd: string,
  ): {
    testFile: string;
    runner: string;
    config: RunnerConfig;
    strategy: "failed-first" | "related" | "self";
  } | null {
    const detected = this.detectRunner(cwd, sourceFilePath);
    if (!detected) return null;

    const key = this.failedKey(cwd, detected.runner);
    const failedSet = this.failedTestsByRunner.get(key);

    const selfIsTest = this.isTestFile(sourceFilePath, cwd, detected.runner);
    const related = selfIsTest ? null : this.findTestFile(sourceFilePath, cwd, detected.runner);

    if (failedSet && failedSet.size > 0) {
      if (related) {
        const relatedAbs = path.resolve(related.testFile);
        if (failedSet.has(relatedAbs)) {
          return {
            testFile: relatedAbs,
            runner: detected.runner,
            config: detected.config,
            strategy: "failed-first",
          };
        }
      }

      if (selfIsTest) {
        const selfAbs = path.resolve(sourceFilePath);
        if (failedSet.has(selfAbs)) {
          return {
            testFile: selfAbs,
            runner: detected.runner,
            config: detected.config,
            strategy: "failed-first",
          };
        }
      }

      return {
        testFile: [...failedSet][0],
        runner: detected.runner,
        config: detected.config,
        strategy: "failed-first",
      };
    }

    if (selfIsTest) {
      return {
        testFile: path.resolve(sourceFilePath),
        runner: detected.runner,
        config: detected.config,
        strategy: "self",
      };
    }

    if (!related) return null;

    return {
      testFile: path.resolve(related.testFile),
      runner: detected.runner,
      config: detected.config,
      strategy: "related",
    };
  }

  async runTestFileAsync(
    testFile: string,
    cwd: string,
    runner: string,
    config: RunnerConfig,
  ): Promise<TestResult> {
    const absoluteTestFile = path.resolve(testFile);
    if (!fs.existsSync(absoluteTestFile)) {
      return this.emptyResult(absoluteTestFile, "", runner, "Test file not found");
    }

    try {
      const { command, args } = await this.resolveExec(runner, config, absoluteTestFile, cwd);
      this.log(`Running (async): ${command} ${args.join(" ")}`);

      const result = await safeSpawnAsync(command, args, {
        cwd,
        timeout: 60000,
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";

      if (result.error) {
        this.log(`Runner error: ${result.error.message}`);
        return this.emptyResult(
          absoluteTestFile,
          "",
          runner,
          `Runner error: ${result.error.message}`,
        );
      }

      let parsed: TestResult;
      switch (runner) {
        case "vitest":
          parsed = this.parseVitestOutput(stdout, stderr, absoluteTestFile, cwd, runner);
          break;
        case "jest":
          parsed = this.parseJestOutput(stdout, stderr, absoluteTestFile, cwd, runner);
          break;
        case "pytest":
          parsed = this.parsePytestOutput(
            stdout,
            stderr,
            result.status ?? 0,
            absoluteTestFile,
            cwd,
            runner,
          );
          break;
        case "phpunit":
          parsed = this.parsePhpunitOutput(
            stdout,
            stderr,
            result.status ?? 0,
            absoluteTestFile,
            runner,
          );
          break;
        case "mix":
          parsed = this.parseMixTestOutput(
            stdout,
            stderr,
            result.status ?? 0,
            absoluteTestFile,
            runner,
          );
          break;
        default:
          parsed = this.parseGenericRunnerOutput(
            stdout,
            stderr,
            result.status ?? 0,
            absoluteTestFile,
            runner,
          );
          break;
      }

      this.recordResult(cwd, runner, absoluteTestFile, parsed);
      return parsed;
    } catch (err: any) {
      this.log(`Run error: ${err.message}`);
      return this.emptyResult(absoluteTestFile, "", runner, err.message);
    }
  }

  hasTestFile(sourceFilePath: string, cwd: string): boolean {
    return this.findTestFile(sourceFilePath, cwd) !== null;
  }

  suggestTestFiles(
    sourceFiles: string[],
    cwd: string,
  ): Array<{ testFile: string; sourceFile: string; runner: string }> {
    const seen = new Set<string>();
    const results: Array<{
      testFile: string;
      sourceFile: string;
      runner: string;
    }> = [];
    for (const sourceFile of sourceFiles) {
      const found = this.findTestFile(sourceFile, cwd);
      if (!found) continue;
      const abs = path.resolve(found.testFile);
      if (seen.has(abs)) continue;
      seen.add(abs);
      results.push({ testFile: abs, sourceFile, runner: found.runner });
    }
    return results;
  }

  private parseJsonTestOutput(
    stdout: string,
    stderr: string,
    testFile: string,
    cwd: string,
    runner: string,
  ): TestResult {
    interface JsonResult {
      numPassedTests: number;
      numFailedTests: number;
      numSkippedTests?: number;
      numPendingTests?: number;
      numTodoTests?: number;
      testResults?: Array<{
        name: string;
        status: string;
        message?: string;
        startTime?: number;
        endTime?: number;
        assertionResults?: Array<{
          status: string;
          title: string;
          duration?: number | null;
          failureMessages?: string[];
          location?: { line: number; column: number };
        }>;
      }>;
    }

    try {
      const json: JsonResult = JSON.parse(stdout);
      const failures: TestFailure[] = [];

      for (const suite of json.testResults || []) {
        if (suite.status === "failed" && suite.assertionResults) {
          for (const test of suite.assertionResults) {
            if (test.status === "failed") {
              failures.push({
                name: test.title,
                message: test.failureMessages?.[0] || suite.message || "Test failed",
                location: test.location
                  ? `${path.relative(cwd, testFile)}:${test.location.line}`
                  : undefined,
                stack: this.truncateStack(test.failureMessages?.join("\n")),
              });
            }
          }
        }
      }

      return {
        file: testFile,
        sourceFile: "",
        runner,
        passed: json.numPassedTests || 0,
        failed: json.numFailedTests || 0,
        skipped: Math.max(
          json.numSkippedTests ?? 0,
          (json.numPendingTests || 0) + (json.numTodoTests || 0),
        ),
        failures,
        duration: this.jsonRunDurationMs(json.testResults),
      };
    } catch (err) {
      void err;
      const failed = stdout.includes("FAIL") || stderr.includes("FAIL");
      return this.emptyResult(
        testFile,
        "",
        runner,
        failed ? "Tests failed (could not parse output)" : undefined,
      );
    }
  }

  private jsonRunDurationMs(
    suites:
      | Array<{
          startTime?: number;
          endTime?: number;
          assertionResults?: Array<{ duration?: number | null }>;
        }>
      | undefined,
  ): number | undefined {
    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;
    let assertionTotal = 0;
    for (const suite of suites || []) {
      if (
        isFiniteNumber(suite.startTime) &&
        Number.isFinite(suite.startTime) &&
        isFiniteNumber(suite.endTime) &&
        Number.isFinite(suite.endTime)
      ) {
        minStart = Math.min(minStart, suite.startTime);
        maxEnd = Math.max(maxEnd, suite.endTime);
      }
      for (const assertion of suite.assertionResults || []) {
        if (
          isFiniteNumber(assertion.duration) &&
          Number.isFinite(assertion.duration) &&
          assertion.duration > 0
        ) {
          assertionTotal += assertion.duration;
        }
      }
    }
    const span = maxEnd - minStart;
    if (Number.isFinite(span) && span > 0) return Math.round(span);
    if (assertionTotal > 0) return Math.round(assertionTotal);
    if (Number.isFinite(span) && span === 0) return 0;
    return undefined;
  }

  private parseVitestOutput(
    stdout: string,
    stderr: string,
    testFile: string,
    cwd: string,
    runner: string,
  ): TestResult {
    return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
  }

  private parseJestOutput(
    stdout: string,
    stderr: string,
    testFile: string,
    cwd: string,
    runner: string,
  ): TestResult {
    return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
  }

  private parsePytestOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    testFile: string,
    _cwd: string,
    runner: string,
  ): TestResult {
    const failures: TestFailure[] = [];
    const output = `${stdout}\n${stderr}`;

    const summaryMatch =
      output.match(/(\d+)\s+passed?.*?(\d+)\s+failed.*?in\s+([\d.]+)s/i) ||
      output.match(/(\d+)\s+passed.*?in\s+([\d.]+)s/i);

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let duration: number | undefined;

    if (summaryMatch) {
      const passedMatch = output.match(/(\d+)\s+passed/);
      const failedMatch = output.match(/(\d+)\s+failed/);
      const skippedMatch = output.match(/(\d+)\s+skipped/);
      const durationMatch = output.match(/in\s+([\d.]+)s/);

      passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
      failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
      skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
      if (durationMatch) duration = Math.round(parseFloat(durationMatch[1]) * 1000);
    }

    const failureRegex = /FAILED\s+(\S+::\S+)\s*-\s*(.+?)(?:\n|$)/g;
    let match;
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({
        name: match[1],
        message: match[2].trim().slice(0, 500),
        location: match[1].replace("::", ":"),
      });
    }

    const tracebackRegex = /_{10,}\s*\n\s*(\w+Error:\s*.+?)(?:\n|$)/gs;
    while ((match = tracebackRegex.exec(output)) !== null) {
      if (failures.length > 0 && !failures[failures.length - 1].stack) {
        failures[failures.length - 1].stack = match[1].trim().slice(0, 1000);
      }
    }

    return {
      file: testFile,
      sourceFile: "",
      runner,
      passed,
      failed,
      skipped,
      failures,
      duration,
      error: exitCode === 2 ? "Pytest configuration error" : undefined,
    };
  }

  private parsePhpunitOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    testFile: string,
    runner: string,
  ): TestResult {
    const output = `${stdout}\n${stderr}`;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const okMatch = output.match(/OK\s*\((\d+)\s+tests?,\s*\d+\s+assertions?\)/i);
    if (okMatch) {
      passed = Number.parseInt(okMatch[1], 10);
    } else {
      const testsMatch = output.match(/Tests:\s*(\d+)/i);
      const failuresMatch = output.match(/Failures:\s*(\d+)/i);
      const errorsMatch = output.match(/Errors:\s*(\d+)/i);
      const skippedMatch = output.match(/Skipped:\s*(\d+)/i);

      const total = testsMatch ? Number.parseInt(testsMatch[1], 10) : 0;
      const failures = failuresMatch ? Number.parseInt(failuresMatch[1], 10) : 0;
      const errors = errorsMatch ? Number.parseInt(errorsMatch[1], 10) : 0;
      skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
      failed = failures + errors;
      passed = Math.max(0, total - failed - skipped);
    }

    const failures: TestFailure[] = [];
    const failureRegex = /^\d+\)\s+(\S+)/gm;
    let match;
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({ name: match[1], message: match[1] });
    }

    let duration: number | undefined;
    const clockMatch = output.match(/^Time:\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/im);
    if (clockMatch) {
      const hours = clockMatch[1] ? Number.parseInt(clockMatch[1], 10) : 0;
      const minutes = Number.parseInt(clockMatch[2], 10);
      const seconds = Number.parseInt(clockMatch[3], 10);
      const millis = clockMatch[4] ? Number.parseInt(clockMatch[4].padEnd(3, "0"), 10) : 0;
      duration = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
    } else {
      const legacyMatch = output.match(
        /^Time:\s*([\d.]+)\s*(seconds?|s|ms|milliseconds?|minutes?)\b/im,
      );
      if (legacyMatch) {
        const value = Number.parseFloat(legacyMatch[1]);
        const unit = legacyMatch[2].toLowerCase();
        const scale =
          unit.startsWith("ms") || unit.startsWith("milli")
            ? 1
            : unit.startsWith("min")
              ? 60_000
              : 1000;
        if (Number.isFinite(value) && value > 0) {
          duration = Math.round(value * scale);
        }
      }
    }

    return {
      file: testFile,
      sourceFile: "",
      runner,
      passed,
      failed,
      skipped,
      failures,
      duration,
      error: exitCode !== 0 && passed === 0 && failed === 0 ? "PHPUnit runner error" : undefined,
    };
  }

  private parseMixTestOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    testFile: string,
    runner: string,
  ): TestResult {
    const output = `${stdout}\n${stderr}`;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let duration: number | undefined;

    const summaryMatch = output.match(
      /(\d+)\s+tests?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+excluded)?(?:,\s*(\d+)\s+skipped)?/i,
    );
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1], 10);
      failed = Number.parseInt(summaryMatch[2], 10);
      const excluded = summaryMatch[3] ? Number.parseInt(summaryMatch[3], 10) : 0;
      const skippedCount = summaryMatch[4] ? Number.parseInt(summaryMatch[4], 10) : 0;
      skipped = excluded + skippedCount;
      passed = Math.max(0, total - failed - skipped);
    }

    const durationMatch = output.match(/Finished in\s+([\d.]+)\s+seconds?/i);
    if (durationMatch) {
      duration = Math.round(Number.parseFloat(durationMatch[1]) * 1000);
    }

    const failures: TestFailure[] = [];
    const failureRegex = /^\s*\d+\)\s+(.+?)\s*\(([^)]+)\)\s*$/gm;
    let match;
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({
        name: match[1].trim(),
        message: match[1].trim(),
        location: match[2].trim(),
      });
    }

    return {
      file: testFile,
      sourceFile: "",
      runner,
      passed,
      failed,
      skipped,
      failures,
      duration,
      error: exitCode !== 0 && passed === 0 && failed === 0 ? "mix test runner error" : undefined,
    };
  }

  private parseGenericRunnerDuration(output: string, runner: string): number | undefined {
    switch (runner) {
      case "go":
        return this.parseGoDuration(output);
      case "cargo":
        return this.parseCargoDuration(output);
      case "dotnet":
        return this.parseDotnetDuration(output);
      case "maven":
        return this.parseMavenDuration(output);
      case "rspec":
        return this.parseRspecDuration(output);
      case "minitest":
        return this.parseMinitestDuration(output);
      default:
        return undefined;
    }
  }

  private parseGoDuration(output: string): number | undefined {
    const goSummary = output.match(/ok\s+\S+\s+([\d.]+)s/m);
    if (!goSummary) return undefined;
    return toMeasuredDurationMs(Number.parseFloat(goSummary[1]) * 1000);
  }

  private parseCargoDuration(output: string): number | undefined {
    const cargoTime = output.match(/^test result:.*?;\s*finished in\s+([\d.]+)\s*s\b/im);
    if (!cargoTime) return undefined;
    return toMeasuredDurationMs(Number.parseFloat(cargoTime[1]) * 1000);
  }

  private parseDotnetDuration(output: string): number | undefined {
    const dotnetTime = output.match(
      /Failed:\s*\d+,\s*Passed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*\d+,\s*Duration:\s*([^\r\n-]+)/i,
    );
    if (!dotnetTime) return undefined;
    if (/^\s*</.test(dotnetTime[1])) return 0;
    let total = 0;
    let tokens = 0;

    interface UnitsValues extends Record<string, number> {}
    const units: UnitsValues = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };
    for (const token of dotnetTime[1].matchAll(/([\d.]+)\s*(ms|h|m|s)\b/gi)) {
      total += Number.parseFloat(token[1]) * units[token[2].toLowerCase()];
      tokens++;
    }
    if (tokens === 0) return undefined;
    return toMeasuredDurationMs(total);
  }

  private parseMavenDuration(output: string): number | undefined {
    let surefireTotal = 0;
    let matched = false;
    for (const line of output.matchAll(
      /^.*Tests run:\s*\d+,.*?Time elapsed:\s*([\d.]+)\s*(?:s|sec|secs|seconds)\b.*$/gim,
    )) {
      const seconds = Number.parseFloat(line[1]);
      if (!Number.isFinite(seconds) || seconds < 0) continue;
      surefireTotal += seconds;
      matched = true;
    }
    if (!matched) return undefined;
    return toMeasuredDurationMs(surefireTotal * 1000);
  }

  private parseRspecDuration(output: string): number | undefined {
    const rspecTime = output.match(
      /^Finished in\s+(?:([\d.]+)\s+minutes?\s+)?([\d.]+)\s+seconds?/im,
    );
    if (!rspecTime) return undefined;
    const minutes = rspecTime[1] ? Number.parseFloat(rspecTime[1]) : 0;
    return toMeasuredDurationMs(minutes * 60_000 + Number.parseFloat(rspecTime[2]) * 1000);
  }

  private parseMinitestDuration(output: string): number | undefined {
    const minitestTime = output.match(/^Finished in\s+([\d.]+)s\s*,/im);
    if (!minitestTime) return undefined;
    return toMeasuredDurationMs(Number.parseFloat(minitestTime[1]) * 1000);
  }

  private parseGenericRunnerOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    testFile: string,
    runner: string,
  ): TestResult {
    const output = `${stdout}\n${stderr}`;
    const lower = output.toLowerCase();

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let matched = false;
    const duration = this.parseGenericRunnerDuration(output, runner);

    const cargoSummary = output.match(
      /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;/i,
    );
    if (cargoSummary) {
      passed = Number.parseInt(cargoSummary[1], 10);
      failed = Number.parseInt(cargoSummary[2], 10);
      skipped = Number.parseInt(cargoSummary[3], 10);
      matched = true;
    }

    const dotnetSummary = output.match(/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/i);
    if (dotnetSummary) {
      failed = Number.parseInt(dotnetSummary[1], 10);
      passed = Number.parseInt(dotnetSummary[2], 10);
      skipped = Number.parseInt(dotnetSummary[3], 10);
      matched = true;
    }

    const mavenLines = [
      ...output.matchAll(
        /^.*?Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+).*$/gim,
      ),
    ];
    const mavenAggregates = mavenLines.filter((line) => !/Time elapsed:/i.test(line[0]));
    const mavenScored = mavenAggregates.length > 0 ? mavenAggregates : mavenLines;
    if (mavenScored.length > 0) {
      let total = 0;
      let mavenFailed = 0;
      let mavenSkipped = 0;
      for (const line of mavenScored) {
        total += Number.parseInt(line[1], 10);
        mavenFailed += Number.parseInt(line[2], 10) + Number.parseInt(line[3], 10);
        mavenSkipped += Number.parseInt(line[4], 10);
      }
      failed = mavenFailed;
      skipped = mavenSkipped;
      passed = Math.max(0, total - failed - skipped);
      matched = true;
    }

    const rspecSummary = output.match(/(\d+)\s+examples?,\s+(\d+)\s+failures?/i);
    if (rspecSummary) {
      const total = Number.parseInt(rspecSummary[1], 10);
      failed = Number.parseInt(rspecSummary[2], 10);
      passed = Math.max(0, total - failed);
      matched = true;
    }

    const minitestSummary = output.match(
      /(\d+)\s+runs?,\s+\d+\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?/i,
    );
    if (minitestSummary) {
      const total = Number.parseInt(minitestSummary[1], 10);
      const failures = Number.parseInt(minitestSummary[2], 10);
      const errors = Number.parseInt(minitestSummary[3], 10);
      failed = failures + errors;
      passed = Math.max(0, total - failed);
      matched = true;
    }

    const gradleSummary = output.match(/(\d+)\s+tests? completed,\s+(\d+)\s+failed/i);
    if (gradleSummary) {
      const total = Number.parseInt(gradleSummary[1], 10);
      failed = Number.parseInt(gradleSummary[2], 10);
      passed = Math.max(0, total - failed);
      matched = true;
    }

    const goFailNames = [...output.matchAll(/--- FAIL:[^\S\n]+([^\s(]+)/g)];
    const goFailNameSet = new Set(goFailNames.map((m) => m[1].trim()));
    const goTopLevelFailCount = goFailNames.filter((m) => {
      const name = m[1].trim();
      const slash = name.indexOf("/");
      return slash === -1 || !goFailNameSet.has(name.slice(0, slash));
    }).length;
    if (runner === "go") {
      const goFailPackage = /^FAIL(?![^\n]*\[(?:build|setup) failed\])[^\S\n]+\S+/m.test(output);
      const goOkPackages = [...output.matchAll(/^ok[^\S\n]+\S+[^\S\n]+[\d.]+s/gm)];
      if (goFailNames.length > 0 || goFailPackage) {
        failed = Math.max(failed, goTopLevelFailCount || 1);
        matched = true;
      }
      if (goOkPackages.length > 0) {
        passed = Math.max(passed, goOkPackages.length);
        matched = true;
      }
    }

    const failures: TestFailure[] = [];
    for (const m of goFailNames.slice(0, 5)) {
      failures.push({ name: m[1].trim(), message: m[1].trim() });
    }
    const otherNames = [
      ...output.matchAll(/^[^\S\n]*FAILED[^\S\n]+(\S.*)$/gm),
      ...output.matchAll(/^[^\S\n]*Failure:[^\S\n]+(\S.*)$/gm),
    ];
    for (const m of otherNames) {
      if (failures.length >= 5) break;
      failures.push({ name: m[1].trim(), message: m[1].trim() });
    }

    const runnerError =
      exitCode !== 0 && !matched && goFailNames.length === 0 && lower.includes("error")
        ? `Runner ${runner} exited with ${exitCode}`
        : undefined;

    if (runnerError) {
      failures.length = 0;
    }

    if (exitCode !== 0 && failed === 0 && !runnerError) {
      failed = 1;
    }

    if (passed === 0 && failed === 0 && skipped === 0 && exitCode === 0) {
      passed = 1;
    }

    if (failures.length === 0 && failed > 0) {
      const firstLine =
        output
          .split("\n")
          .find((l) => /fail|error|exception/i.test(l))
          ?.trim()
          .slice(0, 300) || `Tests failed for runner ${runner}`;
      failures.push({ name: `${runner} failure`, message: firstLine });
    }

    this.log(
      runnerError
        ? `Generic runner ${runner}: never started (${runnerError})`
        : `Generic runner ${runner}: ran (matched=${matched}, passed=${passed}, failed=${failed}, failures=${failures.length})`,
    );

    return {
      file: testFile,
      sourceFile: "",
      runner,
      passed,
      failed,
      skipped,
      failures,
      duration,
      error: runnerError,
    };
  }

  formatResult(result: TestResult): string {
    if (result.error && result.passed === 0 && result.failed === 0) {
      return `[Tests] ⚠ Could not run tests: ${result.error}`;
    }

    const total = result.passed + result.failed + result.skipped;
    if (total === 0) {
      return "";
    }

    const durationStr =
      isMeasuredDuration(result.duration) && result.duration > 0
        ? ` (${(result.duration / 1000).toFixed(2)}s)`
        : "";

    if (result.failed === 0) {
      return `[Tests] ✓ ${result.passed}/${total} passed${durationStr} — ${result.runner}`;
    }

    let output = `[Tests] ✗ ${result.failed}/${total} failed, ${result.passed} passed${durationStr} — ${result.runner}\n`;

    for (const failure of result.failures.slice(0, 5)) {
      output += `  ✗ ${failure.name}\n`;
      const msg = failure.message.split("\n")[0].slice(0, 200);
      output += `    ${msg}\n`;
      if (failure.location) {
        output += `    at ${failure.location}\n`;
      }
    }

    if (result.failures.length > 5) {
      output += `  ... and ${result.failures.length - 5} more failure(s)\n`;
    }

    output += `  → Fix failing tests before proceeding\n`;

    return output.trimEnd();
  }

  private sourceRootMirroredCandidates(
    dir: string,
    cwd: string,
    testDir: string,
    testFilename: string,
  ): string[] {
    const knownSourceRoots = new Set(["src", "lib", "app"]);
    const relDir = path.relative(cwd, dir);
    const segments = relDir.split(path.sep).filter(Boolean);
    if (segments.length > 1 && knownSourceRoots.has(segments[0])) {
      return [path.join(cwd, testDir, ...segments.slice(1), testFilename)];
    }
    return [];
  }

  private findTestFileByImport(sourceFilePath: string, cwd: string): string | null {
    const ext = path.extname(sourceFilePath);
    const basename = path.basename(sourceFilePath, ext);
    const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

    const searchDirs = [
      path.join(cwd, "tests"),
      path.join(cwd, "__tests__"),
      path.dirname(sourceFilePath),
    ];

    for (const dir of searchDirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!testPattern.test(entry)) continue;
        const testPath = path.join(dir, entry);
        let content: string;
        try {
          content = fs.readFileSync(testPath, "utf-8");
        } catch {
          continue;
        }
        if (
          content.includes(`/${basename}"`) ||
          content.includes(`/${basename}'`) ||
          content.includes(`/${basename}.`) ||
          content.includes(`"${basename}"`) ||
          content.includes(`'${basename}'`)
        ) {
          this.log(`Found test file via import scan: ${testPath}`);
          return testPath;
        }
      }
    }
    return null;
  }

  private async resolveExec(
    runner: string,
    config: RunnerConfig,
    testFile: string,
    cwd: string,
  ): Promise<{ command: string; args: string[] }> {
    if (runner === "phpunit") {
      const suffix = process.platform === "win32" ? ".bat" : "";
      const vendorBin = path.join(cwd, "vendor", "bin", `phpunit${suffix}`);
      if (fs.existsSync(vendorBin)) {
        return { command: vendorBin, args: config.args(testFile, cwd) };
      }
      return { command: "phpunit", args: config.args(testFile, cwd) };
    }

    const binName = config.binName ?? runner;
    const suffix = process.platform === "win32" ? ".cmd" : "";
    const localBin = path.join(cwd, "node_modules", ".bin", binName + suffix);

    if (fs.existsSync(localBin)) {
      return { command: localBin, args: stripWrapperArgs(binName, config.args(testFile, cwd)) };
    }

    const globalBin = await findGlobalBinary(binName);
    if (globalBin) {
      return { command: globalBin, args: stripWrapperArgs(binName, config.args(testFile, cwd)) };
    }

    return { command: config.command, args: config.args(testFile, cwd) };
  }

  private emptyResult(
    testFile: string,
    sourceFile: string,
    runner: string,
    error?: string,
  ): TestResult {
    return {
      file: testFile,
      sourceFile,
      runner,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      error,
    };
  }

  private truncateStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    const lines = stack.split("\n").slice(0, 3);
    return lines.join("\n").slice(0, 500);
  }

  private failedKey(cwd: string, runner: string): string {
    return `${path.resolve(cwd)}:${runner}`;
  }

  private recordResult(cwd: string, runner: string, testFile: string, result: TestResult): void {
    const key = this.failedKey(cwd, runner);
    const abs = path.resolve(testFile);
    const set = this.failedTestsByRunner.get(key) ?? new Set<string>();

    if (result.failed > 0) {
      set.add(abs);
      this.failedTestsByRunner.set(key, set);
      return;
    }

    if (set.has(abs)) {
      set.delete(abs);
      if (set.size === 0) this.failedTestsByRunner.delete(key);
      else this.failedTestsByRunner.set(key, set);
    }
  }
}
