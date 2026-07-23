import { NES_PAL } from "./nes-palette.js";
import { NESRom } from "./nes-rom.js";
import { CPU } from "./cpu.js";
import { PPU } from "./ppu.js";

// ─── メインループ / UI ────────────────────────────────────────────────────
const canvas=document.getElementById('screen');
const ctx=canvas.getContext('2d');
const imgData=ctx.createImageData(256,240);
let cpu=null,ppu=null,rafId=null,running=false;

// ── 音声出力（Web Audio、複数フレーム分をまとめてバッファ再生。継ぎ目のプチノイズ対策済み） ──
const AUDIO_SR=24000, CPU_HZ=1789773, CYCLES_PER_SAMPLE=CPU_HZ/AUDIO_SR;
const AUDIO_CHUNK=Math.floor(AUDIO_SR*0.08); // 約80ms分まとめてから再生（継ぎ目を減らす）
const AUDIO_FADE=64; // 継ぎ目のプチッというノイズを消すためのフェード幅(サンプル数)
let audioCtx=null, masterGain=null, audioNextTime=0, audioAcc=0, audioSamples=[];
let lpfPrev=0; // ローパスフィルタの状態（チャンクをまたいで継続、境界でのプチ音を防ぐ）

// iOSの「サイレントスイッチ」対策：無音に近いですが完全な無音ではない
// <audio>要素を1回再生しておくと、iOS Safariがページの音声を「メディア再生」
// 扱いにしてくれて、サイレントスイッチの影響を受けなくなる（既知の回避策）
function unlockIOSAudio(){
  try{
    const a=document.getElementById('iosUnlock');
    if(a && a.paused) a.play().catch(()=>{});
  }catch(e){}
}

function flushAudio(){
  if(!audioCtx || audioSamples.length<AUDIO_CHUNK) return;
  const n=audioSamples.length;
  const buf=audioCtx.createBuffer(1, n, AUDIO_SR);
  const ch=buf.getChannelData(0);
  ch.set(audioSamples);
  // 簡易ローパスフィルタ（単純な1次IIR）で高域のガサつき/エイリアシング感を軽減
  for(let i=0;i<n;i++){ lpfPrev += 0.5*(ch[i]-lpfPrev); ch[i]=lpfPrev; }
  // バッファの継ぎ目でプチッと鳴らないよう前後をフェードイン/アウト
  const fade=Math.min(AUDIO_FADE, n>>2);
  for(let i=0;i<fade;i++){ const g=i/fade; ch[i]*=g; ch[n-1-i]*=g; }

  const src=audioCtx.createBufferSource();
  src.buffer=buf;
  src.connect(masterGain);
  const now=audioCtx.currentTime;
  // 実時間に対してスケジュールが遅れすぎていたら、少し余裕を持たせて再スタート
  if(audioNextTime<now+0.02) audioNextTime=now+0.08;
  src.start(audioNextTime);
  audioNextTime+=buf.duration;
  audioSamples=[];
}

const KEYS={'z':0,'Z':0,'x':1,'X':1,'Shift':2,'Enter':3,
            'ArrowUp':4,'ArrowDown':5,'ArrowLeft':6,'ArrowRight':7};
document.addEventListener('keydown',e=>{if(cpu&&e.key in KEYS){cpu.joy1[KEYS[e.key]]=1;e.preventDefault();}});
document.addEventListener('keyup',  e=>{if(cpu&&e.key in KEYS) cpu.joy1[KEYS[e.key]]=0;});

// ─── GamePad対応 Phase1: 最小構成(ba-52) ──────────────────────────────
// Standard Gamepadレイアウト前提。複数コントローラー接続時は先頭のみ使用。
// button0(下段, Xbox A/PS×)→NES B、button1(右段, Xbox B/PS○)→NES A という
// 一般的なWebエミュレータのマッピング慣習を採用(必要ならPhase3で変更可能)。
// 既知の制約: keyboard/touchと同じjoy1配列に直接書き込むため、複数入力ソースを
// 同時に使った場合の押しっぱなし判定はソース間で厳密には独立していない。
const GAMEPAD_MAP={0:1,1:0,8:2,9:3,12:4,13:5,14:6,15:7};
let gamepadPrev={};
function pollGamepad(){
  if(!cpu || !navigator.getGamepads) return;
  const pad=navigator.getGamepads()[0];
  if(!pad) return;
  for(const btnIdx in GAMEPAD_MAP){
    const b=pad.buttons[btnIdx];
    const pressed=!!(b && b.pressed);
    if(pressed!==gamepadPrev[btnIdx]){
      cpu.joy1[GAMEPAD_MAP[btnIdx]]=pressed?1:0;
      gamepadPrev[btnIdx]=pressed;
    }
  }
}

// ─── GamePad対応 Phase2: 接続状態表示(ba-52) ──────────────────────────
// キーボード/タッチは常時併存のため、未接続でも操作不能にはならない(fallback済み)。
const gamepadStatusEl=document.getElementById('gamepadStatus');
function updateGamepadStatus(){
  if(!gamepadStatusEl) return;
  const pads=navigator.getGamepads?navigator.getGamepads():[];
  const pad=pads&&pads[0];
  gamepadStatusEl.textContent=pad?`🎮 接続中: ${pad.id}`:'🎮 未接続（キーボード/タッチで操作可）';
}
window.addEventListener('gamepadconnected',updateGamepadStatus);
window.addEventListener('gamepaddisconnected',updateGamepadStatus);
updateGamepadStatus();

function blit(){
  const fb=ppu.fb,d=imgData.data;
  for(let i=0;i<256*240;i++){
    const pi=(fb[i]&0x3F)*3, j=i<<2;
    d[j]=NES_PAL[pi]; d[j+1]=NES_PAL[pi+1]; d[j+2]=NES_PAL[pi+2]; d[j+3]=255;
  }
  ctx.putImageData(imgData,0,0);
}

