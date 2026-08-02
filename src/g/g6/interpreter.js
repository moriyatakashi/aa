// parser.jsが作ったAST(PROCEDURE DIVISIONの文の木構造)を実行する簡易インタプリタ。
// COBOLは元々ブロック構造(IF/END-IF, PERFORM/END-PERFORM)を持つため、k1やbhのような
// 「フラットな命令配列+ジャンプ」ではなく、木を再帰的に辿る方式にしている
// (そのためbc/bhにあったステップ実行は今回省略、実行/リセットのみ)。

export class RunLimitError extends Error {}

export class Interpreter extends EventTarget {
  constructor() {
    super();
    this.vars = new Map(); // name -> {type, width, value}
    this.output = "";
    this.stepCount = 0;
    this.maxSteps = 200000;
    this.error = null;
    this.onOut = null;
  }

  load(program) {
    this.program = program;
    this.vars = new Map();
    for (const v of program.vars) {
      this.vars.set(v.name, { type: v.type, width: v.width, value: v.value });
    }
    this.output = "";
    this.stepCount = 0;
    this.error = null;
    this.halted = false;
  }

  _getVar(name) {
    const v = this.vars.get(name);
    if (!v) throw new Error(`未定義の変数です: ${name}`);
    return v;
  }

  _evalOperand(op) {
    if (op.kind === "lit-number") return op.value;
    if (op.kind === "lit-string") return op.value;
    return this._getVar(op.name).value;
  }

  _formatVarForDisplay(v) {
    if (v.type === "numeric") return String(v.value).padStart(v.width, "0");
    return String(v.value).padEnd(v.width, " ");
  }

  _formatOperandForDisplay(op) {
    if (op.kind === "var") return this._formatVarForDisplay(this._getVar(op.name));
    return String(op.value);
  }

  _evalCondition(cond) {
    const l = this._evalOperand(cond.left);
    const r = this._evalOperand(cond.right);
    switch (cond.op) {
      case "=":
        return l === r;
      case "<>":
        return l !== r;
      case ">":
        return l > r;
      case "<":
        return l < r;
      case ">=":
        return l >= r;
      case "<=":
        return l <= r;
      default:
        throw new Error(`未対応の比較演算子です: ${cond.op}`);
    }
  }

  _tick() {
    this.stepCount++;
    if (this.stepCount > this.maxSteps) {
      throw new RunLimitError(`ステップ数上限(${this.maxSteps})に達しました(無限ループの可能性があります)`);
    }
  }

  // 文の配列を先頭から実行する。STOP RUNに達したらtrueを返し、呼び出し元は即座に巻き戻る。
  _execStatements(stmts) {
    for (const stmt of stmts) {
      if (this._execStatement(stmt)) return true;
    }
    return false;
  }

  _execStatement(stmt) {
    this._tick();
    switch (stmt.type) {
      case "DISPLAY": {
        const text = stmt.items.map((it) => this._formatOperandForDisplay(it)).join("");
        this.output += text + "\n";
        if (this.onOut) this.onOut(text + "\n");
        return false;
      }
      case "MOVE": {
        const v = this._getVar(stmt.dest.name);
        const src = this._evalOperand(stmt.src);
        v.value = v.type === "numeric" ? Number(src) | 0 : String(src);
        return false;
      }
      case "ADD": {
        const v = this._getVar(stmt.dest.name);
        v.value = (v.value | 0) + (this._evalOperand(stmt.operand) | 0);
        return false;
      }
      case "SUBTRACT": {
        const v = this._getVar(stmt.dest.name);
        v.value = (v.value | 0) - (this._evalOperand(stmt.operand) | 0);
        return false;
      }
      case "IF": {
        const branch = this._evalCondition(stmt.condition) ? stmt.thenBlock : stmt.elseBlock;
        return this._execStatements(branch);
      }
      case "PERFORM_UNTIL": {
        while (!this._evalCondition(stmt.condition)) {
          if (this._execStatements(stmt.body)) return true;
          this._tick();
        }
        return false;
      }
      case "PERFORM_TIMES": {
        for (let i = 0; i < stmt.count; i++) {
          if (this._execStatements(stmt.body)) return true;
          this._tick();
        }
        return false;
      }
      case "STOP_RUN":
        return true;
      default:
        throw new Error(`未実装の文です: ${stmt.type}`);
    }
  }

  // 全体を実行する。例外(RunLimitError含む)は呼び出し元でcatchすること。
  run() {
    this._execStatements(this.program.statements);
    this.halted = true;
  }
}
