// COBOL構文のごく一部だけを解釈するミニパーサ。
// 本物のCOBOLコンパイラは使わず、テキスト→AST(PROCEDURE DIVISIONの文の木構造)への
// 変換をブラウザ内で完結させる自作の簡易パーサ。
//
// 対応: IDENTIFICATION DIVISION / DATA DIVISION(WORKING-STORAGE SECTIONの01項目、
//       PIC 9(n)・PIC X(n)、VALUE句) / PROCEDURE DIVISION(DISPLAY, MOVE, ADD, SUBTRACT,
//       IF/ELSE/END-IF, PERFORM UNTIL/PERFORM n TIMES ... END-PERFORM, STOP RUN)。
// 非対応(v1時点): 名前付き段落へのPERFORM、SECTION分割、FILE DIVISION、COMPUTE、
//       文字列演算(STRING/UNSTRING)、数値の小数点、他のPICパターン全般。

const RELOPS = {
  "=": "=",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
};
// 語彙形式の関係演算子(IS は単なる飾り語として無視する)。
const WORD_RELOPS = [
  [["GREATER", "THAN", "OR", "EQUAL", "TO"], ">="],
  [["LESS", "THAN", "OR", "EQUAL", "TO"], "<="],
  [["GREATER", "THAN"], ">"],
  [["LESS", "THAN"], "<"],
  [["NOT", "EQUAL", "TO"], "<>"],
  [["EQUAL", "TO"], "="],
  [["EQUALS"], "="],
];

function tokenize(text) {
  // 文字列リテラルを1トークンとして保持しつつ、単語・記号・ピリオド(文末)を分割する。
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== quote) {
        s += text[j];
        j++;
      }
      tokens.push({ type: "string", value: s });
      i = j + 1;
      continue;
    }
    if (c === ".") {
      // 直後が空白/改行/終端なら文末ピリオド。数値の中の"."(未対応)はここでは考慮しない。
      tokens.push({ type: "period", value: "." });
      i++;
      continue;
    }
    if (">=<".includes(c)) {
      if (text[i + 1] === "=") {
        tokens.push({ type: "op", value: c + "=" });
        i += 2;
      } else {
        tokens.push({ type: "op", value: c });
        i++;
      }
      continue;
    }
    // 単語(識別子・数値・キーワード)
    let j = i;
    while (j < text.length && !/[\s.]/.test(text[j]) && !">=<".includes(text[j])) j++;
    tokens.push({ type: "word", value: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

function isNumericLiteral(s) {
  return /^-?\d+$/.test(s);
}

class TokenCursor {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset] || null;
  }
  peekWord(offset = 0) {
    const t = this.peek(offset);
    return t && t.type === "word" ? t.value.toUpperCase() : null;
  }
  next() {
    return this.tokens[this.pos++] || null;
  }
  atEnd() {
    return this.pos >= this.tokens.length;
  }
}

class ParseError extends Error {}

function parseOperand(cur) {
  const t = cur.next();
  if (!t) throw new ParseError("式の途中で入力が終わりました");
  if (t.type === "string") return { kind: "lit-string", value: t.value };
  if (t.type === "word" && isNumericLiteral(t.value)) return { kind: "lit-number", value: parseInt(t.value, 10) };
  if (t.type === "word") return { kind: "var", name: t.value.toUpperCase() };
  throw new ParseError(`オペランドとして解釈できません: ${t.value}`);
}

function tryParseRelop(cur) {
  const opTok = cur.peek();
  if (opTok && opTok.type === "op" && RELOPS[opTok.value]) {
    cur.next();
    return RELOPS[opTok.value];
  }
  // IS は無視して先へ進める。
  let save = cur.pos;
  if (cur.peekWord() === "IS") cur.next();
  for (const [words, op] of WORD_RELOPS) {
    const start = cur.pos;
    let ok = true;
    for (const w of words) {
      if (cur.peekWord() !== w) {
        ok = false;
        break;
      }
      cur.next();
    }
    if (ok) return op;
    cur.pos = start;
  }
  cur.pos = save;
  return null;
}

function parseCondition(cur) {
  const left = parseOperand(cur);
  const op = tryParseRelop(cur);
  if (!op) throw new ParseError("比較演算子(=, >, <, >=, <=, GREATER THAN等)が見つかりません");
  const right = parseOperand(cur);
  return { left, op, right };
}

