// COMET II virtual machine: the register machine that CASL II object
// code runs on (JIS X 0004-2). 8 general registers (GR0-GR7), a stack
// pointer (SP), a program register (PR), and three flags (ZF/SF/OF)
// over a 64K x 16-bit memory space.

import { charCodeToJis8, jis8ToCharCode } from "./assembler.js";

function sxt(v) {
  v &= 0xffff;
  return v < 0x8000 ? v : v - 0x10000;
}

function zxt(v) {
  return v & 0xffff;
}

export class Comet2 extends EventTarget {
  constructor() {
    super();
    this.memory = new Uint16Array(65536);
    this.gr = new Uint16Array(8);
    this.sp = 0;
    this.pr = 0;
    this.zf = 0;
    this.sf = 0;
    this.of = 0;
    this.halted = true;
    this.error = null;
    this.callDepth = 0;
    // Set by callers to service SVC 1 (IN) synchronously; must return an
    // input string (possibly empty) or null for EOF/cancel.
    this.onIn = null;
    // Set by callers to service SVC 2 (OUT); receives the decoded string.
    this.onOut = null;
  }

  // Loads a memory image produced by assemble() and sets PR to entryPoint.
  // The bottom of the stack is seeded with a sentinel return address
  // (spInit) so that a top-level RET halts the machine, mirroring how a
  // real CASL II program is "CALL"ed by its host environment.
  load(memoryImage, entryPoint, spInit = 0xffff) {
    this.memory.set(memoryImage);
    this.gr.fill(0);
    this.sp = zxt(spInit - 1);
    this.memory[this.sp] = spInit;
    this.pr = entryPoint;
    this.zf = this.sf = this.of = 0;
    this.halted = false;
    this.error = null;
    this.callDepth = 0;
    this.spInit = spInit;
  }

  setFlagsLogical(value) {
    this.zf = (value & 0xffff) === 0 ? 1 : 0;
    this.sf = value & 0x8000 ? 1 : 0;
    this.of = 0;
  }

  setFlagsSignedArith(value) {
    this.zf = (value & 0xffff) === 0 ? 1 : 0;
    this.sf = value & 0x8000 ? 1 : 0;
    this.of = value < -32768 || value > 32767 ? 1 : 0;
  }

  setFlagsUnsignedArith(value) {
    this.zf = (value & 0xffff) === 0 ? 1 : 0;
    this.sf = value & 0x8000 ? 1 : 0;
    this.of = value < 0 || value > 65535 ? 1 : 0;
  }

  setFlagsCompare(a, b) {
    this.zf = a === b ? 1 : 0;
    this.sf = a < b ? 1 : 0;
    this.of = 0;
  }

