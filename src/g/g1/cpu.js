import { APU } from "./apu.js";
import { Mapper4 } from "./mapper4.js";

// ─── 6502 ステータスフラグ ────────────────────────────────────────────────
const FN=0x80,FV=0x40,FU=0x20,FB=0x10,FD=0x08,FI=0x04,FZ=0x02,FC=0x01;

// ─── 6502 CPU ─────────────────────────────────────────────────────────────
export class CPU {
  constructor(rom) {
    this.rom=rom; this.ppu=null;
    this.A=0; this.X=0; this.Y=0; this.S=0xFD; this.P=0x24; this.PC=0;
    this.cyc=7;
    this.ram=new Uint8Array(0x800);
    this.prgRam=new Uint8Array(0x2000);
    this.joy1=new Uint8Array(8); this.joy1Strobe=false; this.joy1Idx=0;
    this.apu=new APU();
    this.mapper=null;
    if (rom.mapper===4) {
      this.mapper=new Mapper4(rom);
    } else if (rom.mapper!==0) {
      throw new Error(`未対応 Mapper: ${rom.mapper}`);
    } else {
      const p=rom.prgRom;
      this.prg=p.length===16*1024 ? new Uint8Array([...p,...p]) : p;
    }
    this._znTab=new Uint8Array(256);
    this._znTab[0]=FZ;
    for(let i=1;i<256;i++) this._znTab[i]=i&FN;
    this._tbl={};
    this._buildTable();
    this.PC=this.get16(0xFFFC);
  }

  get(addr) {
    addr&=0xFFFF;
    if(addr<0x2000) return this.ram[addr&0x7FF];
    if(addr<0x4000) return this.ppu?this.ppu.readReg(addr&7):0;
    if(addr===0x4015) return this.apu.readStatus();
    if(addr===0x4016){
      if(this.joy1Idx>=8) return 1;
      const v=this.joy1[this.joy1Idx];
      if(!this.joy1Strobe) this.joy1Idx++;
      return v;
    }
    if(addr>=0x6000&&addr<0x8000) return this.prgRam[addr-0x6000];
    if(addr>=0x8000) return this.mapper?this.mapper.cpuRead(addr):this.prg[addr-0x8000];
    return 0;
  }

  set(addr,val) {
    addr&=0xFFFF; val&=0xFF;
    if(addr<0x2000){this.ram[addr&0x7FF]=val;return;}
    if(addr<0x4000){if(this.ppu)this.ppu.writeReg(addr&7,val);return;}
    if(addr<=0x4013){this.apu.writeReg(addr,val);return;}
    if(addr===0x4014){
      const base=val<<8;
      for(let i=0;i<256;i++) if(this.ppu) this.ppu.oam[(this.ppu.oamAddr+i)&0xFF]=this.get(base+i);
      this.cyc+=513; return;
    }
    if(addr===0x4015){this.apu.writeStatus(val);return;}
    if(addr===0x4016){this.joy1Strobe=(val&1)===1;if(this.joy1Strobe)this.joy1Idx=0;return;}
    if(addr===0x4017){this.apu.writeFrameCounter(val);return;}
    if(addr>=0x6000&&addr<0x8000){this.prgRam[addr-0x6000]=val;return;}
    if(addr>=0x8000&&this.mapper) this.mapper.cpuWrite(addr,val);
  }

  get16(a){return this.get(a)|(this.get(a+1)<<8);}
  push(v){this.ram[0x100+this.S]=v&0xFF;this.S=(this.S-1)&0xFF;}
  pop(){this.S=(this.S+1)&0xFF;return this.ram[0x100+this.S];}

  // アドレッシングモード
  aImm(){return this.PC++;}
  aZp(){return this.get(this.PC++);}
  aZpX(){return(this.aZp()+this.X)&0xFF;}
  aZpY(){return(this.aZp()+this.Y)&0xFF;}
  aAbs(){const a=this.get16(this.PC);this.PC+=2;return a;}
  aAbsX(chk=true){const b=this.aAbs(),a=(b+this.X)&0xFFFF;if(chk&&(a^b)&0x100)this.cyc++;return a;}
  aAbsY(chk=true){const b=this.aAbs(),a=(b+this.Y)&0xFFFF;if(chk&&(a^b)&0x100)this.cyc++;return a;}
  aIndX(){const t=(this.aZp()+this.X)&0xFF;return this.get(t)|(this.get((t+1)&0xFF)<<8);}
  aIndY(chk=true){const t=this.aZp(),b=this.get(t)|(this.get((t+1)&0xFF)<<8);const a=(b+this.Y)&0xFFFF;if(chk&&(a^b)&0x100)this.cyc++;return a;}

