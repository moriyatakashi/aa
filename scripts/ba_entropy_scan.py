#!/usr/bin/env python3
"""ba 高エントロピー(鍵様)文字列スキャナ。
- GET は無認証なので鍵不要。ba 全エントリの title/body を走査。
- 鍵様 = len>=40 / base64url charset / 大小英字+数字混在 / entropy>=4.0。
  (Drive ID<40, hex/hash は除外される)
- void は除外しない(void はテキストを消さないため、盲点を作らない)。
- 既知の固定値は baseline.json の指紋(sha256[:16])で抑制。生値は保存しない。
- 新規検出があれば非ゼロ終了(通知/CI 用)。値はマスク表示。
"""
import urllib.request, json, math, re, hashlib, sys, os
from collections import Counter

BASE_URL='https://ab-board-api.azurewebsites.net/api/ba'
BASELINE=os.path.join(os.path.dirname(__file__),'entropy_scan_baseline.json')
TOK=re.compile(r'[^\s、。「」『』()｜|,/:;=\'"\\<>{}\[\]]+')

def entropy(s):
    n=len(s); c=Counter(s)
    return -sum((v/n)*math.log2(v/n) for v in c.values())

def is_keyish(t):
    if len(t)<40: return False
    if not re.fullmatch(r'[A-Za-z0-9_\-]+',t): return False
    if not(any(c.islower() for c in t) and any(c.isupper() for c in t) and any(c.isdigit() for c in t)): return False
    return entropy(t)>=4.0

def fp(t): return hashlib.sha256(t.encode()).hexdigest()[:16]

def load_baseline():
    try:
        return {x['fingerprint'] for x in json.load(open(BASELINE))['known']}
    except Exception:
        return set()

def scan():
    data=json.loads(urllib.request.urlopen(BASE_URL,timeout=60).read().decode())
    known=load_baseline()
    findings={}
    for e in data:
        for f in ('title','body'):
            v=e.get(f)
            if not isinstance(v,str): continue
            for tok in TOK.findall(v):
                if is_keyish(tok):
                    findings.setdefault(fp(tok),{'ids':set(),'len':len(tok),'H':round(entropy(tok),2)})['ids'].add(e['id'])
    new={k:v for k,v in findings.items() if k not in known}
    ack={k:v for k,v in findings.items() if k in known}
    print(f"[ba-entropy-scan] 鍵様検出 計{len(findings)} / 既知抑制 {len(ack)} / 新規 {len(new)}")
    for k,v in new.items():
        print(f"  ★新規 fp={k} len={v['len']} H={v['H']} 出現={sorted(v['ids'])}")
    return 1 if new else 0

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--ack-current':
        # 現在の鍵様検出を全て既知として baseline に登録(指紋のみ)。生値は保存しない。
        data=json.loads(urllib.request.urlopen(BASE_URL,timeout=60).read().decode())
        known=[]
        seen=set()
        for e in data:
            for f in ('title','body'):
                v=e.get(f)
                if not isinstance(v,str): continue
                for tok in TOK.findall(v):
                    if is_keyish(tok):
                        f16=fp(tok)
                        if f16 in seen: continue
                        seen.add(f16)
                        known.append({'fingerprint':f16,'first_seen':sorted([x['id'] for x in data if isinstance(x.get('body'),str) and tok in x['body']])[:1],'note':'ack via --ack-current'})
        json.dump({'known':known},open(BASELINE,'w'),ensure_ascii=False,indent=2)
        print(f"baseline 更新: {len(known)} 件を既知登録(指紋のみ)")
    else:
        sys.exit(scan())
