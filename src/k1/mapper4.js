// ─── Mapper4 (MMC3) ───────────────────────────────────────────────────────
export class Mapper4 {
  constructor(rom) {
    this.rom=rom; this.prg=rom.prgRom; this.chr=rom.chrRom; this.chrRam=rom.chrRam;
    this.prgN=Math.max(1,this.prg.length>>13);
    const cl=(this.chr.length||0x2000);
    this.chrN=Math.max(1,cl>>10);
    this.bsel=0; this.regs=new Uint8Array(8);
    const last=this.prgN-1;
    this.pf1=last-1; this.pf2=last;
    this.irqCnt=0; this.irqLat=0; this.irqEnabled=false; this.irqPending=false;
  }
  cpuWrite(a,v){
    const even=(a&1)===0;
    if(a<=0x9FFF){
      if(even) this.bsel=v;
      else{const t=this.bsel&7;this.regs[t]=t<=1?(v&0xFE):v;}
    }else if(a<=0xBFFF){
      if(even) this.rom.mirrorVertical=(v&1)===0;
    }else if(a<=0xDFFF){
      if(even) this.irqCnt=v; else this.irqLat=v;
    }else{
      if(even){this.irqCnt=this.irqLat;this.irqEnabled=false;this.irqPending=false;}
      else this.irqEnabled=true;
    }
  }
  _prgBank(w){
    const m=(this.bsel>>6)&1,r=this.regs;
    const b=m===0?[r[6],r[7],this.pf1,this.pf2]:[this.pf1,r[7],r[6],this.pf2];
    return b[w]%this.prgN;
  }
  cpuRead(a){return this.prg[this._prgBank((a-0x8000)>>13)*0x2000+((a-0x8000)&0x1FFF)];}
  _chrBank(w){
    const m=(this.bsel>>7)&1,r=this.regs;
    const b=m===0?[r[0],r[0]+1,r[1],r[1]+1,r[2],r[3],r[4],r[5]]
                 :[r[2],r[3],r[4],r[5],r[0],r[0]+1,r[1],r[1]+1];
    return b[w]%this.chrN;
  }
  ppuReadChr(a){
    a&=0x1FFF; const bk=this._chrBank(a>>10),off=a&0x3FF;
    if(this.chrRam) return this.chrRam[bk*0x400+off];
    return this.chr.length?this.chr[bk*0x400+off]:0;
  }
  ppuWriteChr(a,v){
    if(this.chrRam){a&=0x1FFF;this.chrRam[this._chrBank(a>>10)*0x400+(a&0x3FF)]=v;}
  }
  hsync(line,rend){
    if(this.irqEnabled&&line<240&&rend){
      this.irqCnt=(this.irqCnt-1)&0xFF;
      if(this.irqCnt===0) this.irqPending=true;
    }
  }
}