// stopWords: このいずれかのキーワードが次に来たら文の並びの終わりとみなす(消費しない)。
function parseStatements(cur, stopWords) {
  const stmts = [];
  while (!cur.atEnd()) {
    const w = cur.peekWord();
    if (w && stopWords.includes(w)) break;
    if (cur.peek().type === "period") {
      cur.next();
      continue;
    }
    stmts.push(parseStatement(cur));
  }
  return stmts;
}

function consumeOptionalPeriod(cur) {
  if (cur.peek() && cur.peek().type === "period") cur.next();
}

// 文の切れ目として認識するキーワード。ピリオド省略時(END-IF直前など)の保険として、
// DISPLAYのオペランド列挙などがこれらを誤って取り込まないようにする。
const STATEMENT_BOUNDARY_WORDS = new Set([
  "DISPLAY", "MOVE", "ADD", "SUBTRACT", "IF", "PERFORM", "STOP",
  "ELSE", "END-IF", "END-PERFORM",
]);

function atStatementBoundary(cur) {
  const t = cur.peek();
  if (!t) return true;
  if (t.type === "period") return true;
  if (t.type === "word" && STATEMENT_BOUNDARY_WORDS.has(t.value.toUpperCase())) return true;
  return false;
}

function expectWord(cur, word) {
  const w = cur.peekWord();
  if (w !== word) throw new ParseError(`"${word}" を期待しましたが見つかりません(手前: ${cur.peek() ? cur.peek().value : "(入力終端)"})`);
  cur.next();
}

function parseStatement(cur) {
  const kw = cur.peekWord();
  if (!kw) throw new ParseError("文を解釈できません");

  if (kw === "DISPLAY") {
    cur.next();
    const items = [];
    while (!cur.atEnd() && !atStatementBoundary(cur)) {
      items.push(parseOperand(cur));
    }
    consumeOptionalPeriod(cur);
    return { type: "DISPLAY", items };
  }

  if (kw === "MOVE") {
    cur.next();
    const src = parseOperand(cur);
    expectWord(cur, "TO");
    const dest = parseOperand(cur);
    if (dest.kind !== "var") throw new ParseError("MOVEの移動先は変数名である必要があります");
    consumeOptionalPeriod(cur);
    return { type: "MOVE", src, dest };
  }

  if (kw === "ADD") {
    cur.next();
    const operand = parseOperand(cur);
    expectWord(cur, "TO");
    const dest = parseOperand(cur);
    if (dest.kind !== "var") throw new ParseError("ADD ... TO の対象は変数名である必要があります");
    consumeOptionalPeriod(cur);
    return { type: "ADD", operand, dest };
  }

  if (kw === "SUBTRACT") {
    cur.next();
    const operand = parseOperand(cur);
    expectWord(cur, "FROM");
    const dest = parseOperand(cur);
    if (dest.kind !== "var") throw new ParseError("SUBTRACT ... FROM の対象は変数名である必要があります");
    consumeOptionalPeriod(cur);
    return { type: "SUBTRACT", operand, dest };
  }

  if (kw === "IF") {
    cur.next();
    const condition = parseCondition(cur);
    if (cur.peekWord() === "THEN") cur.next();
    const thenBlock = parseStatements(cur, ["ELSE", "END-IF"]);
    let elseBlock = [];
    if (cur.peekWord() === "ELSE") {
      cur.next();
      elseBlock = parseStatements(cur, ["END-IF"]);
    }
    expectWord(cur, "END-IF");
    consumeOptionalPeriod(cur);
    return { type: "IF", condition, thenBlock, elseBlock };
  }

  if (kw === "PERFORM") {
    cur.next();
    if (cur.peekWord() === "UNTIL") {
      cur.next();
      const condition = parseCondition(cur);
      const body = parseStatements(cur, ["END-PERFORM"]);
      expectWord(cur, "END-PERFORM");
      consumeOptionalPeriod(cur);
      return { type: "PERFORM_UNTIL", condition, body };
    }
    // PERFORM <n> TIMES ... END-PERFORM
    const countTok = cur.next();
    if (!countTok || countTok.type !== "word" || !isNumericLiteral(countTok.value)) {
      throw new ParseError("PERFORMの後にはUNTILまたは回数(n TIMES)が必要です");
    }
    expectWord(cur, "TIMES");
    const body = parseStatements(cur, ["END-PERFORM"]);
    expectWord(cur, "END-PERFORM");
    consumeOptionalPeriod(cur);
    return { type: "PERFORM_TIMES", count: parseInt(countTok.value, 10), body };
  }

  if (kw === "STOP") {
    cur.next();
    if (cur.peekWord() === "RUN") cur.next();
    consumeOptionalPeriod(cur);
    return { type: "STOP_RUN" };
  }

  throw new ParseError(`未対応の文です: ${kw}`);
}

