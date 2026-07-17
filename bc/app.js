import { assemble } from "./assembler.js";
import { Comet2 } from "./comet2.js";

const REG_NAMES = ["GR0", "GR1", "GR2", "GR3", "GR4", "GR5", "GR6", "GR7", "SP", "PR", "ZF", "SF", "OF"];
const FLAG_NAMES = new Set(["ZF", "SF", "OF"]);

const SAMPLE_SOURCE = `; 「Hello, World!」の文字列を出力するプログラム
MAIN     START
         OUT    BUF,LEN         ; 文字列を出力
         RET                    ; 実行を終了
BUF      DC     'Hello, World!' ; 文字列
LEN      DC     13              ; 長さ
         END
`;

const el = {
  source: document.getElementById("source"),
  btnAssemble: document.getElementById("btn-assemble"),
  btnRun: document.getElementById("btn-run"),
  btnStep: document.getElementById("btn-step"),
  btnPause: document.getElementById("btn-pause"),
  btnReset: document.getElementById("btn-reset"),
  btnClearBp: document.getElementById("btn-clear-bp"),
  status: document.getElementById("status"),
  errors: document.getElementById("errors"),
  regs: document.getElementById("regs"),
  console: document.getElementById("console"),
  listing: document.getElementById("listing"),
  memAddr: document.getElementById("mem-addr"),
  btnMemShow: document.getElementById("btn-mem-show"),
  memview: document.getElementById("memview"),
};

let assembleResult = null;
let vm = null;
let breakpoints = new Set();
let radix = "hex";
let runFlag = false;
let state = "none"; // none | ready | break | halted | running
let addrToLine = new Map();
let listingRows = [];
let currentPRRow = null;

