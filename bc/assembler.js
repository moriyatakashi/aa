// CASL II two-pass assembler, targeting the COMET II instruction set
// (JIS X 0004-2). Produces a 64K memory image plus a listing/label map
// for debugging, or a list of errors if assembly failed.

import { parseLine, isEmptyLine, isLabelToken, isGRToken, grNumber } from "./lexer.js";

const FORMAT = {
  NONE: "none", // no operands, 1 word
  R: "r", // one GR operand, 1 word
  RM: "rm", // GR, addr[, xr] -- 2 words, no register-register form
  RMR: "rmr", // GR, addr[, xr]  or  GR, GR -- 2 words, or 1 word for the GR,GR form
  M: "m", // addr[, xr] -- 2 words
};

export const OPCODES = {
  NOP: { code: 0x00, format: FORMAT.NONE },
  LD: { code: 0x10, format: FORMAT.RMR },
  ST: { code: 0x11, format: FORMAT.RM },
  LAD: { code: 0x12, format: FORMAT.RM },
  ADDA: { code: 0x20, format: FORMAT.RMR },
  SUBA: { code: 0x21, format: FORMAT.RMR },
  ADDL: { code: 0x22, format: FORMAT.RMR },
  SUBL: { code: 0x23, format: FORMAT.RMR },
  AND: { code: 0x30, format: FORMAT.RMR },
  OR: { code: 0x31, format: FORMAT.RMR },
  XOR: { code: 0x32, format: FORMAT.RMR },
  CPA: { code: 0x40, format: FORMAT.RMR },
  CPL: { code: 0x41, format: FORMAT.RMR },
  SLA: { code: 0x50, format: FORMAT.RM },
  SRA: { code: 0x51, format: FORMAT.RM },
  SLL: { code: 0x52, format: FORMAT.RM },
  SRL: { code: 0x53, format: FORMAT.RM },
  JMI: { code: 0x61, format: FORMAT.M },
  JNZ: { code: 0x62, format: FORMAT.M },
  JZE: { code: 0x63, format: FORMAT.M },
  JUMP: { code: 0x64, format: FORMAT.M },
  JPL: { code: 0x65, format: FORMAT.M },
  JOV: { code: 0x66, format: FORMAT.M },
  PUSH: { code: 0x70, format: FORMAT.M },
  POP: { code: 0x71, format: FORMAT.R },
  CALL: { code: 0x80, format: FORMAT.M },
  RET: { code: 0x81, format: FORMAT.NONE },
  SVC: { code: 0xf0, format: FORMAT.M },
};

function parseDecimal(str) {
  if (/^[+-]?[0-9]+$/.test(str)) return Number(str) & 0xffff;
  return null;
}

