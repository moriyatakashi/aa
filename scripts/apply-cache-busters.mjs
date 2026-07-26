#!/usr/bin/env node
// scripts/apply-cache-busters.mjs
// HTML内の ?v=... キャッシュバスターを、参照先ファイルの内容ハッシュへ自動で書き換える。
// デプロイのビルド段(pages.yml、index生成の後)で作業ツリーのHTMLに対して実行する想定。
// これにより ?v= の手動更新が不要になる(ba-169 / ba-67改善案(b))。
//
// 設計方針:
// - 値は問わない(?v=auto でも ?v=20260727 でも)。既存の日時ベース参照もそのまま
//   ハッシュへ置き換わるため、ソース側を一括移行しなくても導入直後から効く。
// - 内容ハッシュ(sha256先頭10桁)なので、中身が変わったファイルだけ ?v= が変化する
//   = 無関係なアセットの再ダウンロードは起きない(コミットSHA一律注入より効率的)。
// - 参照先が見つからない ?v= はエラーにして exit=1(タイポ・配置ミスの検知を兼ねる)。
// - 参照解決規則は check-cache-busters.mjs と揃える(HTMLのdirname基準でposix normalize)。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();

// href="....css?v=xxx" / src="....js?v=xxx" のみ対象。外部URL(http:等)は ":" を含むため除外。
const REF_RE = /((?:href|src)=")([^"?:]+\.(?:css|js))\?v=[^"]+(")/g;

function hashOf(absFile) {
  return createHash("sha256").update(readFileSync(absFile)).digest("hex").slice(0, 10);
}

function listHtml(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".html"))
    .map((d) => path.join(d.parentPath ?? d.path, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules") && !f.split(path.sep).includes(".git"));
}

function main() {
  let filesChanged = 0;
  let refsReplaced = 0;
  const missing = [];

  for (const htmlFile of listHtml(ROOT)) {
    const content = readFileSync(htmlFile, "utf-8");
    let touched = false;
    const out = content.replace(REF_RE, (m, pre, rawRel, post) => {
      // HTMLの位置を基準に相対参照を解決(check-cache-busters.mjs と同じ規則)
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(htmlFile), rawRel));
      try {
        const v = hashOf(rel);
        touched = true;
        refsReplaced++;
        return `${pre}${rawRel}?v=${v}${post}`;
      } catch {
        missing.push(`${htmlFile} -> ${rawRel}`);
        return m; // 見つからなければ書き換えず、下でエラーにする
      }
    });
    if (touched) {
      writeFileSync(htmlFile, out);
      filesChanged++;
    }
  }

  console.log(`[apply-cache-busters] HTML書換: ${filesChanged}件 / 置換した参照: ${refsReplaced}件`);
  if (missing.length > 0) {
    console.error("[apply-cache-busters] 参照先が見つからない ?v= があります:");
    for (const x of missing) console.error("  " + x);
    process.exitCode = 1;
  }
}

main();
