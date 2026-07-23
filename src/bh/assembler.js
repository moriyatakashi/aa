// NASM構文のごく一部だけを解釈するミニアセンブラ。
// 本物のnasmバイナリは使わず、テキスト→「機械語相当の内部表現」(命令オブジェクトの配列 +
// dataセクションのバイト列)への変換をブラウザ内で完結させる自作の簡易パーサ。
//
// 対応: section .data / section .text、db、ラベル、
//       MOV/ADD/SUB/CMP/JMP/JE/JNE/JL/JLE/JG/JGE/INT のみ。
// 非対応(v1時点): メモリ間接参照([ecx]等)、8/16bitサブレジスタ(al/ax等)、
//       マクロ、他のディレクティブ全般。

import { REG_NAMES } from "./x86.js";

const REG_SET = new Set(REG_NAMES);
const JUMP_OPS = new Set(["JMP", "JE", "JZ", "JNE", "JNZ", "JL", "JLE", "JG", "JGE"]);
// 別名(JZ/JNZ)を正規化する対応表。
const OP_ALIAS = { JZ: "JE", JNZ: "JNE" };

function stripComment(line) {
  // ; 以降はコメント。文字列リテラル内の ; は保持する必要があるため簡易的に走査する。
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    } else if (c === ";") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseImmediateToken(tok) {
  if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^0x[0-9a-fA-F]+$/.test(tok)) return parseInt(tok, 16);
  return null;
}

function parseDbArgs(text) {
  const bytes = [];
  const errors = [];
  let i = 0;
  const items = [];
  // カンマ区切り。ただし文字列リテラル内のカンマでは分割しない。
  let cur = "";
  let inStr = null;
  for (i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) items.push(cur.trim());

  for (const item of items) {
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      const s = item.slice(1, -1);
      for (const ch of s) bytes.push(ch.charCodeAt(0) & 0xff);
    } else {
      const v = parseImmediateToken(item);
      if (v === null) {
        errors.push(`db の値を解釈できません: ${item}`);
      } else {
        bytes.push(v & 0xff);
      }
    }
  }
  return { bytes, errors };
}

function parseOperand(tok, dataLabels) {
  const upper = tok.toUpperCase();
  if (REG_SET.has(upper)) return { kind: "reg", reg: upper };
  const imm = parseImmediateToken(tok);
  if (imm !== null) return { kind: "imm", value: imm };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok) && dataLabels.has(tok)) {
    return { kind: "imm", value: dataLabels.get(tok) };
  }
  return null;
}

