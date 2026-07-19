// ─── PPU (2C02) ───────────────────────────────────────────────────────────
export class PPU {
  constructor(rom,mapper){
    this.rom=rom; this.mapper=mapper;
    this.nt=[new Uint8Array(0x400),new Uint8Array(0x400)];
    this.pal=new Uint8Array(0x20);
    this.oam=new Uint8Array(0x100);
    this.ctrl=0; this.mask=0; this.status=0; this.oamAddr=0;
    this.ppuAddr=0; this.addrLatch=false; this.readBuf=0;
    this.scrollX=0; this.scrollY=0;
    this.totalDots=0; this.nmiPending=false;
    this.fb=new Uint8Array(256*240);
    this._bgOpaque=new Uint8Array(256*240); // スプライト優先度(奥/手前)判定用
  }
  tick(cyc){
    const pl=Math.floor(this.totalDots/341);
    this.totalDots+=cyc*3;
    const nl=Math.floor(this.totalDots/341);
    for(let n=pl+1;n<=nl;n++){
      const line=n%262;
      if(line<240){ this._scanline(line); this._spriteLine(line); }
      if(this.mapper) this.mapper.hsync(line,(this.mask&0x08)!==0);
      if(line===241){this.status|=0x80;if(this.ctrl&0x80)this.nmiPending=true;}
      else if(line===261) this.status&=0x1F;
    }
  }
  _scanline(line){
    if(!(this.mask&0x08)) return;
    const baseNt=this.ctrl&3, bgBase=(this.ctrl&0x10)?0x1000:0;
    let absY=this.scrollY+line, ntYFlip=0;
    if(absY>=240){ absY-=240; ntYFlip=1; }
    const tileRow=absY>>3, fineY=absY&7;

    let lastTileCol=-1, lastNt=-1, pg=0, p0=0, p1=0;
    for(let sx=0;sx<256;sx++){
      let absX=this.scrollX+sx, ntXFlip=0;
      if(absX>=256){ absX-=256; ntXFlip=1; }
      const tileCol=absX>>3, fineX=absX&7;
      const ntIndex=baseNt^ntXFlip^(ntYFlip<<1);

      if(tileCol!==lastTileCol || ntIndex!==lastNt){
        const ti=this.ppuGet(0x2000+ntIndex*0x400+tileRow*32+tileCol);
        const adr=0x2000+ntIndex*0x400+0x3C0+Math.floor(tileRow/4)*8+Math.floor(tileCol/4);
        const attr=this.ppuGet(adr);
        const q=(Math.floor((tileRow%4)/2)*2)+Math.floor((tileCol%4)/2);
        pg=(attr>>(q*2))&3;
        const ta=bgBase+ti*16;
        p0=this.ppuGet(ta+fineY); p1=this.ppuGet(ta+8+fineY);
        lastTileCol=tileCol; lastNt=ntIndex;
      }
      const b0=(p0>>(7-fineX))&1, b1=(p1>>(7-fineX))&1, ci=b0|(b1<<1);
      const pal=ci===0?this.pal[0]:this.pal[pg*4+ci];
      const idx=line*256+sx;
      this.fb[idx]=pal; this._bgOpaque[idx]=ci!==0?1:0;
    }
  }
  _spriteLine(line){
    if(!(this.mask&0x10)) return; // スプライト表示OFF
    const size16=(this.ctrl&0x20)!==0;
    const spH=size16?16:8;
    const spBase=(this.ctrl&0x08)?0x1000:0; // 8x8時のパターンテーブル選択
    const active=[];
    for(let i=0;i<64;i++){
      const sy=this.oam[i*4]+1; // NESのスプライトYは1行遅れる
      if(line>=sy && line<sy+spH){
        active.push(i);
        if(active.length>=8) break; // 1ライン最大8枚（実機と同じ制限）
      }
    }
    // OAMの若い番号ほど手前に描く => 後ろ(番号大)から先に描いて上書きさせる
    for(let k=active.length-1;k>=0;k--){
      const i=active[k];
      const base=i*4;
      const sy=this.oam[base]+1;
      const tile=this.oam[base+1];
      const attr=this.oam[base+2];
      const sx=this.oam[base+3];
      const vflip=(attr&0x80)!==0, hflip=(attr&0x40)!==0, behind=(attr&0x20)!==0;
      const pal=attr&3;
      let row=line-sy;
      if(vflip) row=spH-1-row;
      let ta;
      if(size16){
        const table=(tile&1)?0x1000:0;
        let tileIdx=tile&0xFE;
        if(row>=8){tileIdx+=1;row-=8;}
        ta=table+tileIdx*16;
      }else{
        ta=spBase+tile*16;
      }
      const p0=this.ppuGet(ta+row), p1=this.ppuGet(ta+8+row);
      for(let x=0;x<8;x++){
        const bx=hflip?x:(7-x);
        const b0=(p0>>bx)&1, b1=(p1>>bx)&1, ci=b0|(b1<<1);
        if(ci===0) continue; // 透明
        const px=sx+x;
        if(px<0||px>=256) continue;
        const idx=line*256+px;
        if(i===0 && this._bgOpaque[idx] && px!==255){
          this.status|=0x40; // スプライト0ヒット
        }
        if(behind && this._bgOpaque[idx]) continue; // 背景の後ろに隠れる
        this.fb[idx]=this.pal[0x10+pal*4+ci];
      }
    }
  }
  _ntBank(n){return this.rom.mirrorVertical?(n&1):(n>>1);}
  _palIdx(a){let p=a&0x1F;if((p&3)===0&&p>=0x10)p&=~0x10;return p;} // $3F10→$3F00 ミラー
  ppuGet(a){
    a&=0x3FFF;
    if(a<0x2000){
      if(this.mapper) return this.mapper.ppuReadChr(a);
      if(this.rom.chrRam) return this.rom.chrRam[a];
      return this.rom.chrRom[a]||0;
    }
    if(a<0x3F00){const r=(a-0x2000)&0x0FFF;return this.nt[this._ntBank(r>>10)][r&0x3FF];}
    return this.pal[this._palIdx(a)];
  }
  ppuSet(a,v){
    a&=0x3FFF; v&=0xFF;
    if(a<0x2000){
      if(this.mapper) this.mapper.ppuWriteChr(a,v);
      else if(this.rom.chrRam) this.rom.chrRam[a]=v;
    }else if(a<0x3F00){const r=(a-0x2000)&0x0FFF;this.nt[this._ntBank(r>>10)][r&0x3FF]=v;}
    else this.pal[this._palIdx(a)]=v;
  }
  readReg(r){
    if(r===2){const v=this.status;this.status&=0x7F;this.addrLatch=false;return v;}
    if(r===4) return this.oam[this.oamAddr];
    if(r===7){
      const a=this.ppuAddr&0x3FFF; let v;
      if(a<0x3F00){v=this.readBuf;this.readBuf=this.ppuGet(a);}
      else{v=this.ppuGet(a);this.readBuf=this.ppuGet(a-0x1000);}
      this.ppuAddr=(this.ppuAddr+((this.ctrl&4)?32:1))&0x7FFF;
      return v;
    }
    return 0;
  }
  writeReg(r,v){
    v&=0xFF;
    if(r===0) this.ctrl=v;
    else if(r===1) this.mask=v;
    else if(r===3) this.oamAddr=v;
    else if(r===4){this.oam[this.oamAddr]=v;this.oamAddr=(this.oamAddr+1)&0xFF;}
    else if(r===5){
      if(!this.addrLatch) this.scrollX=v; else this.scrollY=v;
      this.addrLatch=!this.addrLatch;
    }
    else if(r===6){
      if(!this.addrLatch) this.ppuAddr=(this.ppuAddr&0x00FF)|((v&0x3F)<<8);
      else this.ppuAddr=(this.ppuAddr&0xFF00)|v;
      this.addrLatch=!this.addrLatch;
    }else if(r===7){
      this.ppuSet(this.ppuAddr&0x3FFF,v);
      this.ppuAddr=(this.ppuAddr+((this.ctrl&4)?32:1))&0x7FFF;
    }
  }
}
