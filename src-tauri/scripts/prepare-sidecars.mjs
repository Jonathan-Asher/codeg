#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Runs `cargo build --release --bin codeg-mcp --no-default-features`
//      for that triple from `src-tauri/`.
//   3. Copies the produced binary to
//      `src-tauri/binaries/codeg-mcp-<triple>{.exe}` so Tauri's externalBin
//      bundler picks it up under the bare name `codeg-mcp` at install time.
//   4. On macOS targets only: builds the natural-voice sidecar `codeg-tts`
//      (Swift package `native/codeg-tts`, BlueTTS 2.5 + RenikudPlus) with
//      `swift build -c release` and stages it the same way. It is listed in
//      tauri.macos.conf.json, so other platforms never look for it. The
//      binary links espeak-ng and is GPL-3.0-or-later; see
//      native/codeg-tts/README.md. `CODEG_SKIP_TTS_SIDECAR=1` skips it (the
//      app then ships build.rs's empty placeholder and reads aloud with the
//      system voices only).
//   5. On macOS targets only: Talk on the Mac's helper `codeg-talk` (Swift
//      package `native/codeg-talk`), built for arm64 only with
//      `swift build -c release --triple arm64-apple-macosx15.0` (its engines,
//      whisper.framework's and sherpa-onnx's, are Apple Silicon only), and
//      the whisper.framework it links, staged as `binaries/whisper.framework`
//      (tauri.macos.conf.json bundles it into Contents/Frameworks). A
//      universal build gets the real helper as its arm64 slice and a stub as
//      its x86_64 one; an x86_64 build, or `CODEG_SKIP_TALK_SIDECAR=1`, ships
//      the stub (`native/codeg-talk/stub`), which tells codeg Talk on this Mac
//      is unavailable, and a stub framework. GPL-3.0-or-later like codeg-tts;
//      see native/codeg-talk/README.md.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     get a host-triple build, so the externalBin lookup still finds a file.
//   - Skippable: set `CODEG_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't care about delegation.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { execFileSync } from "node:child_process"
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
const BIN_NAME = "codeg-mcp"
const TTS_BIN_NAME = "codeg-tts"
const TTS_PACKAGE = resolve(SRC_TAURI, "..", "native", "codeg-tts")
const TALK_BIN_NAME = "codeg-talk"
const TALK_PACKAGE = resolve(SRC_TAURI, "..", "native", "codeg-talk")
const TALK_SWIFT_TRIPLE = "arm64-apple-macosx15.0"
const WHISPER_FRAMEWORK = "whisper.framework"

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

function main() {
  if (process.env.CODEG_SKIP_SIDECAR === "1") {
    log("CODEG_SKIP_SIDECAR=1 — skipping sidecar preparation")
    return
  }

  const { target: cliTarget } = parseArgs(process.argv.slice(2))
  const target =
    cliTarget || process.env.TAURI_TARGET_TRIPLE || resolveHostTriple()
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""

  log(`target triple: ${target}`)
  log(`building ${BIN_NAME} (--release --no-default-features)`)

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  // `--no-default-features` keeps codeg-mcp free of the Tauri runtime deps —
  // the bin's required-features is empty, so this just enables cross-compile
  // without dragging in macOS-private-api / Linux WebKit / Windows WebView2.
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--bin",
      BIN_NAME,
      "--no-default-features",
      "--target",
      target,
    ],
    { stdio: "inherit", cwd: SRC_TAURI }
  )

  const built = join(
    SRC_TAURI,
    "target",
    target,
    "release",
    `${BIN_NAME}${ext}`
  )
  if (!existsSync(built)) {
    die(`expected ${built} after cargo build, but it does not exist`)
  }

  mkdirSync(BINARIES_DIR, { recursive: true })
  const dest = join(BINARIES_DIR, `${BIN_NAME}-${target}${ext}`)
  copyFileSync(built, dest)
  if (!isWindows) {
    // copyFileSync preserves modes on POSIX, but be explicit for tarball
    // sources that may strip the +x bit.
    chmodSync(dest, 0o755)
  }
  log(`sidecar staged at ${dest}`)

  buildTtsSidecar(target)
  buildTalkSidecar(target)
}

