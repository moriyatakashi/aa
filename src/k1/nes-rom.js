// ─── iNES ROM パーサー ────────────────────────────────────────────────────
export class NESRom {
  constructor(buf) {
    const d = new Uint8Array(buf);
    if (d[0]!==0x4E||d[1]!==0x45||d[2]!==0x53||d[3]!==0x1A)
      throw new Error('iNES magic bytes not found');
    const f6=d[6], f7=d[7];
    this.mapper = (f7&0xF0)|(f6>>4);
    this.mirrorVertical = !!(f6&1);
    const offset = 16 + (f6&4 ? 512 : 0);
    const prgSz = d[4]*16*1024, chrSz = d[5]*8*1024;
    this.prgRom = d.slice(offset, offset+prgSz);
    this.chrRom = d.slice(offset+prgSz, offset+prgSz+chrSz);
    this.chrRam = chrSz===0 ? new Uint8Array(0x2000) : null; // CHR-RAM
  }
}