  // Runs a single instruction. Returns false once the machine has halted
  // (including a normal top-level RET) or hit an error.
  step() {
    if (this.halted) return false;

    const word = this.memory[this.pr];
    const code = (word >>> 8) & 0xff;
    const grField = (word >>> 4) & 7;
    const xField = word & 7;

    let newPR = -1;
    let length = 1;

    const getEA = () => {
      length = 2;
      let addr = this.memory[zxt(this.pr + 1)];
      if (xField) addr += this.gr[xField];
      return zxt(addr);
    };

    switch (code) {
      case 0x00: // NOP
        break;

      case 0x10: // LD mem
        this.setFlagsLogical((this.gr[grField] = zxt(this.memory[getEA()])));
        break;
      case 0x14: // LD r,r
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[xField])));
        break;

      case 0x11: // ST
        this.memory[getEA()] = zxt(this.gr[grField]);
        break;

      case 0x12: // LAD
        this.gr[grField] = getEA();
        break;

      case 0x20: { // ADDA mem
        const r = sxt(this.gr[grField]) + sxt(this.memory[getEA()]);
        this.setFlagsSignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x24: { // ADDA r,r
        const r = sxt(this.gr[grField]) + sxt(this.gr[xField]);
        this.setFlagsSignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x21: { // SUBA mem
        const r = sxt(this.gr[grField]) - sxt(this.memory[getEA()]);
        this.setFlagsSignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x25: { // SUBA r,r
        const r = sxt(this.gr[grField]) - sxt(this.gr[xField]);
        this.setFlagsSignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x22: { // ADDL mem
        const r = zxt(this.gr[grField]) + zxt(this.memory[getEA()]);
        this.setFlagsUnsignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x26: { // ADDL r,r
        const r = zxt(this.gr[grField]) + zxt(this.gr[xField]);
        this.setFlagsUnsignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x23: { // SUBL mem
        const r = zxt(this.gr[grField]) - zxt(this.memory[getEA()]);
        this.setFlagsUnsignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }
      case 0x27: { // SUBL r,r
        const r = zxt(this.gr[grField]) - zxt(this.gr[xField]);
        this.setFlagsUnsignedArith(r);
        this.gr[grField] = zxt(r);
        break;
      }

      case 0x30: // AND mem
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] & this.memory[getEA()])));
        break;
      case 0x34: // AND r,r
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] & this.gr[xField])));
        break;
      case 0x31: // OR mem
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] | this.memory[getEA()])));
        break;
      case 0x35: // OR r,r
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] | this.gr[xField])));
        break;
      case 0x32: // XOR mem
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] ^ this.memory[getEA()])));
        break;
      case 0x36: // XOR r,r
        this.setFlagsLogical((this.gr[grField] = zxt(this.gr[grField] ^ this.gr[xField])));
        break;

      case 0x40: // CPA mem
        this.setFlagsCompare(sxt(this.gr[grField]), sxt(this.memory[getEA()]));
        break;
      case 0x44: // CPA r,r
        this.setFlagsCompare(sxt(this.gr[grField]), sxt(this.gr[xField]));
        break;
      case 0x41: // CPL mem
        this.setFlagsCompare(zxt(this.gr[grField]), zxt(this.memory[getEA()]));
        break;
      case 0x45: // CPL r,r
        this.setFlagsCompare(zxt(this.gr[grField]), zxt(this.gr[xField]));
        break;

      case 0x50: { // SLA
        const bits = getEA();
        const w = zxt(this.gr[grField]);
        if (bits === 0) {
          this.setFlagsLogical(w);
          break;
        }
        const sign = w & 0x8000;
        const shifted = w << bits;
        this.gr[grField] = sign | (shifted & 0x7fff);
        this.setFlagsLogical(this.gr[grField]);
        this.of = shifted & 0x8000 ? 1 : 0;
        break;
      }
      case 0x51: { // SRA
        const bits = getEA();
        const w = sxt(this.gr[grField]);
        if (bits === 0) {
          this.setFlagsLogical(zxt(w));
          break;
        }
        this.gr[grField] = zxt(w >> bits);
        this.setFlagsLogical(this.gr[grField]);
        this.of = (w >> (bits - 1)) & 1;
        break;
      }
      case 0x52: { // SLL
        const bits = getEA();
        const w = zxt(this.gr[grField]);
        if (bits === 0) {
          this.setFlagsLogical(w);
          break;
        }
        const shifted = w << bits;
        this.gr[grField] = zxt(shifted);
        this.setFlagsLogical(this.gr[grField]);
        this.of = shifted & 0x10000 ? 1 : 0;
        break;
      }
      case 0x53: { // SRL
        const bits = getEA();
        const w = zxt(this.gr[grField]);
        if (bits === 0) {
          this.setFlagsLogical(w);
          break;
        }
        this.gr[grField] = zxt(w >>> bits);
        this.setFlagsLogical(this.gr[grField]);
        this.of = (w >>> (bits - 1)) & 1;
        break;
      }

      case 0x61: // JMI
        if (this.sf) newPR = getEA();
        else length = 2;
        break;
      case 0x62: // JNZ
        if (!this.zf) newPR = getEA();
        else length = 2;
        break;
      case 0x63: // JZE
        if (this.zf) newPR = getEA();
        else length = 2;
        break;
      case 0x64: // JUMP
        newPR = getEA();
        break;
      case 0x65: // JPL
        if (!this.zf && !this.sf) newPR = getEA();
        else length = 2;
        break;
      case 0x66: // JOV
        if (this.of) newPR = getEA();
        else length = 2;
        break;

      case 0x70: { // PUSH
        const value = getEA();
        this.sp = zxt(this.sp - 1);
        this.memory[this.sp] = value;
        break;
      }
      case 0x71: // POP
        this.gr[grField] = zxt(this.memory[this.sp]);
        this.sp = zxt(this.sp + 1);
        break;

      case 0x80: // CALL
        newPR = getEA();
        this.sp = zxt(this.sp - 1);
        this.memory[this.sp] = zxt(this.pr + 2);
        this.callDepth++;
        break;
      case 0x81: // RET
        newPR = this.memory[this.sp];
        this.sp = zxt(this.sp + 1);
        this.callDepth--;
        break;

      case 0xf0: { // SVC
        const ea = getEA();
        if (ea === 1) this.serviceIn();
        else if (ea === 2) this.serviceOut();
        else {
          this.halted = true;
          this.error = `未定義の SVC です - ${ea}`;
        }
        break;
      }

      default:
        this.halted = true;
        this.error = `不正な命令コードです - ${code.toString(16).toUpperCase()}`;
        break;
    }

    if (this.halted) return false;

    if (newPR === this.spInit) {
      this.halted = true;
      this.dispatchEvent(new Event("terminated"));
      return false;
    }
    this.pr = newPR >= 0 ? newPR : zxt(this.pr + length);
    return true;
  }

  serviceIn() {
    const bufAddr = zxt(this.gr[1]);
    const lenAddr = zxt(this.gr[2]);
    const str = this.onIn ? this.onIn() : null;
    if (str === null || str === undefined) {
      this.memory[lenAddr] = 0xffff;
      return;
    }
    const len = Math.min(str.length, 256);
    for (let i = 0; i < len; i++) {
      const jis8 = charCodeToJis8(str.charCodeAt(i));
      this.memory[zxt(bufAddr + i)] = jis8 >= 0 ? jis8 : "?".charCodeAt(0);
    }
    this.memory[lenAddr] = len;
  }

  serviceOut() {
    const bufAddr = zxt(this.gr[1]);
    const lenAddr = zxt(this.gr[2]);
    const len = this.memory[lenAddr];
    const chars = [];
    for (let i = 0; i < len; i++) {
      const charCode = jis8ToCharCode(this.memory[zxt(bufAddr + i)]);
      chars.push(charCode >= 0 ? String.fromCharCode(charCode) : "?");
    }
    if (this.onOut) this.onOut(chars.join(""));
  }

  // Runs until halted, a breakpoint address is hit, or maxSteps is
  // reached (a safety valve against runaway/infinite loops).
  run(breakpoints = new Set(), maxSteps = 1_000_000) {
    let steps = 0;
    while (!this.halted && steps < maxSteps) {
      if (!this.step()) break;
      steps++;
      if (breakpoints.has(this.pr)) break;
    }
    return { halted: this.halted, steps, pr: this.pr };
  }
}