/** The Swift triple for a Rust darwin triple (`aarch64` → `arm64`). */
function swiftTriple(rustTriple) {
  const arch = rustTriple.split("-")[0] === "aarch64" ? "arm64" : "x86_64"
  return `${arch}-apple-macosx15.0`
}

function swiftBuild(extraArgs) {
  const args = [
    "build",
    "-c",
    "release",
    "--product",
    TTS_BIN_NAME,
    ...extraArgs,
  ]
  execFileSync("swift", args, { stdio: "inherit", cwd: TTS_PACKAGE })
  const binDir = execFileSync("swift", [...args, "--show-bin-path"], {
    encoding: "utf8",
    cwd: TTS_PACKAGE,
  }).trim()
  const built = join(binDir, TTS_BIN_NAME)
  if (!existsSync(built)) {
    die(`expected ${built} after swift build, but it does not exist`)
  }
  return built
}

function buildTtsSidecar(target) {
  if (!target.endsWith("apple-darwin")) return
  if (process.env.CODEG_SKIP_TTS_SIDECAR === "1") {
    log("CODEG_SKIP_TTS_SIDECAR=1 — skipping codeg-tts (natural voice off)")
    return
  }
  try {
    execFileSync("swift", ["--version"], { stdio: "ignore" })
  } catch {
    die(
      "codeg-tts needs the Swift toolchain (Xcode or the Command Line " +
        "Tools). Install it, or set CODEG_SKIP_TTS_SIDECAR=1 to build " +
        "without the natural voice."
    )
  }

  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64"
  const triples =
    target === "universal-apple-darwin"
      ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
      : [target]
  log(`building ${TTS_BIN_NAME} (swift build -c release) for ${triples}`)
  const builds = triples.map((triple) =>
    swiftBuild(
      triple.startsWith(`${hostArch}-`) ? [] : ["--triple", swiftTriple(triple)]
    )
  )

  mkdirSync(BINARIES_DIR, { recursive: true })
  const dest = join(BINARIES_DIR, `${TTS_BIN_NAME}-${target}`)
  if (builds.length > 1) {
    execFileSync("lipo", ["-create", "-output", dest, ...builds], {
      stdio: "inherit",
    })
  } else {
    copyFileSync(builds[0], dest)
  }
  chmodSync(dest, 0o755)
  log(`sidecar staged at ${dest}`)
}

function requireSwift(what, skipVar) {
  try {
    execFileSync("swift", ["--version"], { stdio: "ignore" })
  } catch {
    die(
      `${what} needs the Swift toolchain (Xcode or the Command Line ` +
        `Tools). Install it, or set ${skipVar}=1 to build without it.`
    )
  }
}

/**
 * Talk on the Mac's helper and the whisper.framework it links, staged as
 * `binaries/codeg-talk-<triple>` and `binaries/whisper.framework`.
 */
