// CASL II line lexer/parser.
//
// A CASL II source line has the form:
//   [label] <ws> opcode <ws> operand [, operand ...]  [; comment]
// The label field is optional but, if present, must start in column 1
// (i.e. the line must not start with whitespace). Everything outside a
// quoted string is case-folded to upper case; ';' starts a comment
// unless inside a quoted string; a doubled quote ('') inside a quoted
// string is a literal quote character.

const LABEL_RE = /^[A-Z][A-Z0-9]{0,7}$/;
const GR_RE = /^GR[0-7]$/;

export function isLabelToken(token) {
  return LABEL_RE.test(token) && !GR_RE.test(token);
}

export function isGRToken(token) {
  return GR_RE.test(token);
}

export function grNumber(token) {
  return isGRToken(token) ? Number(token.charAt(2)) : -1;
}

// Splits a raw line into whitespace-delimited / comma-delimited / quoted
// tokens, honoring ';' comments and '' quote-escaping. Returns an array
// of { text, isSpace, isComma }.
function tokenizeChars(str) {
  const tokens = [];
  let i = 0;
  const n = str.length;

  while (i < n) {
    const ch = str.charAt(i);

    if (ch === ";") break;

    if (ch === ",") {
      tokens.push({ text: ",", isComma: true, isSpace: false });
      i++;
      continue;
    }

    if (ch <= " ") {
      let j = i + 1;
      while (j < n && str.charAt(j) <= " ") j++;
      tokens.push({ text: " ", isComma: false, isSpace: true });
      i = j;
      continue;
    }

    // A regular token: runs until whitespace/comma/';', honoring quotes.
    let inQuote = false;
    const chars = [];
    let j = i;
    while (j < n) {
      const c = str.charAt(j);
      if (inQuote) {
        chars.push(c);
        if (c === "'") inQuote = false;
      } else {
        if (c === "'") {
          inQuote = true;
          chars.push(c);
        } else if (c <= " " || c === ";" || c === ",") {
          break;
        } else {
          chars.push(c.toUpperCase());
        }
      }
      j++;
    }
    tokens.push({ text: chars.join(""), isComma: false, isSpace: false });
    i = j;
  }

  return tokens;
}

// Parses one source line into { label, opcode, operands, error }.
// `error`, when set, is a human-readable message describing a syntax
// problem; the caller decides how to report it against the line number.
export function parseLine(rawLine) {
  const result = { label: "", opcode: "", operands: [], error: null };
  const tokens = tokenizeChars(rawLine);

  if (tokens.length === 0) return result;

  let pos = 0;
  const startedWithSpace = tokens[0].isSpace;

  if (!startedWithSpace) {
    result.label = tokens[pos].text;
    pos++;
    if (pos >= tokens.length) return result;
    if (!tokens[pos].isSpace) {
      result.error = `構文エラーです - ${tokens[pos].text}`;
      return result;
    }
  }

  // Consume the separating whitespace before the opcode field.
  if (pos < tokens.length && tokens[pos].isSpace) pos++;
  if (pos >= tokens.length) return result;

  result.opcode = tokens[pos].text;
  pos++;

  if (pos >= tokens.length) return result;
  if (!tokens[pos].isSpace) {
    result.error = `構文エラーです - ${tokens[pos].text}`;
    return result;
  }
  pos++; // whitespace before the first operand

  if (pos >= tokens.length) return result;

  result.operands.push(tokens[pos].text);
  pos++;

  while (pos < tokens.length) {
    if (tokens[pos].isSpace) {
      pos++;
      if (pos < tokens.length) {
        result.error = `構文エラーです - ${tokens[pos].text}`;
      }
      return result;
    }
    if (!tokens[pos].isComma) {
      result.error = `構文エラーです - ${tokens[pos].text}`;
      return result;
    }
    pos++; // comma

    if (pos >= tokens.length || tokens[pos].isSpace || tokens[pos].isComma) {
      result.error = "構文エラーです - ,";
      return result;
    }
    result.operands.push(tokens[pos].text);
    pos++;
  }

  return result;
}

export function isEmptyLine(parsed) {
  return parsed.label === "" && parsed.opcode === "" && parsed.operands.length === 0;
}
