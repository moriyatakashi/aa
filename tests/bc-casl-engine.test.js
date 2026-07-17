import test from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../bc/assembler.js";
import { Comet2 } from "../bc/comet2.js";

function run(source, { entryLabel = "", input = [] } = {}) {
  const result = assemble(source, { entryLabel });
  assert.equal(
    result.ok,
    true,
    `assembly failed: ${result.errors.map((e) => `L${e.line + 1}: ${e.message}`).join("; ")}`
  );

  const vm = new Comet2();
  vm.load(result.memory, result.entryPoint);
  const output = [];
  const queue = [...input];
  vm.onIn = () => (queue.length ? queue.shift() : null);
  vm.onOut = (str) => output.push(str);

  const { halted, steps } = vm.run(new Set(), 100000);
  assert.equal(halted, true, `program did not halt within step budget (ran ${steps} steps)`);

  return { vm, result, output };
}

test("LAD + ADDA (register-register) computes a sum", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,3
         LAD    GR2,4
         ADDA   GR1,GR2
         RET
         END
`);
  assert.equal(vm.gr[1], 7);
});

test("loop with an index-register increment sums 1..10", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,0
         LAD    GR2,1
LOOP     CPA    GR2,=11
         JZE    DONE
         ADDA   GR1,GR2
         LAD    GR2,1,GR2
         JUMP   LOOP
DONE     RET
         END
`);
  assert.equal(vm.gr[1], 55);
  assert.equal(vm.gr[2], 11);
});

test("CALL/RET across two START/END blocks shares the stack", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,5
         CALL   DOUBLE
         RET
         END
DOUBLE   START
         ADDA   GR1,GR1
         RET
         END
`);
  assert.equal(vm.gr[1], 10);
});

test("DC/DS/LD/ST round-trip a value through memory", () => {
  const { vm, result } = run(`
MAIN     START
         LD     GR1,VAL
         ST     GR1,RESULT
         RET
VAL      DC     42
RESULT   DS     1
         END
`);
  const block = result.blocks[0];
  const resultAddr = block.locals.get("RESULT").addr;
  assert.equal(vm.memory[resultAddr], 42);
});

test("PUSH/POP and RPUSH/RPOP preserve register values", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,1
         LAD    GR2,2
         LAD    GR3,3
         RPUSH
         LAD    GR1,0
         LAD    GR2,0
         LAD    GR3,0
         RPOP
         RET
         END
`);
  assert.equal(vm.gr[1], 1);
  assert.equal(vm.gr[2], 2);
  assert.equal(vm.gr[3], 3);
});

test("signed overflow sets OF on ADDA", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,32767
         LAD    GR2,1
         ADDA   GR1,GR2
         RET
         END
`);
  assert.equal(vm.gr[1] & 0xffff, 0x8000);
  assert.equal(vm.of, 1);
});

test("SLA shifts left and preserves the sign bit", () => {
  const { vm } = run(`
MAIN     START
         LAD    GR1,3
         SLA    GR1,2
         RET
         END
`);
  assert.equal(vm.gr[1], 12);
});

test("IN/OUT macros round-trip a line through the console", () => {
  const { output } = run(
    `
MAIN     START
         IN     BUF,LEN
         OUT    BUF,LEN
         RET
BUF      DS     20
LEN      DS     1
         END
`,
    { input: ["HELLO"] }
  );
  assert.deepEqual(output, ["HELLO"]);
});

test("literal constants ('=…') are pooled and shared", () => {
  const { vm } = run(`
MAIN     START
         LD     GR1,=5
         LD     GR2,=5
         ADDL   GR1,GR2
         RET
         END
`);
  assert.equal(vm.gr[1], 10);
});

test("undefined label reference is reported as an error", () => {
  const result = assemble(`
MAIN     START
         JUMP   NOWHERE
         RET
         END
`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("NOWHERE")));
});

test("duplicate label definition is reported as an error", () => {
  const result = assemble(`
MAIN     START
L1       LAD    GR1,1
L1       LAD    GR2,2
         RET
         END
`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("L1")));
});

test("missing END is reported as an error", () => {
  const result = assemble(`
MAIN     START
         RET
`);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("END")));
});
