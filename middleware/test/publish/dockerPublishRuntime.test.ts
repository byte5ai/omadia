import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { DockerPublishRuntime, _internal } from '../../packages/harness-publish/src/dockerPublishRuntime.js';
import type { DockerExec, DockerExecContext, DockerExecResult } from '@omadia/sandbox';

/**
 * Issue #581 P1 — `DockerPublishRuntime` tests, same two-tier split as
 * `dockerSandbox.test.ts`: a stub `execDocker` exercises every argv/wiring
 * branch deterministically; a `SANDBOX_DOCKER_TEST=1` tier proves the stub's
 * assumptions against a real daemon, including the `$DATA_DIR` durability
 * contract end to end.
 */
interface RecordedCall {
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function stubExec(script: (ctx: DockerExecContext, callIndex: number) => DockerExecResult): {
  exec: DockerExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: DockerExec = async (ctx) => {
    calls.push({ args: ctx.args, input: ctx.input });
    return script(ctx, calls.length - 1);
  };
  return { exec, calls };
}

function ok(stdout = '', stderr = ''): DockerExecResult {
  return { exitCode: 0, stdout, stderr, timedOut: false, outputTruncated: false };
}
function fail(stderr: string, exitCode = 1): DockerExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false, outputTruncated: false };
}

describe('DockerPublishRuntime.deploy — wiring (stub)', () => {
  it('a fresh version: creates the data volume, runs a new container, writes every file, and launches the entrypoint', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    await runtime.deploy({
      appId: 'todo',
      version: 1,
      entrypoint: 'server.js',
      files: new Map([
        ['server.js', 'listen()'],
        ['public/index.html', '<html></html>'],
      ]),
    });

    assert.ok(calls.some((c) => c.args[0] === 'volume' && c.args[1] === 'create'));
    const runCall = calls.find((c) => c.args[0] === 'run');
    assert.ok(runCall, 'expected a docker run');
    assert.ok(runCall!.args.includes('-p'));
    assert.ok(runCall!.args.some((a) => a.includes('127.0.0.1::8080')));
    assert.ok(runCall!.args.includes('-v'));

    const writeCalls = calls.filter((c) => c.args[0] === 'exec' && c.args.includes('-i'));
    assert.equal(writeCalls.length, 2, 'expected one write per file');
    assert.ok(writeCalls.some((c) => c.input === 'listen()'));
    assert.ok(writeCalls.some((c) => c.input === '<html></html>'));

    const startCall = calls.find((c) => c.args[0] === 'exec' && c.args.includes('-d'));
    assert.ok(startCall, 'expected a detached exec launching the entrypoint');
    assert.ok(startCall!.args.some((a) => a.includes('PORT=8080')));
    assert.ok(startCall!.args.some((a) => a.includes('DATA_DIR=/data')));
    assert.ok(startCall!.args.some((a) => a.includes("node 'server.js'")));
  });

  it('deploy() is a no-op when the version already has a container — never re-materializes it', async () => {
    const name = _internal.containerNameFor('todo', 1);
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(name);
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    await runtime.deploy({ appId: 'todo', version: 1, entrypoint: 'server.js', files: new Map([['server.js', 'NEW CONTENT']]) });
    assert.equal(calls.length, 1, 'only the existence check should run; nothing else for an already-deployed version');
    assert.ok(!calls.some((c) => c.args[0] === 'run'));
  });

  it('two versions of the SAME app share the identical data volume name', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    await runtime.deploy({ appId: 'todo', version: 1, entrypoint: 'x.js', files: new Map([['x.js', 'a']]) });
    await runtime.deploy({ appId: 'todo', version: 2, entrypoint: 'x.js', files: new Map([['x.js', 'b']]) });
    const volumeCreates = calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'create');
    assert.equal(volumeCreates.length, 2);
    assert.equal(volumeCreates[0]!.args[2], volumeCreates[1]!.args[2], 'same app => same $DATA_DIR volume across versions');
  });

  it('two DIFFERENT apps get DIFFERENT data volumes', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    await runtime.deploy({ appId: 'app-a', version: 1, entrypoint: 'x.js', files: new Map([['x.js', 'a']]) });
    await runtime.deploy({ appId: 'app-b', version: 1, entrypoint: 'x.js', files: new Map([['x.js', 'a']]) });
    const volumeCreates = calls.filter((c) => c.args[0] === 'volume' && c.args[1] === 'create');
    assert.notEqual(volumeCreates[0]!.args[2], volumeCreates[1]!.args[2]);
  });

  it('containerNameFor is deterministic per (appId, version) and distinct across versions', () => {
    const a = _internal.containerNameFor('app', 1);
    const b = _internal.containerNameFor('app', 1);
    const c = _internal.containerNameFor('app', 2);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('surfaces a clear error when the container fails to start', async () => {
    const { exec } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      if (ctx.args[0] === 'run') return fail('no such image');
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    await assert.rejects(() => runtime.deploy({ appId: 'todo', version: 1, entrypoint: 'x.js', files: new Map([['x.js', 'a']]) }));
  });
});