function hex4(v) {
  return (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function sxt(v) {
  v &= 0xffff;
  return v < 0x8000 ? v : v - 0x10000;
}

function formatWord(v) {
  if (radix === "hex") return hex4(v);
  if (radix === "unsigned") return String(v & 0xffff);
  return String(sxt(v));
}

function buildRegsUI() {
  el.regs.innerHTML = "";
  for (const name of REG_NAMES) {
    const label = document.createElement("label");
    label.textContent = name;
    label.htmlFor = `reg-${name}`;
    const out = document.createElement("output");
    out.id = `reg-${name}`;
    out.textContent = "----";
    el.regs.append(label, out);
  }
}

function refreshRegs() {
  if (!vm) {
    for (const name of REG_NAMES) document.getElementById(`reg-${name}`).textContent = "----";
    return;
  }
  for (let i = 0; i < 8; i++) {
    document.getElementById(`reg-GR${i}`).textContent = formatWord(vm.gr[i]);
  }
  document.getElementById("reg-SP").textContent = formatWord(vm.sp);
  document.getElementById("reg-PR").textContent = formatWord(vm.pr);
  document.getElementById("reg-ZF").textContent = String(vm.zf);
  document.getElementById("reg-SF").textContent = String(vm.sf);
  document.getElementById("reg-OF").textContent = String(vm.of);
}

function refreshMemView() {
  const base = parseInt(el.memAddr.value, 16);
  const start = Number.isNaN(base) ? 0 : base & 0xffff;
  el.memview.innerHTML = "";
  if (!vm) return;
  for (let row = 0; row < 4; row++) {
    const rowAddr = (start + row * 4) & 0xffff;
    const label = document.createElement("label");
    label.textContent = hex4(rowAddr);
    el.memview.append(label);
    for (let col = 0; col < 4; col++) {
      const out = document.createElement("output");
      out.textContent = formatWord(vm.memory[(rowAddr + col) & 0xffff]);
      el.memview.append(out);
    }
  }
}

function consoleClear() {
  el.console.textContent = "";
}

function consoleWrite(text) {
  el.console.textContent += text + "\n";
  el.console.scrollTop = el.console.scrollHeight;
}

function renderErrors() {
  el.errors.innerHTML = "";
  if (!assembleResult) return;
  for (const err of assembleResult.errors) {
    const div = document.createElement("div");
    div.className = "error-line";
    div.textContent = `${err.line + 1} 行目: ${err.message}`;
    div.addEventListener("click", () => jumpToSourceLine(err.line));
    el.errors.append(div);
  }
}

function jumpToSourceLine(line) {
  const lines = el.source.value.split(/\r\n|\r|\n/);
  let pos = 0;
  for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
  el.source.focus();
  el.source.setSelectionRange(pos, pos + (lines[line]?.length ?? 0));
}

function renderListing() {
  el.listing.innerHTML = "";
  addrToLine = new Map();
  listingRows = [];
  currentPRRow = null;

  if (!assembleResult) return;
  const lines = el.source.value.split(/\r\n|\r|\n/);

  for (let i = 0; i < assembleResult.listing.length; i++) {
    const entry = assembleResult.listing[i];
    const row = document.createElement("div");
    row.className = "listing-line";

    const addrSpan = document.createElement("span");
    addrSpan.className = "addr";
    if (entry) {
      addrSpan.textContent = hex4(entry.address);
      // START/END and other zero-length pseudo-op lines share their address
      // with the following real instruction; only the instruction itself
      // is a valid breakpoint/PR-highlight target.
      if (entry.length > 0) {
        row.classList.add("has-addr");
        row.dataset.address = String(entry.address);
        addrToLine.set(entry.address, row);
        row.addEventListener("click", () => toggleBreakpoint(entry.address));
      }
    } else {
      addrSpan.textContent = "";
    }

    const srcSpan = document.createElement("span");
    srcSpan.textContent = lines[i] ?? "";

    row.append(addrSpan, srcSpan);
    el.listing.append(row);
    listingRows.push(row);
  }
}

function toggleBreakpoint(address) {
  if (breakpoints.has(address)) breakpoints.delete(address);
  else breakpoints.add(address);
  const row = addrToLine.get(address);
  if (row) row.classList.toggle("breakpoint", breakpoints.has(address));
}

function clearBreakpoints() {
  breakpoints.clear();
  for (const row of listingRows) row.classList.remove("breakpoint");
}

function highlightPR() {
  if (currentPRRow) currentPRRow.classList.remove("pr");
  currentPRRow = null;
  if (!vm) return;
  const row = addrToLine.get(vm.pr);
  if (row) {
    row.classList.add("pr");
    row.scrollIntoView({ block: "nearest" });
    currentPRRow = row;
  }
}

function setState(next) {
  state = next;
  el.btnRun.disabled = !(state === "ready" || state === "break");
  el.btnStep.disabled = !(state === "ready" || state === "break");
  el.btnPause.disabled = state !== "running";
  el.btnReset.disabled = state === "none";
  el.btnClearBp.disabled = state === "none";

  const messages = {
    none: "ソースを編集して「アセンブル」を押してください。",
    ready: "アセンブル成功。「実行」または「ステップ」で開始できます。",
    break: "一時停止中です。",
    running: "実行中です。",
    halted: "プログラムが終了しました。",
  };
  el.status.textContent = messages[state] ?? "";
}

function loadVM() {
  vm = new Comet2();
  vm.load(assembleResult.memory, assembleResult.entryPoint);
  vm.onIn = () => window.prompt("IN 命令の入力内容 (キャンセルで EOF):", "");
  vm.onOut = (str) => consoleWrite(str);
  consoleClear();
  refreshRegs();
  refreshMemView();
  highlightPR();
}

function doAssemble() {
  runFlag = false;
  assembleResult = assemble(el.source.value);
  renderErrors();
  renderListing();
  breakpoints = new Set();

  if (assembleResult.ok) {
    loadVM();
    setState("ready");
  } else {
    vm = null;
    refreshRegs();
    setState("none");
  }
}

function doStep() {
  if (!vm || vm.halted) return;
  const ok = vm.step();
  refreshRegs();
  refreshMemView();
  highlightPR();
  if (!ok) {
    setState("halted");
    if (vm.error) el.status.textContent = `実行時エラー: ${vm.error}`;
  } else {
    setState("break");
  }
}

function doRun() {
  if (!vm || vm.halted) return;
  runFlag = true;
  setState("running");
  runLoop();
}

function runLoop() {
  if (!runFlag || !vm) return;

  let steps = 0;
  let hitBreakpoint = false;
  while (runFlag && !vm.halted && steps < 500) {
    if (!vm.step()) break;
    steps++;
    if (breakpoints.has(vm.pr)) {
      hitBreakpoint = true;
      break;
    }
  }

  refreshRegs();
  refreshMemView();
  highlightPR();

  if (vm.halted) {
    runFlag = false;
    setState("halted");
    if (vm.error) el.status.textContent = `実行時エラー: ${vm.error}`;
  } else if (hitBreakpoint) {
    runFlag = false;
    setState("break");
  } else if (runFlag) {
    setTimeout(runLoop, 0);
  } else {
    setState("break");
  }
}

function doPause() {
  runFlag = false;
}

function doReset() {
  if (!assembleResult || !assembleResult.ok) return;
  runFlag = false;
  loadVM();
  setState("ready");
}

buildRegsUI();
el.source.value = SAMPLE_SOURCE;
setState("none");

el.btnAssemble.addEventListener("click", doAssemble);
el.btnRun.addEventListener("click", doRun);
el.btnStep.addEventListener("click", doStep);
el.btnPause.addEventListener("click", doPause);
el.btnReset.addEventListener("click", doReset);
el.btnClearBp.addEventListener("click", clearBreakpoints);
el.btnMemShow.addEventListener("click", refreshMemView);
el.memAddr.addEventListener("keydown", (e) => {
  if (e.key === "Enter") refreshMemView();
});

for (const radio of document.querySelectorAll('input[name="radix"]')) {
  radio.addEventListener("change", (e) => {
    radix = e.target.value;
    refreshRegs();
    refreshMemView();
  });
}
