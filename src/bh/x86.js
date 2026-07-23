// 簡易 x86 仮想機械。実バイナリのx86命令セットではなく、assembler.jsが生成する
// 「機械語相当の内部表現」(命令オブジェクトの配列)を1個ずつ解釈するインタプリタ。
// 32bit汎用レジスタ8本 + ZF/SF/CF/OFフラグ + フラットなバイト列メモリ(dataセクション用)。

const REG_NAMES = ["EAX", "EBX", "ECX", "EDX", "ESI", "EDI", "EBP", "ESP"];

function toS32(x) {
  x = x >>> 0;
  return x >= 0x80000000 ? x - 0x100000000 : x;
}

export class X86 extends EventTarget {
  constructor() {
    super();
    this.reg = {};
    for (const name of REG_NAMES) this.reg[name] = 0;
    this.eip = 0;
    this.zf = 0;
    this.sf = 0;
    this.cf = 0;
    this.of = 0;
    this.memory = new Uint8Array(0);
    this.instructions = [];
    this.halted = true;
    this.error = null;
    this.exitCode = null;
    // int 0x80 (eax=4, sys_write)でmemoryの内容を文字列化して渡すコールバック。
    this.onOut = null;
  }

  // assemble()の戻り値をロードし、実行可能な状態にする。
  load(instructions, dataBytes, entryIndex) {
    this.instructions = instructions;
    this.memory = new Uint8Array(dataBytes);
    for (const name of REG_NAMES) this.reg[name] = 0;
    this.eip = entryIndex;
    this.zf = this.sf = this.cf = this.of = 0;
    this.halted = false;
    this.error = null;
    this.exitCode = null;
  }

  _setReg(name, value) {
    this.reg[name] = value >>> 0;
  }

  _readOperand(op) {
    if (op.kind === "reg") return this.reg[op.reg] >>> 0;
    return op.value >>> 0; // imm (定数、またはアセンブル時に解決済みのラベルアドレス)
  }

  _flagsAdd(a, b, result) {
    const r = result >>> 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = r & 0x80000000 ? 1 : 0;
    this.cf = (a >>> 0) + (b >>> 0) > 0xffffffff ? 1 : 0;
    const as = toS32(a),
      bs = toS32(b),
      rs = toS32(r);
    this.of = (as >= 0) === (bs >= 0) && (rs >= 0) !== (as >= 0) ? 1 : 0;
  }

  _flagsSub(a, b, result) {
    const r = result >>> 0;
    this.zf = r === 0 ? 1 : 0;
    this.sf = r & 0x80000000 ? 1 : 0;
    this.cf = (a >>> 0) < (b >>> 0) ? 1 : 0;
    const as = toS32(a),
      bs = toS32(b),
      rs = toS32(r);
    this.of = (as >= 0) !== (bs >= 0) && (rs >= 0) !== (as >= 0) ? 1 : 0;
  }

  // int 0x80 (Linux風システムコール規約のごく一部だけを再現)。
  // eax=4: sys_write(ebx=fd, ecx=バッファ先頭アドレス, edx=長さ) — memoryからASCII文字列を切り出しonOutへ。
  // eax=1: sys_exit(ebx=終了コード) — 実行を停止。
  _syscall() {
    const num = this.reg.EAX >>> 0;
    if (num === 4) {
      const addr = this.reg.ECX >>> 0;
      const len = this.reg.EDX >>> 0;
      const bytes = this.memory.slice(addr, addr + len);
      const str = Array.from(bytes)
        .map((b) => String.fromCharCode(b))
        .join("");
      if (this.onOut) this.onOut(str);
      return;
    }
    if (num === 1) {
      this.exitCode = this.reg.EBX | 0;
      this.halted = true;
      return;
    }
    this.error = `未対応のシステムコール番号です(eax=${num})。対応済みはeax=4(sys_write)とeax=1(sys_exit)のみ。`;
    this.halted = true;
  }

  // 命令を1個実行する。falseを返したら停止(正常終了またはエラー)。
  step() {
    if (this.halted) return false;
    const instr = this.instructions[this.eip];
    if (!instr) {
      // 命令列の終端まで来たら暗黙的に正常終了扱い。
      this.halted = true;
      return false;
    }
    this.eip++;
    try {
      switch (instr.op) {
        case "MOV": {
          const v = this._readOperand(instr.src);
          this._setReg(instr.dst.reg, v);
          break;
        }
        case "ADD": {
          const a = this.reg[instr.dst.reg] >>> 0;
          const b = this._readOperand(instr.src);
          const r = a + b;
          this._flagsAdd(a, b, r);
          this._setReg(instr.dst.reg, r);
          break;
        }
        case "SUB": {
          const a = this.reg[instr.dst.reg] >>> 0;
          const b = this._readOperand(instr.src);
          const r = a - b;
          this._flagsSub(a, b, r);
          this._setReg(instr.dst.reg, r);
          break;
        }
        case "CMP": {
          const a = this.reg[instr.dst.reg] >>> 0;
          const b = this._readOperand(instr.src);
          this._flagsSub(a, b, a - b);
          break;
        }
        case "JMP":
          this.eip = instr.target;
          break;
        case "JE":
          if (this.zf === 1) this.eip = instr.target;
          break;
        case "JNE":
          if (this.zf === 0) this.eip = instr.target;
          break;
        case "JL":
          if (this.sf !== this.of) this.eip = instr.target;
          break;
        case "JLE":
          if (this.zf === 1 || this.sf !== this.of) this.eip = instr.target;
          break;
        case "JG":
          if (this.zf === 0 && this.sf === this.of) this.eip = instr.target;
          break;
        case "JGE":
          if (this.sf === this.of) this.eip = instr.target;
          break;
        case "INT":
          this._syscall();
          break;
        case "NOP":
          break;
        default:
          this.error = `未実装の命令です: ${instr.op}`;
          this.halted = true;
      }
    } catch (e) {
      this.error = e.message;
      this.halted = true;
    }
    // 次回のstep()冒頭でthis.instructions[this.eip]が無ければ正常終了扱いになる
    // (JMPのターゲットはアセンブル時に既存ラベルへ解決済みのため、範囲外ジャンプは起きない)。
    return !this.halted;
  }
}

export { REG_NAMES };
