#!/usr/bin/env node
// scripts/check-cache-busters.mjs
// 共有CSS/JSの中身が変わったのに、それを参照しているHTML側の?v=キャッシュバスターが
// 据え置きのままになっていないかをチェックする(ba-87の再発防止)。
// 対象はledger.cssに限らず、リポジトリ内の全HTMLが持つ ...?v=... 形式の参照全て。
import { execFileSync } from "node:child_process";
import path from "node:path";

const BEFORE = process.argv[2] || "HEAD~1";
const AFTER = process.argv[3] || "HEAD";

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" });
}

// -e チェックは存在しないのが想定内のケースが多いため、fatal: をログに垂れ流さないよう抑制する
function quietCheck(args) {
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function refExists(ref) {
  return quietCheck(["cat-file", "-e", ref]);
}

function fileExistsAtRef(ref, file) {
  return quietCheck(["cat-file", "-e", `${ref}:${file}`]);
}

function showAtRef(ref, file) {
  return git(["show", `${ref}:${file}`]);
}

function listHtmlFilesAtRef(ref) {
  return git(["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .filter((f) => f.endsWith(".html"));
}

// href="../common/ledger.css?v=123" / src="app.js?v=456" のみ対象(外部URLは除外)
const REF_RE = /(?:href|src)="([^"?:]+\.(?:css|js))\?v=([^"]+)"/g;

function extractRefs(htmlContent) {
  const refs = new Map(); // 参照の生パス(相対文字列そのまま) -> version
  for (const m of htmlContent.matchAll(REF_RE)) {
    refs.set(m[1], m[2]);
  }
  return refs;
}

function resolveAssetPath(htmlFile, rawRelative) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(htmlFile), rawRelative));
}

function main() {
  if (!refExists(BEFORE)) {
    console.log(`[cache-buster-check] 比較元(${BEFORE})が無いためスキップします(初回コミット等)。`);
    return;
  }

  const changedFiles = new Set(
    git(["diff", "--name-only", BEFORE, AFTER]).split("\n").filter(Boolean)
  );

  const htmlFiles = listHtmlFilesAtRef(AFTER);
  const problems = [];

  for (const htmlFile of htmlFiles) {
    const newContent = showAtRef(AFTER, htmlFile);
    const newRefs = extractRefs(newContent);
    if (newRefs.size === 0) continue;

    const oldContent = fileExistsAtRef(BEFORE, htmlFile) ? showAtRef(BEFORE, htmlFile) : null;
    const oldRefs = oldContent ? extractRefs(oldContent) : new Map();

    for (const [rawPath, newVersion] of newRefs) {
      const assetPath = resolveAssetPath(htmlFile, rawPath);
      if (!changedFiles.has(assetPath)) continue; // このアセット自体は今回のdiffで変わっていない

      const oldVersion = oldRefs.get(rawPath);
      if (oldVersion !== undefined && oldVersion === newVersion) {
        problems.push({ htmlFile, assetPath, version: newVersion });
      }
    }
  }

  if (problems.length > 0) {
    console.error("[cache-buster-check] 中身が変わったのに ?v= が据え置きのままの参照があります:");
    for (const p of problems) {
      console.error(`  ${p.htmlFile} -> ${p.assetPath} (v=${p.version} のまま)`);
    }
    console.error("\n該当する <script>/<link> タグの ?v= を更新してください。");
    process.exitCode = 1;
    return;
  }

  console.log("[cache-buster-check] OK: 変更されたCSS/JSの参照は全てバージョンが更新されています。");
}

main();
