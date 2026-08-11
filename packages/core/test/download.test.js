import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from '../dist/node.js';

/** A stand-in file host, so the download path is exercised without a network. */
async function withServer(body, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${server.address().port}/ggml-test.bin`;
  try {
    return await fn(url);
  } finally {
    await new Promise((closed) => server.close(closed));
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ppr-download-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('a download whose bytes do not match its digest never lands on disk', async () => {
  await withTempDir(async (dir) => {
    const destination = join(dir, 'ggml-test.bin');
    const expected = sha256(Buffer.from('the model that was reviewed'));

    await withServer(Buffer.from('something else entirely'), async (url) => {
      await assert.rejects(
        () => downloadFile(url, destination, { sha256: expected }),
        (err) => {
          assert.match(err.message, /Checksum mismatch/);
          // The message has to name both digests, or "it did not match" is
          // unactionable: you cannot tell a stale digest from a bad download.
          assert.match(err.message, new RegExp(expected));
          assert.match(err.message, new RegExp(sha256(Buffer.from('something else entirely'))));
          return true;
        },
      );
    });

    // Neither the destination nor the `.part` file may survive — a half-checked
    // model left behind is one a later run would happily load.
    assert.deepEqual(await readdir(dir), []);
  });
});

test('a matching digest completes the download and renames it into place', async () => {
  await withTempDir(async (dir) => {
    const destination = join(dir, 'ggml-test.bin');
    const body = Buffer.from('the model that was reviewed');

    const result = await withServer(body, (url) => downloadFile(url, destination, { sha256: sha256(body) }));

    assert.equal(result.skipped, false);
    assert.equal(result.path, destination);
    assert.equal(result.bytes, body.length);
    assert.deepEqual(await readdir(dir), ['ggml-test.bin']);
    assert.deepEqual(await readFile(destination), body);
  });
});

test('a file that is already there is checked too, not trusted for being present', async () => {
  await withTempDir(async (dir) => {
    const destination = join(dir, 'ggml-test.bin');
    const body = Buffer.from('the model that was reviewed');
    await writeFile(destination, 'a bad first download');

    // No server: skipExisting must not reach the network at all, so a check
    // that only ran on fresh downloads would be bypassed by this file forever.
    await assert.rejects(
      () => downloadFile('http://127.0.0.1:1/ggml-test.bin', destination, { sha256: sha256(body) }),
      /Checksum mismatch/,
    );

    await writeFile(destination, body);
    const result = await downloadFile('http://127.0.0.1:1/ggml-test.bin', destination, { sha256: sha256(body) });
    assert.equal(result.skipped, true);
    assert.equal(result.bytes, body.length);
  });
});