function loop(){
  if(!running) return;
  pollGamepad();
  const target=Math.floor(ppu.totalDots/(341*262))+1;
  try{
    while(Math.floor(ppu.totalDots/(341*262))<target){
      const before=cpu.cyc;
      cpu.step();
      const cyc=cpu.cyc-before;
      ppu.tick(cyc);
      cpu.apu.step(cyc);
      audioAcc+=cyc;
      while(audioAcc>=CYCLES_PER_SAMPLE){
        audioAcc-=CYCLES_PER_SAMPLE;
        audioSamples.push(cpu.apu.sample());
      }
      if(ppu.nmiPending){ppu.nmiPending=false;cpu.triggerNMI();}
      if(cpu.mapper?.irqPending){cpu.mapper.irqPending=false;cpu.triggerIRQ();}
      if(cpu.apu.frameIRQ){cpu.triggerIRQ();}
    }
  }catch(e){
    setStatus('エラー: '+e.message);
    showError('loop() 実行中', e);
    stop(); return;
  }
  blit();
  flushAudio();
  rafId=requestAnimationFrame(loop);
}

function start(rom){
  stop();
  cpu=new CPU(rom); ppu=new PPU(rom,cpu.mapper); cpu.ppu=ppu;
  if(!audioCtx){
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    masterGain=audioCtx.createGain();
    masterGain.gain.value=parseFloat(document.getElementById('volSlider')?.value||'3');
    masterGain.connect(audioCtx.destination);
  }
  if(audioCtx.state==='suspended') audioCtx.resume();
  unlockIOSAudio();
  audioNextTime=audioCtx.currentTime+0.05; audioAcc=0; audioSamples=[];
  running=true;
  document.getElementById('btnStop').disabled=false;
  rafId=requestAnimationFrame(loop);
}

function stop(){
  running=false;
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  if(audioCtx) audioCtx.suspend();
  document.getElementById('btnStop').disabled=true;
}

function load(buf,name){
  window.__lastRomName = name;
  try{
    const rom=new NESRom(buf);
    const chrInfo=rom.chrRam?'CHR-RAM':`CHR:${rom.chrRom.length>>10}KB`;
    setStatus(`${name} — Mapper${rom.mapper} / PRG:${rom.prgRom.length>>10}KB / ${chrInfo}`);
    start(rom);
  }catch(e){
    setStatus('読み込みエラー: '+e.message);
    showError('ROM読み込み（'+name+'）', e);
  }
}

function setStatus(msg){document.getElementById('status').textContent=msg;}

// ── エラー表示（コピー用コードブロック） ──────────────────────
function showError(context, err){
  const box = document.getElementById('errorBox');
  const textEl = document.getElementById('errorText');
  const now = new Date().toISOString();
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : '(スタックトレースなし)';
  const romName = (window.__lastRomName || '(未選択)');
  const text = [
    `time: ${now}`,
    `context: ${context}`,
    `rom: ${romName}`,
    `message: ${message}`,
    `stack:`,
    stack,
  ].join('\n');
  textEl.textContent = text;
  box.classList.add('show');
}

document.getElementById('btnCopyError').addEventListener('click', async () => {
  const btn = document.getElementById('btnCopyError');
  const text = document.getElementById('errorText').textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ コピーしました';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋 コピー'; btn.classList.remove('copied'); }, 2000);
  } catch (e) {
    alert('コピー失敗: ' + e.message);
  }
});

window.addEventListener('error', (e) => {
  showError('window.onerror', e.error || new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  showError('unhandledrejection', reason);
});
// ──────────────────────────────────────────────────────────

// ── オンスクリーンボタン（スマホ用タッチ操作） ──────────────────
// ── 音量調整・テスト音（ゲーム未起動でも音声パイプラインを確認できる） ──────
document.getElementById('volSlider').addEventListener('input', (e) => {
  if(masterGain) masterGain.gain.value = parseFloat(e.target.value);
});
document.getElementById('btnTestSound').addEventListener('click', () => {
  if(!audioCtx){
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    masterGain=audioCtx.createGain();
    masterGain.gain.value=parseFloat(document.getElementById('volSlider').value);
    masterGain.connect(audioCtx.destination);
  }
  if(audioCtx.state==='suspended') audioCtx.resume();
  unlockIOSAudio();
  const osc=audioCtx.createOscillator();
  osc.type='square'; osc.frequency.value=440;
  osc.connect(masterGain);
  osc.start();
  osc.stop(audioCtx.currentTime+0.3);
});
// ──────────────────────────────────────────────────────────
document.querySelectorAll('.pad-btn').forEach(btn=>{
  const idx = parseInt(btn.dataset.idx, 10);
  const press = (e) => { e.preventDefault(); if(cpu) cpu.joy1[idx]=1; btn.classList.add('pressed'); };
  const release = (e) => { e.preventDefault(); if(cpu) cpu.joy1[idx]=0; btn.classList.remove('pressed'); };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('contextmenu', e=>e.preventDefault());
});
// ──────────────────────────────────────────────────────────

document.getElementById('btnFile').addEventListener('click',()=>document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>load(r.result,f.name);
  r.readAsArrayBuffer(f);
  e.target.value='';
});
document.getElementById('btnStop').addEventListener('click',stop);
document.querySelectorAll('.rom-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    setStatus('読み込み中...');
    fetch(btn.dataset.rom).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer();})
      .then(buf=>load(buf,btn.textContent))
      .catch(e=>{
        setStatus('取得エラー: '+e.message);
        showError('ROM取得（'+btn.dataset.rom+'）', e);
      });
  });
});
