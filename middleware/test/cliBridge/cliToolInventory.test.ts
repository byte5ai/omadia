import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mineCliToolInventory } from '../_helpers/cliToolInventory.js';

/**
 * The miner behind the deny-list drift guard in `cliSpawnGate.test.ts`.
 *
 * That guard runs against whatever CLI happens to be installed, so on its own
 * it proves only that the miner reads ONE version. These fixtures pin both
 * layouts the CLI has shipped, and the ways a parser can be fooled into a
 * green result: decoy `name`/`aliases` keys, factory parameters and names it
 * cannot resolve. The fixtures copy the shape of the real minified source
 * (2.1.259 for the array, 2.1.289 for the module chunks), not its size.
 */

const HEADER = '// @bun @bytecode\n// Version: 2.1.289\n';

/** 50+ quoted names including the anchors, as 2.1.259 shipped it. */
function literalInventory(extra: readonly string[]): string {
  const filler = Array.from({ length: 50 }, (_, i) => `Filler${i}`);
  const names = ['Bash', 'Read', 'WebFetch', 'Grep', 'Tmux', 'mcp__claude-code-remote__x', ...extra, ...filler];
  return `var mEo=[${names.map((name) => `"${name}"`).join(',')}];`;
}

/** Module chunks as 2.1.289 ships them: constants in one, definitions in another. */
function chunkedSource(): string {
  return [
    `${HEADER}var _r="WebFetch",Rwn="url";export{_r,Rwn};\n`,
    `${HEADER}var Ue="Bash",dn="Write";export{Ue,dn as Wr};\n`,
    `${HEADER}var Va="Monitor";export{Va};\n`,
    // The definitions chunk imports two of them, one under a local alias.
    `${HEADER}import{_r,Ue}from"/$bunfs/root/chunk-a.js";import{Wr as dn}from"/$bunfs/root/chunk-b.js";` +
      `import{Va}from"/$bunfs/root/chunk-c.js";` +
      'var KS="KillShell";' +
      'var Bh=Vt({name:Ue,aliases:void 0,searchHint:"run shell commands",maxResultSizeChars:3e4,' +
      'async description(){return`Runs ${"x"}`},isConcurrencySafe(){return!1}});' +
      'var Hv=Vt({name:dn,searchHint:"create or overwrite files",maxResultSizeChars:1e5});' +
      'var Wf=Vt({...e,isConcurrencySafe(){return!0},name:_r,searchHint:"fetch a url"});' +
      'var Oe={name:Va,enablesCodeExecution:!0,maxResultSizeChars:1e4};' +
      'var Ks=Vt({name:"TaskStop",aliases:[KS,"KillBash"],searchHint:"stop a task"});' +
      // A factory: `name:e` is its parameter; the call site carries the name.
      'function m(e){return{name:e.name,searchHint:e.searchHint}}' +
      'function ge(e){return Vt({name:e,searchHint:"x",maxResultSizeChars:1})}' +
      'var P=m({addon:"data",name:"ArtifactData",searchHint:"shared db"});' +
      // The generic MCP template and decoys that are NOT tools.
      'var Mt={name:"mcp",isMcp:!0,searchHint:"",maxResultSizeChars:1e5};' +
      'var yO=(e)=>({name:"Cedar",aliases:["cedarpolicy"],keywords:{keyword:"permit"}});' +
      'var ce=[{name:"ctrl",aliases:["control"]},{name:"shift"}];' +
      'var sub={name:"NotATool",schema:{searchHint:"nested, not top-level"}};\n',
    `${HEADER}kT.BUILTIN_TOOL_NAMES=["Bash","Read","REPL","JavaScript"];\n`,
  ].join('');
}