  // フラグ共通処理
  _zn(v){this.P=(this.P&~(FN|FZ))|this._znTab[v&0xFF];}
  _cmp(r,a){const m=this.get(a),x=(r-m)&0xFF;this.P=(this.P&~(FN|FZ|FC))|this._znTab[x]|(r>=m?FC:0);}
  _add(d){
    const c=this.P&FC,t=this.A+d+c;
    this.P&=0x3C;
    this.P|=((~(this.A^d)&(this.A^t)&0x80)>>1)&0xFF; // V
    this.P|=(t>>8)&1;                                   // C
    this.P|=this._znTab[t&0xFF];
    this.A=t&0xFF;
  }
  _br(cond){
    const d=this.get(this.PC);
    if(!cond){this.PC++;return;}
    const nxt=(this.PC+1)&0xFFFF,s=d>=128?d-256:d;
    this.PC=(nxt+s)&0xFFFF;
    this.cyc+=(nxt^this.PC)&0x100?2:1;
  }
  _asl(v){this.P=(this.P&~FC)|((v>>7)&1);v=(v<<1)&0xFF;this._zn(v);return v;}
  _lsr(v){this.P=(this.P&0x7C)|(v&1);v>>=1;this.P|=this._znTab[v];return v;}
  _rol(v){const c=v>>7;v=((v<<1)&0xFF)|(this.P&FC);this.P=(this.P&0x7C)|c|this._znTab[v];return v;}
  _ror(v){const c=v&1;v=(v>>1)|((this.P&FC)<<7);this.P=(this.P&0x7C)|c|this._znTab[v];return v;}

  triggerNMI(){
    this.push(this.PC>>8);this.push(this.PC&0xFF);
    this.push((this.P&~FB)|FU);
    this.P|=FI;this.PC=this.get16(0xFFFA);this.cyc+=7;
  }
  triggerIRQ(){
    if(this.P&FI) return;
    this.push(this.PC>>8);this.push(this.PC&0xFF);
    this.push((this.P&~FB)|FU);
    this.P|=FI;this.PC=this.get16(0xFFFE);this.cyc+=7;
  }