function parseHex(str) {
  if (/^#[0-9A-Fa-f]+$/.test(str)) return parseInt(str.substring(1), 16) & 0xffff;
  return null;
}

// JIS X 0201 8-bit code <-> Unicode code point, for the subset CASL II
// programs actually use (ASCII plus half-width katakana).
function charCodeToJis8(charCode) {
  if (charCode >= 0 && charCode <= 0x7f) return charCode;
  if (charCode >= 0xff61 && charCode <= 0xff9f) return charCode - 0xff61 + 0xa1;
  return -1;
}

function jis8ToCharCode(jis8) {
  if (jis8 >= 0 && jis8 <= 0x7f) return jis8;
  if (jis8 >= 0xa1 && jis8 <= 0xdf) return jis8 - 0xa1 + 0xff61;
  return -1;
}
export { charCodeToJis8, jis8ToCharCode };

// 'ABC' / 'IT''S' -> array of JIS8 byte values, or null if not a valid
// quoted string constant.
function parseStringConst(str) {
  if (str.length < 2 || str.charAt(0) !== "'" || str.charAt(str.length - 1) !== "'") return null;

  const codes = [];
  for (let i = 1; i < str.length - 1; i++) {
    const ch = str.charAt(i);
    if (ch === "'") {
      if (i < str.length - 1 && str.charAt(i + 1) === "'") {
        codes.push("'".charCodeAt(0));
        i++;
      } else {
        return null; // unescaped quote before the closing quote
      }
    } else {
      const jis8 = charCodeToJis8(str.charCodeAt(i));
      codes.push(jis8 >= 0 ? jis8 : "?".charCodeAt(0));
    }
  }
  return codes;
}

class Block {
  constructor(name, startLine, startAddr) {
    this.name = name; // "" if the START line had no valid label
    this.startLine = startLine;
    this.startAddr = startAddr; // address of the block's first word
    this.entryAddr = startAddr; // resolved once END is processed
    this.locals = new Map(); // name -> { addr, line }
    this.literalOrder = []; // literal keys ("=1", "='A'", ...) in first-seen order
  }
}

export class AssembleError {
  constructor(line, message) {
    this.line = line;
    this.message = message;
  }
}

export class AssembleResult {
  constructor() {
    this.memory = new Uint16Array(65536);
    this.entryPoint = -1;
    this.errors = [];
    // One entry per source line: { address, length, isData } or null for
    // lines that emit no code (blank lines, labels-only, START/END/pseudo
    // headers use `address` but `length === 0`).
    this.listing = new Array();
    // name -> address, for every START label (visible across the whole file).
    this.globals = new Map();
    // One entry per START/END block: { name, entryAddr, locals: Map(name -> {addr, line}) }.
    this.blocks = [];
    this.ok = false;
  }
}

export function assemble(sourceText, options = {}) {
  const originAddr = options.origin ?? 0;
  const entryLabel = options.entryLabel ?? "";

  const lines = sourceText.split(/\r\n|\r|\n/);
  const result = new AssembleResult();
  const errors = result.errors;
  const listing = result.listing;

  const globalDefs = new Map(); // block name -> address
  const blocks = [];
  const patches = []; // { address, name, blockIndex, line }

  let loc = originAddr;
  let block = null;
  let firstBlockEntry = -1;
  let reportedMissingStart = false;

  function defineLocal(name, addr, line) {
    if (block.locals.has(name)) {
      errors.push(new AssembleError(line, `二重定義されています - ${name}`));
      return;
    }
    block.locals.set(name, { addr, line });
  }

  // Resolves an address-field operand (label / literal / decimal / hex)
  // and writes it into `targetAddress`, either immediately (constants) or
  // via a deferred patch (labels and literals, whose value isn't known
  // until the whole source has been scanned).
  function resolveAddressOperand(str, targetAddress, line) {
    if (str.length === 0) {
      errors.push(new AssembleError(line, "アドレスの指定がありません"));
      return;
    }
    if (isLabelToken(str)) {
      patches.push({ address: targetAddress, name: str, blockIndex: blocks.length - 1, line });
      return;
    }
    if (str.charAt(0) === "=") {
      const literalBody = str.substring(1);
      if (literalBody.length === 0) {
        errors.push(new AssembleError(line, "リテラル定数の指定がありません"));
        return;
      }
      const isValidLiteral =
        parseDecimal(literalBody) !== null || parseHex(literalBody) !== null || parseStringConst(literalBody) !== null;
      if (!isValidLiteral) {
        errors.push(new AssembleError(line, `リテラル定数の指定が不正です - ${str}`));
        return;
      }
      if (!block.locals.has(str)) block.literalOrder.push(str);
      patches.push({ address: targetAddress, name: str, blockIndex: blocks.length - 1, line });
      return;
    }
    const dec = parseDecimal(str);
    if (dec !== null) {
      result.memory[targetAddress] = dec;
      return;
    }
    const hex = parseHex(str);
    if (hex !== null) {
      result.memory[targetAddress] = hex;
      return;
    }

    errors.push(new AssembleError(line, `オペランドの指定が不正です - ${str}`));
  }

  function readIndexRegister(operands, n, line) {
    if (operands.length <= n) return 0;
    if (operands.length > n + 1) {
      errors.push(new AssembleError(line, "余分なオペランドがあります"));
    }
    const g = grNumber(operands[n]);
    if (g <= 0) {
      errors.push(new AssembleError(line, `指標レジスタの指定が不正です - ${operands[n]}`));
      return 0;
    }
    return g;
  }

  function readGR(str, line) {
    const g = grNumber(str);
    if (g < 0) {
      errors.push(new AssembleError(line, `GRの指定が不正です - ${str}`));
      return 0;
    }
    return g;
  }

  function emitBlockLiterals(line) {
    for (const key of block.literalOrder) {
      const entry = block.locals.get(key);
      if (entry) continue; // already allocated
      const body = key.substring(1);
      const dec = parseDecimal(body);
      if (dec !== null) {
        block.locals.set(key, { addr: loc, line });
        result.memory[loc++] = dec;
        continue;
      }
      const hex = parseHex(body);
      if (hex !== null) {
        block.locals.set(key, { addr: loc, line });
        result.memory[loc++] = hex;
        continue;
      }
      const str = parseStringConst(body);
      block.locals.set(key, { addr: loc, line });
      for (const code of str) result.memory[loc++] = code;
    }
  }

  function closeBlock(line) {
    if (!block) return;

    // Resolve the optional "execution start label" operand of START,
    // which redirects the block's own entry point to an inner label.
    if (block.pendingStartOperand) {
      const entry = block.locals.get(block.pendingStartOperand);
      if (entry) {
        block.entryAddr = entry.addr;
      } else {
        errors.push(new AssembleError(block.startLine, `未定義です - ${block.pendingStartOperand}`));
      }
    }

    emitBlockLiterals(line);

    if (block.name !== "") {
      if (globalDefs.has(block.name)) {
        errors.push(new AssembleError(block.startLine, `二重定義されています - ${block.name}`));
      } else {
        globalDefs.set(block.name, block.entryAddr);
      }
    }

    if (firstBlockEntry < 0) firstBlockEntry = block.entryAddr;

    result.blocks.push({ name: block.name, entryAddr: block.entryAddr, locals: block.locals });
    block = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);

    if (parsed.error) {
      errors.push(new AssembleError(i, parsed.error));
      listing.push(null);
      continue;
    }
    if (isEmptyLine(parsed)) {
      listing.push(null);
      continue;
    }
    if (parsed.opcode === "") {
      errors.push(new AssembleError(i, "命令がありません"));
      listing.push(null);
      continue;
    }

    const opcode = parsed.opcode;
    const operands = parsed.operands;

    if (opcode === "START") {
      if (block) {
        errors.push(new AssembleError(i, "END命令がありません"));
        closeBlock(i);
      }
      let name = "";
      if (parsed.label === "") {
        errors.push(new AssembleError(i, "START命令にはラベルが必要です"));
      } else if (isLabelToken(parsed.label)) {
        name = parsed.label;
      }
      block = new Block(name, i, loc);
      blocks.push(block);

      let startOperand = "";
      if (operands.length >= 1) {
        if (isLabelToken(operands[0])) startOperand = operands[0];
        else errors.push(new AssembleError(i, `オペランドが不正です - ${operands[0]}`));
        if (operands.length > 1) errors.push(new AssembleError(i, "余分なオペランドがあります"));
      }
      block.pendingStartOperand = startOperand;
      if (name !== "") defineLocal(name, loc, i);
      listing.push({ address: loc, length: 0 });
      continue;
    }

    if (opcode === "END") {
      if (!block) {
        errors.push(new AssembleError(i, "END命令が余分です"));
        listing.push(null);
        continue;
      }
      if (parsed.label !== "") errors.push(new AssembleError(i, "END命令にはラベルは付けられません"));
      if (operands.length !== 0) errors.push(new AssembleError(i, "余分なオペランドがあります"));
      listing.push({ address: loc, length: 0 });
      closeBlock(i);
      continue;
    }

    if (!block) {
      if (!reportedMissingStart) {
        errors.push(new AssembleError(i, "START命令がありません"));
        reportedMissingStart = true;
      }
      block = new Block("", i, loc);
      blocks.push(block);
      block.pendingStartOperand = "";
    }

    if (parsed.label !== "") {
      if (!isLabelToken(parsed.label)) {
        errors.push(new AssembleError(i, `ラベルが不正です - ${parsed.label}`));
      } else {
        defineLocal(parsed.label, loc, i);
      }
    }

    const startAddr = loc;

    if (opcode === "DS") {
      let count = 0;
      if (operands.length !== 1) {
        errors.push(new AssembleError(i, "オペランドの数が不正です"));
      } else if (/^[0-9]+$/.test(operands[0])) {
        count = Number(operands[0]);
      } else {
        errors.push(new AssembleError(i, `オペランドが不正です - ${operands[0]}`));
      }
      loc += count;
      listing.push({ address: startAddr, length: count, isData: true });
      continue;
    }

    if (opcode === "DC") {
      if (operands.length === 0) {
        errors.push(new AssembleError(i, "オペランドがありません"));
      } else {
        for (const operand of operands) {
          if (operand.length === 0) {
            errors.push(new AssembleError(i, "オペランドが不正です"));
            continue;
          }
          if (isLabelToken(operand)) {
            patches.push({ address: loc, name: operand, blockIndex: blocks.length - 1, line: i });
            loc += 1;
            continue;
          }
          const dec = parseDecimal(operand);
          if (dec !== null) {
            result.memory[loc++] = dec;
            continue;
          }
          const hex = parseHex(operand);
          if (hex !== null) {
            result.memory[loc++] = hex;
            continue;
          }
          const str = parseStringConst(operand);
          if (str !== null) {
            for (const code of str) result.memory[loc++] = code;
            continue;
          }
          errors.push(new AssembleError(i, `オペランドが不正です - ${operand}`));
        }
      }
      listing.push({ address: startAddr, length: loc - startAddr, isData: true });
      continue;
    }

    if (opcode === "IN" || opcode === "OUT") {
      if (operands.length !== 2) {
        errors.push(new AssembleError(i, "オペランドの数が不正です"));
        listing.push({ address: startAddr, length: 0 });
        continue;
      }
      const svcCode = opcode === "IN" ? 1 : 2;
      // PUSH 0,GR1 / PUSH 0,GR2 / LAD GR1,buf / LAD GR2,len / SVC svcCode / POP GR2 / POP GR1
      result.memory[loc++] = 0x7001;
      result.memory[loc++] = 0x0000;
      result.memory[loc++] = 0x7002;
      result.memory[loc++] = 0x0000;
      result.memory[loc++] = 0x1210;
      resolveAddressOperand(operands[0], loc, i);
      loc++;
      result.memory[loc++] = 0x1220;
      resolveAddressOperand(operands[1], loc, i);
      loc++;
      result.memory[loc++] = 0xf000;
      result.memory[loc++] = svcCode;
      result.memory[loc++] = 0x7120;
      result.memory[loc++] = 0x7110;
      listing.push({ address: startAddr, length: loc - startAddr });
      continue;
    }

    if (opcode === "RPUSH") {
      if (operands.length !== 0) errors.push(new AssembleError(i, "余分なオペランドがあります"));
      for (let g = 1; g <= 7; g++) {
        result.memory[loc++] = 0x7000 + g;
        result.memory[loc++] = 0x0000;
      }
      listing.push({ address: startAddr, length: loc - startAddr });
      continue;
    }

    if (opcode === "RPOP") {
      if (operands.length !== 0) errors.push(new AssembleError(i, "余分なオペランドがあります"));
      for (let g = 7; g >= 1; g--) {
        result.memory[loc++] = 0x7100 + (g << 4);
      }
      listing.push({ address: startAddr, length: loc - startAddr });
      continue;
    }

    const opInfo = OPCODES[opcode];
    if (!opInfo) {
      errors.push(new AssembleError(i, `命令が不正です - ${opcode}`));
      listing.push(null);
      continue;
    }

    switch (opInfo.format) {
      case FORMAT.NONE: {
        if (operands.length !== 0) errors.push(new AssembleError(i, "余分なオペランドがあります"));
        result.memory[loc++] = opInfo.code << 8;
        break;
      }
      case FORMAT.R: {
        let g = 0;
        if (operands.length < 1) errors.push(new AssembleError(i, "オペランドの数が不正です"));
        else {
          g = readGR(operands[0], i);
          if (operands.length > 1) errors.push(new AssembleError(i, "余分なオペランドがあります"));
        }
        result.memory[loc++] = (opInfo.code << 8) | (g << 4);
        break;
      }
      case FORMAT.M: {
        let xr = 0;
        if (operands.length < 1) {
          errors.push(new AssembleError(i, "オペランドの数が不正です"));
          result.memory[loc++] = opInfo.code << 8;
          loc++;
          break;
        }
        xr = readIndexRegister(operands, 1, i);
        result.memory[loc++] = (opInfo.code << 8) | xr;
        resolveAddressOperand(operands[0], loc, i);
        loc++;
        break;
      }
      case FORMAT.RM: {
        let g = 0;
        let xr = 0;
        if (operands.length < 2) {
          errors.push(new AssembleError(i, "オペランドの数が不正です"));
          result.memory[loc++] = opInfo.code << 8;
          loc++;
          break;
        }
        g = readGR(operands[0], i);
        xr = readIndexRegister(operands, 2, i);
        result.memory[loc++] = (opInfo.code << 8) | (g << 4) | xr;
        resolveAddressOperand(operands[1], loc, i);
        loc++;
        break;
      }
      case FORMAT.RMR: {
        let g = 0;
        if (operands.length < 2) {
          errors.push(new AssembleError(i, "オペランドの数が不正です"));
          result.memory[loc++] = opInfo.code << 8;
          loc++;
          break;
        }
        g = readGR(operands[0], i);
        if (isGRToken(operands[1])) {
          const g2 = grNumber(operands[1]);
          if (operands.length > 2) errors.push(new AssembleError(i, "余分なオペランドがあります"));
          result.memory[loc++] = ((opInfo.code | 0x04) << 8) | (g << 4) | g2;
        } else {
          const xr = readIndexRegister(operands, 2, i);
          result.memory[loc++] = (opInfo.code << 8) | (g << 4) | xr;
          resolveAddressOperand(operands[1], loc, i);
          loc++;
        }
        break;
      }
    }

    listing.push({ address: startAddr, length: loc - startAddr });

    if (loc > 0x10000) {
      errors.push(new AssembleError(i, "COMET II のメモリに収まりません。アセンブルを中止します"));
      break;
    }
  }

  if (block) {
    errors.push(new AssembleError(lines.length - 1, "END命令がありません"));
    closeBlock(lines.length - 1);
  }

  for (const patch of patches) {
    const b = blocks[patch.blockIndex];
    const local = b?.locals.get(patch.name);
    if (local) {
      result.memory[patch.address] = local.addr;
      continue;
    }
    const global = globalDefs.get(patch.name);
    if (global !== undefined) {
      result.memory[patch.address] = global;
      continue;
    }
    errors.push(new AssembleError(patch.line, `未定義です - ${patch.name}`));
  }

  if (entryLabel !== "") {
    const g = globalDefs.get(entryLabel.toUpperCase());
    if (g === undefined) {
      errors.push(new AssembleError(lines.length - 1, `実行開始ラベルが見つかりません - ${entryLabel}`));
    } else {
      result.entryPoint = g;
    }
  } else {
    result.entryPoint = firstBlockEntry;
  }

  if (result.entryPoint < 0 && errors.length === 0) {
    errors.push(new AssembleError(0, "ソースプログラムがありません"));
  }

  result.globals = globalDefs;
  errors.sort((a, b) => a.line - b.line);
  result.ok = errors.length === 0;
  return result;
}