// DATA DIVISION の WORKING-STORAGE SECTION、01項目のみ対応。
// 例: 01 WS-COUNT PIC 9(2) VALUE 0.
function parseDataDecl(stmtText) {
  const m = stmtText.match(
    /^(\d+)\s+([A-Za-z0-9-]+)\s+PIC\s+(9|X)(?:\((\d+)\))?\s*(?:VALUE\s+(.+))?$/i
  );
  if (!m) return { error: `WORKING-STORAGE項目を解釈できません: ${stmtText}` };
  const [, , name, picType, widthStr] = m;
  let valueStr = m[5];
  const width = widthStr ? parseInt(widthStr, 10) : 1;
  const type = picType.toUpperCase() === "9" ? "numeric" : "alpha";
  let value;
  if (valueStr) {
    valueStr = valueStr.trim();
    const strMatch = valueStr.match(/^"([^"]*)"$|^'([^']*)'$/);
    if (strMatch) {
      value = strMatch[1] !== undefined ? strMatch[1] : strMatch[2];
    } else if (isNumericLiteral(valueStr)) {
      value = parseInt(valueStr, 10);
    } else {
      return { error: `VALUE句を解釈できません: ${valueStr}` };
    }
  } else {
    value = type === "numeric" ? 0 : "";
  }
  return { decl: { name: name.toUpperCase(), type, width, value } };
}

// ピリオド区切りで分割する(文字列リテラル内のピリオドは無視)。
function splitByPeriod(text) {
  const stmts = [];
  let cur = "";
  let inStr = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
    } else if (c === ".") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

function stripComments(source) {
  // COBOLの伝統的な桁位置コメント(7桁目に*)は対象外とし、一般的な *> 行コメントのみ対応。
  return source
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const idx = line.indexOf("*>");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export function parse(source) {
  const errors = [];
  const text = stripComments(source);
  const upper = text.toUpperCase();

  const idIdx = upper.indexOf("IDENTIFICATION DIVISION");
  const dataIdx = upper.indexOf("DATA DIVISION");
  const procIdx = upper.indexOf("PROCEDURE DIVISION");

  if (procIdx === -1) {
    return { ok: false, errors: [{ message: "PROCEDURE DIVISION が見つかりません" }] };
  }

  let programName = "";
  if (idIdx !== -1) {
    const idSection = text.slice(idIdx, dataIdx !== -1 ? dataIdx : procIdx);
    const pm = idSection.match(/PROGRAM-ID\.\s*([A-Za-z0-9-]+)/i);
    if (pm) programName = pm[1];
  }

  const vars = [];
  if (dataIdx !== -1) {
    const dataSection = text.slice(dataIdx, procIdx);
    const wsIdx = dataSection.toUpperCase().indexOf("WORKING-STORAGE SECTION");
    const declText = wsIdx !== -1 ? dataSection.slice(wsIdx + "WORKING-STORAGE SECTION".length) : "";
    for (const stmt of splitByPeriod(declText)) {
      const { decl, error } = parseDataDecl(stmt);
      if (error) errors.push({ message: error });
      else vars.push(decl);
    }
  }

  // PROCEDURE DIVISION. の直後(ピリオドの後)から末尾まで。
  let procText = text.slice(procIdx);
  const firstPeriod = procText.indexOf(".");
  procText = firstPeriod !== -1 ? procText.slice(firstPeriod + 1) : "";

  let statements = [];
  try {
    const tokens = tokenize(procText);
    const cur = new TokenCursor(tokens);
    statements = parseStatements(cur, []);
    if (!cur.atEnd()) {
      throw new ParseError(`余分なトークンがあります: ${cur.peek().value}`);
    }
  } catch (e) {
    errors.push({ message: e.message });
  }

  return {
    ok: errors.length === 0,
    errors,
    program: { name: programName, vars, statements },
  };
}