  _buildTable(){
    const t=this._tbl;
    // ── ロード/ストア ──
    const lda=a=>{this.A=this.get(a);this._zn(this.A);};
    const ldx=a=>{this.X=this.get(a);this._zn(this.X);};
    const ldy=a=>{this.Y=this.get(a);this._zn(this.Y);};
    const sta=a=>this.set(a,this.A);
    const stx=a=>this.set(a,this.X);
    const sty=a=>this.set(a,this.Y);
    t[0xA9]=[2,()=>lda(this.aImm())]; t[0xA5]=[3,()=>lda(this.aZp())];
    t[0xAD]=[4,()=>lda(this.aAbs())]; t[0xB5]=[4,()=>lda(this.aZpX())];
    t[0xBD]=[4,()=>lda(this.aAbsX())]; t[0xB9]=[4,()=>lda(this.aAbsY())];
    t[0xA1]=[6,()=>lda(this.aIndX())]; t[0xB1]=[5,()=>lda(this.aIndY())];
    t[0xA2]=[2,()=>ldx(this.aImm())]; t[0xA6]=[3,()=>ldx(this.aZp())];
    t[0xAE]=[4,()=>ldx(this.aAbs())]; t[0xB6]=[4,()=>ldx(this.aZpY())];
    t[0xBE]=[4,()=>ldx(this.aAbsY())];
    t[0xA0]=[2,()=>ldy(this.aImm())]; t[0xA4]=[3,()=>ldy(this.aZp())];
    t[0xAC]=[4,()=>ldy(this.aAbs())]; t[0xB4]=[4,()=>ldy(this.aZpX())];
    t[0xBC]=[4,()=>ldy(this.aAbsX())];
    t[0x85]=[3,()=>sta(this.aZp())]; t[0x8D]=[4,()=>sta(this.aAbs())];
    t[0x95]=[4,()=>sta(this.aZpX())]; t[0x9D]=[5,()=>sta(this.aAbsX(false))];
    t[0x99]=[5,()=>sta(this.aAbsY(false))]; t[0x81]=[6,()=>sta(this.aIndX())];
    t[0x91]=[6,()=>sta(this.aIndY(false))];
    t[0x86]=[3,()=>stx(this.aZp())]; t[0x8E]=[4,()=>stx(this.aAbs())]; t[0x96]=[4,()=>stx(this.aZpY())];
    t[0x84]=[3,()=>sty(this.aZp())]; t[0x8C]=[4,()=>sty(this.aAbs())]; t[0x94]=[4,()=>sty(this.aZpX())];

    // ── 算術・論理 ──
    const bit=a=>{const x=this.get(a);this.P=(this.P&0x3D)|(this._znTab[x&this.A]&FZ)|(x&0xC0);};
    const and=a=>{this.A&=this.get(a);this._zn(this.A);};
    const eor=a=>{this.A^=this.get(a);this._zn(this.A);};
    const ora=a=>{this.A|=this.get(a);this._zn(this.A);};
    const adc=a=>this._add(this.get(a));
    const sbc=a=>this._add((~this.get(a))&0xFF);
    const inc=a=>{const v=(this.get(a)+1)&0xFF;this._zn(v);this.set(a,v);};
    const dec=a=>{const v=(this.get(a)-1)&0xFF;this._zn(v);this.set(a,v);};
    t[0x24]=[3,()=>bit(this.aZp())]; t[0x2C]=[4,()=>bit(this.aAbs())];
    t[0x29]=[2,()=>and(this.aImm())]; t[0x25]=[3,()=>and(this.aZp())];
    t[0x2D]=[4,()=>and(this.aAbs())]; t[0x35]=[4,()=>and(this.aZpX())];
    t[0x3D]=[4,()=>and(this.aAbsX())]; t[0x39]=[4,()=>and(this.aAbsY())];
    t[0x21]=[6,()=>and(this.aIndX())]; t[0x31]=[5,()=>and(this.aIndY())];
    t[0x49]=[2,()=>eor(this.aImm())]; t[0x45]=[3,()=>eor(this.aZp())];
    t[0x4D]=[4,()=>eor(this.aAbs())]; t[0x55]=[4,()=>eor(this.aZpX())];
    t[0x5D]=[4,()=>eor(this.aAbsX())]; t[0x59]=[4,()=>eor(this.aAbsY())];
    t[0x41]=[6,()=>eor(this.aIndX())]; t[0x51]=[5,()=>eor(this.aIndY())];
    t[0x09]=[2,()=>ora(this.aImm())]; t[0x05]=[3,()=>ora(this.aZp())];
    t[0x0D]=[4,()=>ora(this.aAbs())]; t[0x15]=[4,()=>ora(this.aZpX())];
    t[0x1D]=[4,()=>ora(this.aAbsX())]; t[0x19]=[4,()=>ora(this.aAbsY())];
    t[0x01]=[6,()=>ora(this.aIndX())]; t[0x11]=[5,()=>ora(this.aIndY())];
    t[0xC9]=[2,()=>this._cmp(this.A,this.aImm())]; t[0xC5]=[3,()=>this._cmp(this.A,this.aZp())];
    t[0xCD]=[4,()=>this._cmp(this.A,this.aAbs())]; t[0xD5]=[4,()=>this._cmp(this.A,this.aZpX())];
    t[0xDD]=[4,()=>this._cmp(this.A,this.aAbsX())]; t[0xD9]=[4,()=>this._cmp(this.A,this.aAbsY())];
    t[0xC1]=[6,()=>this._cmp(this.A,this.aIndX())]; t[0xD1]=[5,()=>this._cmp(this.A,this.aIndY())];
    t[0xE0]=[2,()=>this._cmp(this.X,this.aImm())]; t[0xE4]=[3,()=>this._cmp(this.X,this.aZp())]; t[0xEC]=[4,()=>this._cmp(this.X,this.aAbs())];
    t[0xC0]=[2,()=>this._cmp(this.Y,this.aImm())]; t[0xC4]=[3,()=>this._cmp(this.Y,this.aZp())]; t[0xCC]=[4,()=>this._cmp(this.Y,this.aAbs())];
    t[0x69]=[2,()=>adc(this.aImm())]; t[0x65]=[3,()=>adc(this.aZp())];
    t[0x6D]=[4,()=>adc(this.aAbs())]; t[0x75]=[4,()=>adc(this.aZpX())];
    t[0x7D]=[4,()=>adc(this.aAbsX())]; t[0x79]=[4,()=>adc(this.aAbsY())];
    t[0x61]=[6,()=>adc(this.aIndX())]; t[0x71]=[5,()=>adc(this.aIndY())];
    t[0xE9]=[2,()=>sbc(this.aImm())]; t[0xEB]=[2,()=>sbc(this.aImm())];
    t[0xE5]=[3,()=>sbc(this.aZp())]; t[0xED]=[4,()=>sbc(this.aAbs())];
    t[0xF5]=[4,()=>sbc(this.aZpX())]; t[0xFD]=[4,()=>sbc(this.aAbsX())];
    t[0xF9]=[4,()=>sbc(this.aAbsY())]; t[0xE1]=[6,()=>sbc(this.aIndX())]; t[0xF1]=[5,()=>sbc(this.aIndY())];
    t[0xE6]=[5,()=>inc(this.aZp())]; t[0xEE]=[6,()=>inc(this.aAbs())];
    t[0xF6]=[6,()=>inc(this.aZpX())]; t[0xFE]=[7,()=>inc(this.aAbsX(false))];
    t[0xC6]=[5,()=>dec(this.aZp())]; t[0xCE]=[6,()=>dec(this.aAbs())];
    t[0xD6]=[6,()=>dec(this.aZpX())]; t[0xDE]=[7,()=>dec(this.aAbsX(false))];
    t[0xE8]=[2,()=>{this.X=(this.X+1)&0xFF;this._zn(this.X);}];
    t[0xC8]=[2,()=>{this.Y=(this.Y+1)&0xFF;this._zn(this.Y);}];
    t[0xCA]=[2,()=>{this.X=(this.X-1)&0xFF;this._zn(this.X);}];
    t[0x88]=[2,()=>{this.Y=(this.Y-1)&0xFF;this._zn(this.Y);}];

    // ── シフト・ローテート ──
    const aslM=a=>this.set(a,this._asl(this.get(a)));
    const lsrM=a=>this.set(a,this._lsr(this.get(a)));
    const rolM=a=>this.set(a,this._rol(this.get(a)));
    const rorM=a=>this.set(a,this._ror(this.get(a)));
    t[0x0A]=[2,()=>{this.A=this._asl(this.A);}];
    t[0x06]=[5,()=>aslM(this.aZp())]; t[0x0E]=[6,()=>aslM(this.aAbs())];
    t[0x16]=[6,()=>aslM(this.aZpX())]; t[0x1E]=[7,()=>aslM(this.aAbsX(false))];
    t[0x4A]=[2,()=>{this.A=this._lsr(this.A);}];
    t[0x46]=[5,()=>lsrM(this.aZp())]; t[0x4E]=[6,()=>lsrM(this.aAbs())];
    t[0x56]=[6,()=>lsrM(this.aZpX())]; t[0x5E]=[7,()=>lsrM(this.aAbsX(false))];
    t[0x2A]=[2,()=>{this.A=this._rol(this.A);}];
    t[0x26]=[5,()=>rolM(this.aZp())]; t[0x2E]=[6,()=>rolM(this.aAbs())];
    t[0x36]=[6,()=>rolM(this.aZpX())]; t[0x3E]=[7,()=>rolM(this.aAbsX(false))];
    t[0x6A]=[2,()=>{this.A=this._ror(this.A);}];
    t[0x66]=[5,()=>rorM(this.aZp())]; t[0x6E]=[6,()=>rorM(this.aAbs())];
    t[0x76]=[6,()=>rorM(this.aZpX())]; t[0x7E]=[7,()=>rorM(this.aAbsX(false))];

    // ── 分岐・ジャンプ ──
    t[0x10]=[2,()=>this._br((this.P&FN)===0)]; t[0x30]=[2,()=>this._br((this.P&FN)!==0)];
    t[0x50]=[2,()=>this._br((this.P&FV)===0)]; t[0x70]=[2,()=>this._br((this.P&FV)!==0)];
    t[0x90]=[2,()=>this._br((this.P&FC)===0)]; t[0xB0]=[2,()=>this._br((this.P&FC)!==0)];
    t[0xD0]=[2,()=>this._br((this.P&FZ)===0)]; t[0xF0]=[2,()=>this._br((this.P&FZ)!==0)];
    t[0x4C]=[3,()=>{this.PC=this.aAbs();}];
    t[0x6C]=[5,()=>{const a=this.aAbs(),b=((a+1)&0xFF)|(a&0xFF00);this.PC=this.get(a)|(this.get(b)<<8);}]; // ページ境界バグ再現
    t[0x20]=[6,()=>{const r=(this.PC+1)&0xFFFF;this.push(r>>8);this.push(r&0xFF);this.PC=this.aAbs();}];
    t[0x60]=[6,()=>{const lo=this.pop(),hi=this.pop();this.PC=((hi<<8)|lo)+1;}];
    t[0x40]=[6,()=>{
      this.P=(this.pop()&~FB&0xFF)|FU; // RTI: Break捨て、Unused=1
      const lo=this.pop(),hi=this.pop();this.PC=(hi<<8)|lo;
    }];

    // ── スタック ──
    t[0x48]=[3,()=>this.push(this.A)];
    t[0x08]=[3,()=>this.push(this.P|0x30)]; // PHP: B+Unusedを立てて push
    t[0x68]=[4,()=>{this.A=this.pop();this._zn(this.A);}];
    t[0x28]=[4,()=>{this.P=(this.pop()&~FB&0xFF)|FU;}]; // PLP: Break捨て、Unused=1

    // ── フラグ ──
    t[0x38]=[2,()=>{this.P|=FC;}];  t[0x18]=[2,()=>{this.P&=~FC&0xFF;}]; // SEC / CLC（faithjs本家の上書きバグを再現しない）
    t[0x78]=[2,()=>{this.P|=FI;}];  t[0x58]=[2,()=>{this.P&=~FI&0xFF;}]; // SEI / CLI
    t[0xF8]=[2,()=>{this.P|=FD;}];  t[0xD8]=[2,()=>{this.P&=~FD&0xFF;}]; // SED / CLD
    t[0xB8]=[2,()=>{this.P&=~FV&0xFF;}];                                   // CLV

    // ── レジスタ間転送 ──
    t[0xAA]=[2,()=>{this.X=this.A;this._zn(this.X);}]; // TAX
    t[0xA8]=[2,()=>{this.Y=this.A;this._zn(this.Y);}]; // TAY
    t[0x8A]=[2,()=>{this.A=this.X;this._zn(this.A);}]; // TXA
    t[0x98]=[2,()=>{this.A=this.Y;this._zn(this.A);}]; // TYA
    t[0xBA]=[2,()=>{this.X=this.S;this._zn(this.X);}]; // TSX
    t[0x9A]=[2,()=>{this.S=this.X;}];                   // TXS（フラグ変化なし）

    // ── NOP ──
    const nop=()=>{};
    t[0xEA]=[2,nop];
    [0x1A,0x3A,0x5A,0x7A,0xDA,0xFA].forEach(o=>t[o]=[2,nop]);
    [0x80,0x82,0x89,0xC2,0xE2].forEach(o=>t[o]=[2,()=>this.aImm()]);
    [0x04,0x44,0x64].forEach(o=>t[o]=[3,()=>this.aZp()]);
    [0x14,0x34,0x54,0x74,0xD4,0xF4].forEach(o=>t[o]=[4,()=>this.aZpX()]);
    t[0x0C]=[4,()=>this.aAbs()];
    [0x1C,0x3C,0x5C,0x7C,0xDC,0xFC].forEach(o=>t[o]=[4,()=>this.aAbsX()]);

    // ── 非公式命令（illegal opcode） ──
    const lax=a=>{this.A=this.X=this.get(a);this._zn(this.A);};
    const sax=a=>this.set(a,this.A&this.X);
    const dcp=a=>{const v=(this.get(a)-1)&0xFF,r=(this.A-v)&0xFF;
      this.P=(this.P&~(FN|FZ|FC))|this._znTab[r]|(this.A>=v?FC:0);this.set(a,v);};
    const isb=a=>{const v=(this.get(a)+1)&0xFF;this._add(~v&0xFF);this.set(a,v);};
    const slo=a=>{let v=this.get(a);this.P=(this.P&~FC)|((v>>7)&1);v=(v<<1)&0xFF;
      this.A|=v;this._zn(this.A);this.set(a,v);};
    const rla=a=>{const v=this.get(a),c=v>>7,s=((v<<1)&0xFF)|(this.P&FC);
      this.P=(this.P&~FC)|c;this.A=(this.A&s)&0xFF;this._zn(this.A);this.set(a,s);};
    const sre=a=>{let v=this.get(a);this.P=(this.P&~FC)|(v&1);v>>=1;
      this.A^=v;this._zn(this.A);this.set(a,v);};
    const rra=a=>{let v=this.get(a),c=v&1;v=(v>>1)|((this.P&FC)<<7);
      this.P=(this.P&~FC)|c;this._add(v);this.set(a,v);};
    t[0xA3]=[6,()=>lax(this.aIndX())]; t[0xA7]=[3,()=>lax(this.aZp())];
    t[0xAF]=[4,()=>lax(this.aAbs())];  t[0xB3]=[5,()=>lax(this.aIndY())];
    t[0xB7]=[4,()=>lax(this.aZpY())];  t[0xBF]=[4,()=>lax(this.aAbsY())];
    t[0x83]=[6,()=>sax(this.aIndX())]; t[0x87]=[3,()=>sax(this.aZp())];
    t[0x8F]=[4,()=>sax(this.aAbs())];  t[0x97]=[4,()=>sax(this.aZpY())];
    t[0xC3]=[8,()=>dcp(this.aIndX())]; t[0xC7]=[5,()=>dcp(this.aZp())];
    t[0xCF]=[6,()=>dcp(this.aAbs())];  t[0xD3]=[8,()=>dcp(this.aIndY(false))];
    t[0xD7]=[6,()=>dcp(this.aZpX())];  t[0xDB]=[7,()=>dcp(this.aAbsY(false))];
    t[0xDF]=[7,()=>dcp(this.aAbsX(false))];
    t[0xE3]=[8,()=>isb(this.aIndX())]; t[0xE7]=[5,()=>isb(this.aZp())];
    t[0xEF]=[6,()=>isb(this.aAbs())];  t[0xF3]=[8,()=>isb(this.aIndY(false))];
    t[0xF7]=[6,()=>isb(this.aZpX())];  t[0xFB]=[7,()=>isb(this.aAbsY(false))];
    t[0xFF]=[7,()=>isb(this.aAbsX(false))];
    t[0x03]=[8,()=>slo(this.aIndX())]; t[0x07]=[5,()=>slo(this.aZp())];
    t[0x0F]=[6,()=>slo(this.aAbs())];  t[0x13]=[8,()=>slo(this.aIndY(false))];
    t[0x17]=[6,()=>slo(this.aZpX())];  t[0x1B]=[7,()=>slo(this.aAbsY(false))];
    t[0x1F]=[7,()=>slo(this.aAbsX(false))];
    t[0x23]=[8,()=>rla(this.aIndX())]; t[0x27]=[5,()=>rla(this.aZp())];
    t[0x2F]=[6,()=>rla(this.aAbs())];  t[0x33]=[8,()=>rla(this.aIndY(false))];
    t[0x37]=[6,()=>rla(this.aZpX())];  t[0x3B]=[7,()=>rla(this.aAbsY(false))];
    t[0x3F]=[7,()=>rla(this.aAbsX(false))];
    t[0x43]=[8,()=>sre(this.aIndX())]; t[0x47]=[5,()=>sre(this.aZp())];
    t[0x4F]=[6,()=>sre(this.aAbs())];  t[0x53]=[8,()=>sre(this.aIndY(false))];
    t[0x57]=[6,()=>sre(this.aZpX())];  t[0x5B]=[7,()=>sre(this.aAbsY(false))];
    t[0x5F]=[7,()=>sre(this.aAbsX(false))];
    t[0x63]=[8,()=>rra(this.aIndX())]; t[0x67]=[5,()=>rra(this.aZp())];
    t[0x6F]=[6,()=>rra(this.aAbs())];  t[0x73]=[8,()=>rra(this.aIndY(false))];
    t[0x77]=[6,()=>rra(this.aZpX())];  t[0x7B]=[7,()=>rra(this.aAbsY(false))];
    t[0x7F]=[7,()=>rra(this.aAbsX(false))];
  }

  step() {
    const op=this.get(this.PC++);
    const e=this._tbl[op];
    if(!e) throw new Error(`未実装オペコード: 0x${op.toString(16).padStart(2,'0')} PC=0x${(this.PC-1).toString(16).padStart(4,'0')}`);
    e[1](); this.cyc+=e[0];
  }
}
