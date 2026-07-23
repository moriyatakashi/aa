import { parse } from "./parser.js";
import { Interpreter, RunLimitError } from "./interpreter.js";

const SAMPLE_HELLO = `IDENTIFICATION DIVISION.
PROGRAM-ID. HELLOWORLD.
DATA DIVISION.
PROCEDURE DIVISION.
    DISPLAY "HELLO, WORLD!".
    STOP RUN.
`;

const SAMPLE_LOOP = `IDENTIFICATION DIVISION.
PROGRAM-ID. COUNTUP.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 WS-COUNT PIC 9(2) VALUE 0.
01 WS-LIMIT PIC 9(2) VALUE 5.
PROCEDURE DIVISION.
    MOVE 0 TO WS-COUNT.
    PERFORM UNTIL WS-COUNT = WS-LIMIT
        ADD 1 TO WS-COUNT.
        IF WS-COUNT = 3
            DISPLAY "COUNT = " WS-COUNT " (THREE!)"
        ELSE
            DISPLAY "COUNT = " WS-COUNT
        END-IF
    END-PERFORM.
    SUBTRACT 1 FROM WS-COUNT.
    DISPLAY "FINAL (COUNT-1) = " WS-COUNT.
    STOP RUN.
`;

const el = {
  source: document.getElementById("source"),
  btnCompile: document.getElementById("btn-compile"),
  btnRun: document.getElementById("btn-run"),
  btnReset: document.getElementById("btn-reset"),
  btnSampleHello: document.getElementById("btn-sample-hello"),
  btnSampleLoop: document.getElementById("btn-sample-loop"),
  status: document.getElementById("status"),
  errors: document.getElementById("errors"),
  programInfo: document.getElementById("program-info"),
  vars: document.getElementById("vars"),
  console: document.getElementById("console"),
};

let parseResult = null;
let interp = null;
let state = "none"; // none | ready | halted

function refreshVars() {
  el.vars.innerHTML = "";
  if (!interp) return;
  for (const [name, v] of interp.vars) {
    const label = document.createElement("label");
    label.textContent = name;
    const out = document.createElement("output");
    out.textContent = v.type === "numeric" ? String(v.value).padStart(v.width, "0") : `"${v.value}"`;
    el.vars.append(label, out);
  }
}

function consoleClear() {
  el.console.textContent = "";
}

function consoleWrite(text) {
  el.console.textContent += text;
  el.console.scrollTop = el.console.scrollHeight;
}

function renderErrors() {
  el.errors.innerHTML = "";
  if (!parseResult) return;
  for (const err of parseResult.errors) {
    const div = document.createElement("div");
    div.className = "error-line";
    div.textContent = err.message;
    el.errors.append(div);
  }
}

function renderProgramInfo() {
  if (!parseResult || !parseResult.ok) {
    el.programInfo.textContent = "";
    return;
  }
  const { name, vars, statements } = parseResult.program;
  el.programInfo.textContent = `PROGRAM-ID: ${name || "(未指定)"} / WORKING-STORAGE項目: ${vars.length}件 / PROCEDURE文: ${statements.length}件`;
}

function setState(next) {
  state = next;
  el.btnRun.disabled = !(state === "ready");
  el.btnReset.disabled = state === "none";

  const messages = {
    none: "ソースを編集して「コンパイル」を押してください。",
    ready: "コンパイル成功。「実行」で開始できます。",
    halted: "プログラムが終了しました。",
  };
  el.status.textContent = messages[state] ?? "";
}

function loadInterpreter() {
  interp = new Interpreter();
  interp.onOut = (text) => consoleWrite(text);
  interp.load(parseResult.program);
  consoleClear();
  refreshVars();
}

function doCompile() {
  parseResult = parse(el.source.value);
  renderErrors();
  renderProgramInfo();

  if (parseResult.ok) {
    loadInterpreter();
    setState("ready");
  } else {
    interp = null;
    refreshVars();
    setState("none");
  }
}

function doRun() {
  if (!interp) return;
  try {
    interp.run();
  } catch (e) {
    if (e instanceof RunLimitError) {
      el.status.textContent = e.message;
    } else {
      el.status.textContent = `実行時エラー: ${e.message}`;
    }
    refreshVars();
    setState("halted");
    return;
  }
  refreshVars();
  setState("halted");
}

function doReset() {
  if (!parseResult || !parseResult.ok) return;
  loadInterpreter();
  setState("ready");
}

function loadSample(text) {
  el.source.value = text;
  doCompile();
}

el.source.value = SAMPLE_HELLO;
setState("none");

el.btnCompile.addEventListener("click", doCompile);
el.btnRun.addEventListener("click", doRun);
el.btnReset.addEventListener("click", doReset);
el.btnSampleHello.addEventListener("click", () => loadSample(SAMPLE_HELLO));
el.btnSampleLoop.addEventListener("click", () => loadSample(SAMPLE_LOOP));
