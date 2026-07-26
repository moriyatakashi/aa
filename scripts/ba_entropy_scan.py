#!/usr/bin/env python3
"""高エントロピー(鍵様)文字列スキャナ。
モード:
  (既定)     ba 全エントリ(GET無認証)の title/body を走査。
  --repo DIR  git リポジトリの現ツリー + 全履歴(git log -p --all)を走査。
              CI(actions/checkout fetch-depth:0)でそのまま利用可。
検出: len>=40 / base64url / 大小英字+数字混在 / entropy>=4.0。
除外: ba-id・hex/hash・Drive ID(len<40)・lockfile・npm integrity(sha\\d+-)・バイナリ。
既知の固定値は baseline.json の指紋(sha256[:16])で抑制。生値は保存しない。
新規検出があれば exit=1(通知/CI ゲート用)。値はマスク表示。
"""
import urllib.request, json, math, re, hashlib, sys, os, subprocess
from collections import Counter

BA_URL='https://ab-board-api.azurewebsites.net/api/ba'
BASELINE=os.path.join(os.path.dirname(os.path.abspath(__file__)),'entropy_scan_baseline.json')
TOK=re.compile(r'[^\s、。「」『』()｜|,/:;=\'"\\<>{}\[\]]+')
LOCKFILES=re.compile(r'(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$')
BIN_EXT=re.compile(r'\.(nes|png|jpg|jpeg|gif|webp|woff2?|ttf|ico|pdf|zip|gz|wasm)$',re.I)
INTEGRITY=re.compile(r'^sha\d+-')

def entropy(s):
    n=len(s); c=Counter(s); return -sum((v/n)*math.log2(v/n) for v in c.values())
def is_keyish(t):
    if len(t)<40 or INTEGRITY.match(t): return False
    if not re.fullmatch(r'[A-Za-z0-9_\-]+',t): return False
    if not(any(c.islower() for c in t) and any(c.isupper() for c in t) and any(c.isdigit() for c in t)): return False
    return entropy(t)>=4.0
def fp(t): return hashlib.sha256(t.encode()).hexdigest()[:16]
def mask(t): return t[:4]+'…'+t[-4:]
def load_baseline():
    try: return {x['fingerprint'] for x in json.load(open(BASELINE))['known']}
    except Exception: return set()

def scan_ba():
    data=json.loads(urllib.request.urlopen(BA_URL,timeout=60).read().decode())
    f={}
    for e in data:
        for fld in ('title','body'):
            v=e.get(fld)
            if not isinstance(v,str): continue
            for tok in TOK.findall(v):
                if is_keyish(tok):
                    f.setdefault(fp(tok),{'mask':mask(tok),'len':len(tok),'where':set()})['where'].add(e['id'])
    return f

def scan_repo(d):
    cwd=os.getcwd(); os.chdir(d); f={}
    try:
        for path in subprocess.check_output(['git','ls-files']).decode().splitlines():
            if LOCKFILES.search(path) or BIN_EXT.search(path): continue
            try: data=open(path,'rb').read().decode('utf-8')
            except Exception: continue
            for tok in TOK.findall(data):
                if is_keyish(tok):
                    f.setdefault(fp(tok),{'mask':mask(tok),'len':len(tok),'where':set()})['where'].add('tree:'+path)
        out=subprocess.run(['git','log','--all','-p','--no-color'],capture_output=True,text=True,errors='replace').stdout
        cur=None; skip=False
        for line in out.splitlines():
            if line.startswith('commit ') and len(line)>=14:
                cur=line.split()[1][:9]
            elif line.startswith('diff --git '):
                m=re.search(r' b/(.+)$',line); path=m.group(1) if m else ''
                skip=bool(LOCKFILES.search(path) or BIN_EXT.search(path))
            elif not skip:
                for tok in TOK.findall(line):
                    if is_keyish(tok):
                        f.setdefault(fp(tok),{'mask':mask(tok),'len':len(tok),'where':set()})['where'].add('commit:'+(cur or '?'))
    finally: os.chdir(cwd)
    return f

def report(f):
    known=load_baseline()
    new={k:v for k,v in f.items() if k not in known}
    ack=len(f)-len(new)
    print(f"[entropy-scan] 鍵様 {len(f)} / 既知抑制 {ack} / 新規 {len(new)}")
    for k,v in new.items():
        print(f"  ★新規 fp={k} {v['mask']} len={v['len']} 出現={sorted(v['where'])[:6]}")
    return 1 if new else 0

if __name__=='__main__':
    a=sys.argv[1:]
    if a and a[0]=='--repo':
        sys.exit(report(scan_repo(a[1] if len(a)>1 else '.')))
    elif a and a[0]=='--ack-current':
        f=scan_ba(); base={'known':[{'fingerprint':k,'note':'ack via --ack-current'} for k in f]}
        json.dump(base,open(BASELINE,'w'),ensure_ascii=False,indent=2)
        print(f"baseline 更新: {len(f)} 件(指紋のみ)")
    else:
        sys.exit(report(scan_ba()))
