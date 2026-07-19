// ─── APU (2A03) ── Pulse×2 / Triangle / Noise（DMCは未実装） ──────────────
const LEN_TABLE=[10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_PERIOD=[4,8,16,32,64,96,128,160,202,254,380,508,762,1016,1524,2034];
const DUTY_SEQ=[[0,1,0,0,0,0,0,0],[0,1,1,0,0,0,0,0],[0,1,1,1,1,0,0,0],[1,0,0,1,1,1,1,1]];
const TRI_SEQ=[15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];

export class APU{
  constructor(){
    this.p1=this._newPulse(); this.p2=this._newPulse();
    this.tri={timer:0,period:0,linearCounter:0,linearReload:0,linearReloadFlag:false,ctrlHalt:false,lengthCounter:0,seq:0,enabled:false};
    this.noise={timer:0,period:NOISE_PERIOD[0],shift:1,mode:false,volume:0,constVol:true,decay:0,envStart:false,envDivider:0,envLoop:false,lengthHalt:false,lengthCounter:0,enabled:false};
    this.frameCyc=0; this.frameStep=0; this.mode5=false; this.irqInhibit=true; this.frameIRQ=false;
    this.cpuCycleAcc=0;
  }
  _newPulse(){
    return {duty:0,dutyPos:0,timer:0,period:0,volume:0,constVol:true,decay:0,envStart:false,envDivider:0,envLoop:false,
      lengthHalt:false,lengthCounter:0,sweepEnabled:false,sweepPeriod:0,sweepNegate:false,sweepShift:0,sweepReload:false,sweepDivider:0,enabled:false};
  }
  writeReg(addr,v){
    if(addr<=0x4003) this._writePulse(this.p1,addr&3,v,false);
    else if(addr<=0x4007) this._writePulse(this.p2,addr&3,v,true);
    else if(addr<=0x400B) this._writeTriangle(addr&3,v);
    else if(addr<=0x400F) this._writeNoise(addr&3,v);
  }
  _writePulse(p,reg,v,isP2){
    p._isP2=isP2;
    if(reg===0){
      p.duty=(v>>6)&3; p.lengthHalt=(v&0x20)!==0; p.envLoop=p.lengthHalt;
      p.constVol=(v&0x10)!==0; p.volume=v&0xF;
    }else if(reg===1){
      p.sweepEnabled=(v&0x80)!==0; p.sweepPeriod=(v>>4)&7; p.sweepNegate=(v&8)!==0; p.sweepShift=v&7; p.sweepReload=true;
    }else if(reg===2){
      p.period=(p.period&0x700)|v;
    }else if(reg===3){
      p.period=(p.period&0xFF)|((v&7)<<8);
      if(p.enabled) p.lengthCounter=LEN_TABLE[v>>3];
      p.dutyPos=0; p.envStart=true;
    }
  }
  _writeTriangle(reg,v){
    const t=this.tri;
    if(reg===0){ t.ctrlHalt=(v&0x80)!==0; t.linearReload=v&0x7F; }
    else if(reg===2){ t.period=(t.period&0x700)|v; }
    else if(reg===3){ t.period=(t.period&0xFF)|((v&7)<<8); t.linearReloadFlag=true; if(t.enabled) t.lengthCounter=LEN_TABLE[v>>3]; }
  }
  _writeNoise(reg,v){
    const n=this.noise;
    if(reg===0){ n.lengthHalt=(v&0x20)!==0; n.envLoop=n.lengthHalt; n.constVol=(v&0x10)!==0; n.volume=v&0xF; }
    else if(reg===2){ n.mode=(v&0x80)!==0; n.period=NOISE_PERIOD[v&0xF]; }
    else if(reg===3){ if(n.enabled) n.lengthCounter=LEN_TABLE[v>>3]; n.envStart=true; }
  }
  writeStatus(v){
    this.p1.enabled=(v&1)!==0; if(!this.p1.enabled) this.p1.lengthCounter=0;
    this.p2.enabled=(v&2)!==0; if(!this.p2.enabled) this.p2.lengthCounter=0;
    this.tri.enabled=(v&4)!==0; if(!this.tri.enabled) this.tri.lengthCounter=0;
    this.noise.enabled=(v&8)!==0; if(!this.noise.enabled) this.noise.lengthCounter=0;
    // DMC(bit4)は未実装
  }
  readStatus(){
    let v=0;
    if(this.p1.lengthCounter>0) v|=1;
    if(this.p2.lengthCounter>0) v|=2;
    if(this.tri.lengthCounter>0) v|=4;
    if(this.noise.lengthCounter>0) v|=8;
    if(this.frameIRQ) v|=0x40;
    this.frameIRQ=false;
    return v;
  }
  writeFrameCounter(v){
    this.mode5=(v&0x80)!==0; this.irqInhibit=(v&0x40)!==0;
    this.frameCyc=0; this.frameStep=0;
    if(this.irqInhibit) this.frameIRQ=false;
    if(this.mode5){ this._quarterFrame(); this._halfFrame(); }
  }
  _quarterFrame(){
    for(const p of [this.p1,this.p2]){
      if(p.envStart){ p.envStart=false; p.decay=15; p.envDivider=p.volume; }
      else if(p.envDivider>0){ p.envDivider--; }
      else{ p.envDivider=p.volume; if(p.decay>0) p.decay--; else if(p.envLoop) p.decay=15; }
    }
    const n=this.noise;
    if(n.envStart){ n.envStart=false; n.decay=15; n.envDivider=n.volume; }
    else if(n.envDivider>0){ n.envDivider--; }
    else{ n.envDivider=n.volume; if(n.decay>0) n.decay--; else if(n.envLoop) n.decay=15; }
    const t=this.tri;
    if(t.linearReloadFlag) t.linearCounter=t.linearReload;
    else if(t.linearCounter>0) t.linearCounter--;
    if(!t.ctrlHalt) t.linearReloadFlag=false;
  }
  _halfFrame(){
    for(const p of [this.p1,this.p2]){
      if(!p.lengthHalt && p.lengthCounter>0) p.lengthCounter--;
      if(p.sweepDivider===0 && p.sweepEnabled && p.sweepShift>0 && p.period>=8){
        const delta=p.period>>p.sweepShift;
        const target=p.sweepNegate?(p.period-delta-(p._isP2?0:1)):(p.period+delta);
        if(target<=0x7FF) p.period=Math.max(0,target);
      }
      if(p.sweepDivider===0 || p.sweepReload){ p.sweepDivider=p.sweepPeriod; p.sweepReload=false; }
      else p.sweepDivider--;
    }
    if(!this.tri.ctrlHalt && this.tri.lengthCounter>0) this.tri.lengthCounter--;
    if(!this.noise.lengthHalt && this.noise.lengthCounter>0) this.noise.lengthCounter--;
  }
  step(cpuCycles){
    this.frameCyc+=cpuCycles;
    const steps=this.mode5?[7457,14913,22371,29829,37281]:[7457,14913,22371,29829];
    let guard=0;
    while(this.frameStep<steps.length && this.frameCyc>=steps[this.frameStep] && guard++<8){
      const isLast=this.frameStep===steps.length-1;
      if(this.mode5){
        if(this.frameStep!==3){ this._quarterFrame(); if(this.frameStep===1||isLast) this._halfFrame(); }
      }else{
        this._quarterFrame();
        if(this.frameStep===1||isLast) this._halfFrame();
        if(isLast && !this.irqInhibit) this.frameIRQ=true;
      }
      this.frameStep++;
      if(isLast){ this.frameCyc-=steps[steps.length-1]; this.frameStep=0; }
    }
    for(let i=0;i<cpuCycles;i++){
      this.cpuCycleAcc^=1;
      if(this.cpuCycleAcc===0){ this._clockPulse(this.p1); this._clockPulse(this.p2); this._clockNoise(); }
      this._clockTriangle();
    }
  }
  _clockPulse(p){ if(p.timer===0){ p.timer=p.period; p.dutyPos=(p.dutyPos+1)&7; } else p.timer--; }
  _clockTriangle(){
    const t=this.tri;
    if(t.timer===0){ t.timer=t.period; if(t.lengthCounter>0 && t.linearCounter>0) t.seq=(t.seq+1)&31; }
    else t.timer--;
  }
  _clockNoise(){
    const n=this.noise;
    if(n.timer===0){
      n.timer=n.period;
      const bit=n.mode?((n.shift>>6)&1):((n.shift>>1)&1);
      const fb=(n.shift&1)^bit;
      n.shift=(n.shift>>1)|(fb<<14);
    }else n.timer--;
  }
  _pulseOut(p){
    if(!p.enabled||p.lengthCounter===0||p.period<8) return 0;
    if(!DUTY_SEQ[p.duty][p.dutyPos]) return 0;
    return p.constVol?p.volume:p.decay;
  }
  _triOut(){
    const t=this.tri;
    if(!t.enabled||t.lengthCounter===0) return 0;
    return TRI_SEQ[t.seq];
  }
  _noiseOut(){
    const n=this.noise;
    if(!n.enabled||n.lengthCounter===0) return 0;
    if(n.shift&1) return 0;
    return n.constVol?n.volume:n.decay;
  }
  sample(){
    const p1=this._pulseOut(this.p1), p2=this._pulseOut(this.p2);
    const tri=this._triOut(), noise=this._noiseOut();
    const pulseOut=(p1+p2)===0?0:95.88/((8128/(p1+p2))+100);
    const tndOut=(tri===0&&noise===0)?0:159.79/(1/((tri/8227)+(noise/12241))+100);
    return pulseOut+tndOut;
  }
}