export function assemble(source) {
  const rawLines = source.split(/\r\n|\r|\n/);
  const errors = [];
  const codeLabels = new Map(); // ラベル名 -> 命令インデックス
  const dataLabels = new Map(); // ラベル名 -> dataBytes中のオフセット
  const dataBytes = [];
  const rawInstrLines = []; // {lineNo, mnemonic, operandsText}
  const listing = []; // 各ソース行 -> {kind:'data'|'code', index} | null(空行・宣言のみ)
  let section = "text";

  // ── パス1: ラベル表とdataセクションのバイト列を確定させる ──────────────
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i]);
    const trimmed = stripped.trim();
    if (!trimmed) {
      listing.push(null);
      continue;
    }

    let m = trimmed.match(/^section\s+\.?(\w+)/i);
    if (m) {
      section = m[1].toLowerCase();
      listing.push(null);
      continue;
    }
    if (/^(global|extern|bits|org)\b/i.test(trimmed)) {
      listing.push(null);
      continue;
    }

    let rest = trimmed;
    let label = null;
    const labelMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (labelMatch) {
      label = labelMatch[1];
      rest = labelMatch[2].trim();
    } else {
      // NASMの慣習として、dbの直前のラベルはコロン省略(例: msg db "hi",0)が多いため許容する。
      const noColonDb = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+db\s+(.*)$/i);
      if (noColonDb) {
        label = noColonDb[1];
        rest = `db ${noColonDb[2]}`;
      }
    }

    if (!rest) {
      // ラベルのみの行(次に来る命令/データの位置を指す)。
      if (label) {
        if (section === "data") dataLabels.set(label, dataBytes.length);
        else codeLabels.set(label, rawInstrLines.length);
      }
      listing.push(null);
      continue;
    }

    const dbMatch = rest.match(/^db\s+(.*)$/i);
    if (dbMatch) {
      if (label) dataLabels.set(label, dataBytes.length);
      const startOffset = dataBytes.length;
      const { bytes, errors: dbErrors } = parseDbArgs(dbMatch[1]);
      for (const msg of dbErrors) errors.push({ line: i, message: msg });
      dataBytes.push(...bytes);
      listing.push({ kind: "data", offset: startOffset });
      continue;
    }

    if (section === "data") {
      errors.push({ line: i, message: `.dataセクションではdb以外未対応です: ${rest}` });
      listing.push(null);
      continue;
    }

    if (label) codeLabels.set(label, rawInstrLines.length);
    const instrMatch = rest.match(/^(\S+)\s*(.*)$/);
    if (!instrMatch) {
      errors.push({ line: i, message: `解釈できない行です: ${rest}` });
      listing.push(null);
      continue;
    }
    const index = rawInstrLines.length;
    rawInstrLines.push({ lineNo: i, mnemonic: instrMatch[1].toUpperCase(), operandsText: instrMatch[2].trim() });
    listing.push({ kind: "code", index });
  }

  // ── パス2: ラベルが出揃った状態でオペランドを解決する ────────────────
  const instructions = [];
  for (const raw of rawInstrLines) {
    const mnemonic = OP_ALIAS[raw.mnemonic] || raw.mnemonic;
    const operands = raw.operandsText ? raw.operandsText.split(",").map((s) => s.trim()) : [];

    if (JUMP_OPS.has(mnemonic)) {
      const target = operands[0];
      if (!target || !codeLabels.has(target)) {
        errors.push({ line: raw.lineNo, message: `未定義のラベルへのジャンプです: ${target || "(なし)"}` });
        instructions.push({ op: "NOP" });
        continue;
      }
      instructions.push({ op: mnemonic, target: codeLabels.get(target) });
      continue;
    }

    if (mnemonic === "INT") {
      const v = parseImmediateToken(operands[0] || "");
      if (v !== 0x80) {
        errors.push({ line: raw.lineNo, message: `INT ${operands[0] || ""} は未対応です(INT 0x80のみ対応)` });
        instructions.push({ op: "NOP" });
        continue;
      }
      instructions.push({ op: "INT" });
      continue;
    }

    if (["MOV", "ADD", "SUB", "CMP"].includes(mnemonic)) {
      if (operands.length !== 2) {
        errors.push({ line: raw.lineNo, message: `${mnemonic} はオペランドが2個必要です: ${raw.operandsText}` });
        instructions.push({ op: "NOP" });
        continue;
      }
      const dst = parseOperand(operands[0], dataLabels);
      const src = parseOperand(operands[1], dataLabels);
      if (!dst || dst.kind !== "reg") {
        errors.push({ line: raw.lineNo, message: `${mnemonic} の第1オペランドはレジスタである必要があります: ${operands[0]}` });
        instructions.push({ op: "NOP" });
        continue;
      }
      if (!src) {
        errors.push({ line: raw.lineNo, message: `オペランドを解釈できません: ${operands[1]}` });
        instructions.push({ op: "NOP" });
        continue;
      }
      instructions.push({ op: mnemonic, dst, src });
      continue;
    }

    errors.push({ line: raw.lineNo, message: `未対応の命令です: ${raw.mnemonic}` });
    instructions.push({ op: "NOP" });
  }

  let entryIndex = 0;
  if (codeLabels.has("_start")) entryIndex = codeLabels.get("_start");
  else if (codeLabels.has("start")) entryIndex = codeLabels.get("start");

  return {
    ok: errors.length === 0,
    errors,
    instructions,
    dataBytes: Uint8Array.from(dataBytes),
    dataLabels,
    codeLabels,
    entryIndex,
    listing,
  };
}
