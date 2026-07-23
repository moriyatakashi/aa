import { assemble } from "./assembler.js";
import { X86, REG_NAMES } from "./x86.js";

const SAMPLE_HELLO = `; Hello, World! (Linux x86 int 0x80 システムコール規約)
section .data
    msg db "Hello, world!", 10   ; 10 = 改行

section .text
global _start

_start:
    mov eax, 4      ; sys_write
    mov ebx, 1      ; fd = stdout
    mov ecx, msg    ; 出力する文字列のアドレス
    mov edx, 14     ; 長さ(改行込み)
    int 0x80

    mov eax, 1      ; sys_exit
    mov ebx, 0      ; 終了コード
    int 0x80
`;

const SAMPLE_LOOP = `; ループ・条件分岐のサンプル: "*"を5回出力する
section .data
    star db "*", 0

section .text
global _start

_start:
    mov esi, 0          ; ループカウンタ

loop_top:
    cmp esi, 5
    jge loop_end

    mov eax, 4
    mov ebx, 1
    mov ecx, star
    mov edx, 1
    int 0x80

    add esi, 1
    jmp loop_top

loop_end:
    mov eax, 1
    mov ebx, 0
    int 0x80
`;

const MAX_RUN_STEPS = 200000;

const el = {
  source: document.getElementById("source"),
  btnAssemble: document.getElementById("btn-assemble"),
  btnRun: document.getElementById("btn-run"),
  btnStep: document.getElementById("btn-step"),
  btnReset: document.getElementById("btn-reset"),
  btnSampleHello: document.getElementById("btn-sample-hello"),
  btnSampleLoop: document.getElementById("btn-sample-loop"),
  status: document.getElementById("status"),
  errors: document.getElementById("errors"),
  regs: document.getElementById("regs"),
  flags: document.getElementById("flags"),
  console: document.getElementById("console"),
  listing: document.getElementById("listing"),
  memview: document.getElementById("memview"),
};

let assembleResult = null;
let vm = null;
let state = "none"; // none | ready | halted
let listingRows = [];
let currentRow = null;

function hex8(v) {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function buildRegsUI() {
  el.regs.innerHTML = "";
  for (const name of REG_NAMES) {
    const label = document.createElement("label");
    label.textContent = name;
    const out = document.createElement("output");
    out.id = `reg-${name}`;
    out.textContent = "--------";
    el.regs.append(label, out);
  }
  const label = document.createElement("label");
  label.textContent = "EIP";
  const out = document.createElement("output");
  out.id = "reg-EIP";
  out.textContent = "--------";
  el.regs.append(label, out);
}

function refreshRegs() {
  for (const name of REG_NAMES) {
    document.getElementById(`reg-${name}`).textContent = vm ? hex8(vm.reg[name]) : "--------";
  }
  document.getElementById("reg-EIP").textContent = vm ? String(vm.eip) : "--------";
  el.flags.textContent = vm ? `ZF=${vm.zf} SF=${vm.sf} CF=${vm.cf} OF=${vm.of}` : "ZF=- SF=- CF=- OF=-";
}

function refreshMemView() {
  el.memview.innerHTML = "";
  if (!vm || vm.memory.length === 0) return;
  const bytesPerRow = 8;
  for (let row = 0; row * bytesPerRow < vm.memory.length; row++) {
    const base = row * bytesPerRow;
    const label = document.createElement("label");
    label.textContent = String(base).padStart(4, "0");
    el.memview.append(label);
    let hexPart = "";
    let asciiPart = "";
    for (let col = 0; col < bytesPerRow; col++) {
      const addr = base + col;
      if (addr >= vm.memory.length) break;
      const b = vm.memory[addr];
      hexPart += b.toString(16).toUpperCase().padStart(2, "0") + " ";
      asciiPart += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    const out = document.createElement("output");
    out.textContent = `${hexPart} ${asciiPart}`;
    el.memview.append(out);
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
  listingRows = [];
  currentRow = null;
  if (!assembleResult) return;
  const lines = el.source.value.split(/\r\n|\r|\n/);

  for (let i = 0; i < assembleResult.listing.length; i++) {
    const entry = assembleResult.listing[i];
    const row = document.createElement("div");
    row.className = "listing-line";

    const addrSpan = document.createElement("span");
    addrSpan.className = "addr";
    if (entry && entry.kind === "code") {
      addrSpan.textContent = String(entry.index).padStart(3, "0");
      row.dataset.index = String(entry.index);
    } else if (entry && entry.kind === "data") {
      addrSpan.textContent = `+${entry.offset}`;
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

function highlightEip() {
  if (currentRow) currentRow.classList.remove("pr");
  currentRow = null;
  if (!vm) return;
  const row = listingRows.find((r) => r.dataset.index === String(vm.eip));
  if (row) {
    row.classList.add("pr");
    row.scrollIntoView({ block: "nearest" });
    currentRow = row;
  }
}

function setState(next) {
  state = next;
  el.btnRun.disabled = !(state === "ready");
  el.btnStep.disabled = !(state === "ready");
  el.btnReset.disabled = state === "none";

  const messages = {
    none: "ソースを編集して「アセンブル」を押してください。",
    ready: "アセンブル成功。「実行」または「ステップ」で開始できます。",
    halted: "プログラムが終了しました。",
  };
  el.status.textContent = messages[state] ?? "";
}

function loadVM() {
  vm = new X86();
  vm.load(assembleResult.instructions, assembleResult.dataBytes, assembleResult.entryIndex);
  vm.onOut = (str) => consoleWrite(str);
  consoleClear();
  refreshRegs();
  refreshMemView();
  highlightEip();
}

function doAssemble() {
  assembleResult = assemble(el.source.value);
  renderErrors();
  renderListing();

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
  highlightEip();
  if (!ok) {
    setState("halted");
    if (vm.error) el.status.textContent = `実行時エラー: ${vm.error}`;
    else if (vm.exitCode !== null) el.status.textContent = `プログラムが終了しました(終了コード ${vm.exitCode})。`;
  }
}

function doRun() {
  if (!vm || vm.halted) return;
  let steps = 0;
  while (!vm.halted && steps < MAX_RUN_STEPS) {
    if (!vm.step()) break;
    steps++;
  }
  refreshRegs();
  refreshMemView();
  highlightEip();
  if (steps >= MAX_RUN_STEPS && !vm.halted) {
    setState("halted");
    el.status.textContent = `ステップ数上限(${MAX_RUN_STEPS})に達したため停止しました(無限ループの可能性があります)。`;
    vm.halted = true;
    return;
  }
  setState("halted");
  if (vm.error) el.status.textContent = `実行時エラー: ${vm.error}`;
  else if (vm.exitCode !== null) el.status.textContent = `プログラムが終了しました(終了コード ${vm.exitCode})。`;
}

function doReset() {
  if (!assembleResult || !assembleResult.ok) return;
  loadVM();
  setState("ready");
}

function loadSample(text) {
  el.source.value = text;
  doAssemble();
}

buildRegsUI();
el.source.value = SAMPLE_HELLO;
setState("none");

el.btnAssemble.addEventListener("click", doAssemble);
el.btnRun.addEventListener("click", doRun);
el.btnStep.addEventListener("click", doStep);
el.btnReset.addEventListener("click", doReset);
el.btnSampleHello.addEventListener("click", () => loadSample(SAMPLE_HELLO));
el.btnSampleLoop.addEventListener("click", () => loadSample(SAMPLE_LOOP));