describe('mineCliToolInventory', () => {
  it('reads the literal inventory array of 2.1.259', () => {
    const inventory = mineCliToolInventory(`junk ${literalInventory(['Edit'])} junk`);
    assert.deepEqual(inventory.formats, ['literal-inventory']);
    for (const name of ['Bash', 'Read', 'WebFetch', 'Grep', 'Tmux', 'Edit']) {
      assert.ok(inventory.builtins.includes(name), `missing ${name}`);
    }
    assert.ok(!inventory.builtins.some((name) => name.startsWith('mcp__')), 'mcp__ names are not built-ins');
  });

  it('ignores a long array literal that lacks the anchors', () => {
    const decoy = `[${Array.from({ length: 60 }, (_, i) => `"Lang${i}"`).join(',')}]`;
    assert.deepEqual(mineCliToolInventory(decoy).formats, []);
  });

  it('resolves tool definitions through module imports, as 2.1.289 ships them', () => {
    const inventory = mineCliToolInventory(chunkedSource());
    assert.deepEqual(inventory.formats, ['tool-definitions']);
    assert.deepEqual(inventory.builtins, ['ArtifactData', 'Bash', 'Monitor', 'TaskStop', 'WebFetch', 'Write']);
    assert.deepEqual(inventory.unresolved, []);
  });

  it('reads aliases only from tool definitions, literal and imported alike', () => {
    const inventory = mineCliToolInventory(chunkedSource());
    // `cedarpolicy` (highlight.js) and `control` (key bindings) are decoys.
    assert.deepEqual(inventory.aliases, ['KillBash', 'KillShell']);
  });

  it('keeps the generic MCP template, nested keys and plain objects out', () => {
    const { builtins } = mineCliToolInventory(chunkedSource());
    for (const decoy of ['mcp', 'Cedar', 'ctrl', 'shift', 'NotATool']) {
      assert.ok(!builtins.includes(decoy), `${decoy} is not a tool`);
    }
  });

  it('counts factory parameters instead of reporting them as names', () => {
    assert.ok(mineCliToolInventory(chunkedSource()).parameterNames >= 1);
  });

  it('reads the SDK list independently of the layout', () => {
    assert.deepEqual(mineCliToolInventory(chunkedSource()).sdkBuiltinNames, ['Bash', 'Read', 'REPL', 'JavaScript']);
  });

  it('reports a name whose import leads nowhere, rather than dropping the tool', () => {
    const source = `${HEADER}import{Zz}from"/$bunfs/root/chunk-gone.js";var T=Vt({name:Zz,searchHint:"x"});\n`;
    const inventory = mineCliToolInventory(source);
    assert.deepEqual(inventory.unresolved, [{ identifier: 'Zz', reason: 'import-not-found', candidates: [] }]);
  });

  it('reports an import two chunks export with different values as ambiguous', () => {
    const source =
      `${HEADER}var a="Read";export{a as Q};\n` +
      `${HEADER}var b="Write";export{b as Q};\n` +
      `${HEADER}import{Q}from"/$bunfs/root/chunk-x.js";var T=Vt({name:Q,searchHint:"x"});\n`;
    const [entry] = mineCliToolInventory(source).unresolved;
    assert.equal(entry?.reason, 'ambiguous');
    assert.deepEqual(entry?.candidates, ['Read', 'Write']);
  });

  it('reports a local without a string value instead of calling it a parameter', () => {
    const source = `${HEADER}var Q=makeName();var T=Vt({name:Q,searchHint:"x"});\n`;
    const inventory = mineCliToolInventory(source);
    assert.deepEqual(inventory.unresolved, [
      { identifier: 'Q', reason: 'no-string-declaration', candidates: [] },
    ]);
    assert.equal(inventory.parameterNames, 0);
  });

  it('does not let one exporter stand in for another that does not resolve', () => {
    const source =
      `${HEADER}var a="Read";export{a as Q};\n` +
      `${HEADER}var b=makeName();export{b as Q};\n` +
      `${HEADER}import{Q}from"/$bunfs/root/chunk-y.js";var T=Vt({name:Q,searchHint:"x"});\n`;
    const [entry] = mineCliToolInventory(source).unresolved;
    assert.equal(entry?.identifier, 'Q');
    assert.equal(entry?.reason, 'import-not-found');
  });

  it('finds nothing in a binary of an unknown layout, so the caller can fail', () => {
    const inventory = mineCliToolInventory(`${HEADER}console.log("hello")\n`);
    assert.deepEqual(inventory.formats, []);
    assert.deepEqual(inventory.builtins, []);
  });
});