function buildTalkSidecar(target) {
  if (!target.endsWith("apple-darwin")) return
  mkdirSync(BINARIES_DIR, { recursive: true })
  const dest = join(BINARIES_DIR, `${TALK_BIN_NAME}-${target}`)
  const framework = join(BINARIES_DIR, WHISPER_FRAMEWORK)
  const runsTalk =
    target === "aarch64-apple-darwin" || target === "universal-apple-darwin"
  if (process.env.CODEG_SKIP_TALK_SIDECAR === "1" || !runsTalk) {
    const why = runsTalk
      ? "CODEG_SKIP_TALK_SIDECAR=1"
      : `${target} can't run Talk's engines (Apple Silicon only)`
    log(`${why}: staging the ${TALK_BIN_NAME} stub (no Talk on this Mac)`)
    stageTalkStub(target, dest, framework)
    return
  }
  requireSwift(TALK_BIN_NAME, "CODEG_SKIP_TALK_SIDECAR")

  const args = [
    "build",
    "-c",
    "release",
    "--product",
    TALK_BIN_NAME,
    "--triple",
    TALK_SWIFT_TRIPLE,
  ]
  log(`building ${TALK_BIN_NAME} (swift ${args.join(" ")})`)
  execFileSync("swift", args, { stdio: "inherit", cwd: TALK_PACKAGE })
  const binDir = execFileSync("swift", [...args, "--show-bin-path"], {
    encoding: "utf8",
    cwd: TALK_PACKAGE,
  }).trim()
  const built = join(binDir, TALK_BIN_NAME)
  const builtFramework = join(binDir, WHISPER_FRAMEWORK)
  if (!existsSync(built) || !existsSync(builtFramework)) {
    die(`expected ${built} and ${builtFramework} after swift build`)
  }
  if (target === "universal-apple-darwin") {
    // Apple Silicon runs the real helper; an Intel Mac runs the stub's slice.
    const stub = compileTalkStub(["x86_64"])
    execFileSync("lipo", ["-create", "-output", dest, built, stub], {
      stdio: "inherit",
    })
  } else {
    copyFileSync(built, dest)
  }
  chmodSync(dest, 0o755)
  // ditto keeps the framework's Versions/Current symlinks.
  rmSync(framework, { recursive: true, force: true })
  execFileSync("ditto", [builtFramework, framework], { stdio: "inherit" })
  log(`sidecar staged at ${dest}, ${WHISPER_FRAMEWORK} at ${framework}`)
}

/** The stub's architectures for a target. */
function stubArches(target) {
  if (target.startsWith("x86_64-")) return ["x86_64"]
  if (target.startsWith("aarch64-")) return ["arm64"]
  return ["arm64", "x86_64"]
}

/** Compile the codeg-talk stub for `arches`; returns its path. */
function compileTalkStub(arches) {
  const out = join(mkdtempSync(join(tmpdir(), "codeg-talk-stub-")), "codeg-talk")
  execFileSync(
    "clang",
    [
      ...arches.flatMap((a) => ["-arch", a]),
      "-mmacosx-version-min=11.0",
      "-O2",
      "-o",
      out,
      join(TALK_PACKAGE, "stub", "codeg-talk-stub.c"),
    ],
    { stdio: "inherit" }
  )
  return out
}

/**
 * The stub helper, and a stub whisper.framework for tauri.macos.conf.json to
 * bundle (nothing loads it).
 */
function stageTalkStub(target, dest, framework) {
  const arches = stubArches(target)
  copyFileSync(compileTalkStub(arches), dest)
  chmodSync(dest, 0o755)

  rmSync(framework, { recursive: true, force: true })
  const version = join(framework, "Versions", "A")
  mkdirSync(join(version, "Resources"), { recursive: true })
  execFileSync(
    "clang",
    [
      ...arches.flatMap((a) => ["-arch", a]),
      "-dynamiclib",
      "-mmacosx-version-min=11.0",
      "-install_name",
      "@rpath/whisper.framework/Versions/A/whisper",
      "-o",
      join(version, "whisper"),
      join(TALK_PACKAGE, "stub", "whisper-stub.c"),
    ],
    { stdio: "inherit" }
  )
  copyFileSync(
    join(TALK_PACKAGE, "stub", "whisper-stub-Info.plist"),
    join(version, "Resources", "Info.plist")
  )
  symlinkSync("A", join(framework, "Versions", "Current"))
  symlinkSync("Versions/Current/whisper", join(framework, "whisper"))
  symlinkSync("Versions/Current/Resources", join(framework, "Resources"))
  log(`stub staged at ${dest}, stub ${WHISPER_FRAMEWORK} at ${framework}`)
}

main()