describe('DockerPublishRuntime.portFor', () => {
  it('parses the host port docker assigned', async () => {
    const { exec } = stubExec((ctx) => {
      if (ctx.args[0] === 'port') return ok('0.0.0.0:54321\n');
      return ok();
    });
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    assert.equal(await runtime.portFor('todo', 1), 54321);
  });

  it('returns undefined when the container is not running (docker port fails)', async () => {
    const { exec } = stubExec(() => fail('No such container'));
    const runtime = new DockerPublishRuntime({ execDocker: exec });
    assert.equal(await runtime.portFor('todo', 1), undefined);
  });
});

// ---------------------------------------------------------------------------
// REAL-DOCKER tier — SANDBOX_DOCKER_TEST=1, opt-in (#576 pattern). Proves the
// $DATA_DIR contract end to end: a file written outside it is gone after a
// redeploy; a file written inside it survives.
// ---------------------------------------------------------------------------
const DOCKER_TEST_ENABLED = process.env['SANDBOX_DOCKER_TEST'] === '1';
const describeIfDocker = DOCKER_TEST_ENABLED ? describe : describe.skip;
const containersToClean: string[] = [];
const volumesToClean: string[] = [];

describeIfDocker('DockerPublishRuntime — real Docker (SANDBOX_DOCKER_TEST=1)', () => {
  after(() => {
    for (const name of containersToClean) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* best-effort cleanup */
      }
    }
    for (const name of volumesToClean) {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('deploys a real Node entrypoint and serves it on the assigned port', async () => {
    const runtime = new DockerPublishRuntime();
    const appId = `pub-serve-${String(Date.now())}`;
    const script =
      "const http=require('http'); http.createServer((req,res)=>{res.end('hello-from-published-app')}).listen(process.env.PORT);";
    await runtime.deploy({ appId, version: 1, entrypoint: 'server.js', files: new Map([['server.js', script]]) });
    containersToClean.push(_internal.containerNameFor(appId, 1));
    volumesToClean.push(_internal.dataVolumeFor(appId));

    const port = await runtime.portFor(appId, 1);
    assert.ok(port, 'expected an assigned host port');
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    const body = await response.text();
    assert.equal(body, 'hello-from-published-app');
  });

  it('$DATA_DIR contract: a file outside it is gone after redeploy; a file inside it survives', async () => {
    const runtime = new DockerPublishRuntime();
    const appId = `pub-datadir-${String(Date.now())}`;
    const writerScript = [
      "const fs=require('fs'), http=require('http');",
      "fs.writeFileSync('/app/ephemeral.txt', 'v1-ephemeral');",
      "fs.writeFileSync((process.env.DATA_DIR||'/data') + '/durable.txt', 'v1-durable');",
      "http.createServer((req,res)=>{res.end('v1')}).listen(process.env.PORT);",
    ].join('\n');
    await runtime.deploy({ appId, version: 1, entrypoint: 'writer.js', files: new Map([['writer.js', writerScript]]) });
    const v1Name = _internal.containerNameFor(appId, 1);
    containersToClean.push(v1Name);
    volumesToClean.push(_internal.dataVolumeFor(appId));

    // both files exist right after v1 deploys
    assert.equal(execFileSync('docker', ['exec', v1Name, 'cat', '/app/ephemeral.txt']).toString(), 'v1-ephemeral');
    assert.equal(execFileSync('docker', ['exec', v1Name, 'cat', '/data/durable.txt']).toString(), 'v1-durable');

    const readerScript = [
      "const http=require('http');",
      "http.createServer((req,res)=>{res.end('v2')}).listen(process.env.PORT);",
    ].join('\n');
    await runtime.deploy({ appId, version: 2, entrypoint: 'reader.js', files: new Map([['reader.js', readerScript]]) });
    const v2Name = _internal.containerNameFor(appId, 2);
    containersToClean.push(v2Name);

    let ephemeralSurvived = true;
    try {
      execFileSync('docker', ['exec', v2Name, 'cat', '/app/ephemeral.txt'], { stdio: 'pipe' });
    } catch {
      ephemeralSurvived = false;
    }
    assert.equal(ephemeralSurvived, false, 'a file written outside $DATA_DIR must NOT survive a redeploy');

    const durable = execFileSync('docker', ['exec', v2Name, 'cat', '/data/durable.txt']).toString();
    assert.equal(durable, 'v1-durable', 'a file written inside $DATA_DIR must survive a redeploy');
  });
});
