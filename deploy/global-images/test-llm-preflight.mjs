// Local-only regression checks. No .env, real API keys, or Docker operations.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const bash = process.env.BASH_BIN || (process.platform === 'win32'
  ? ['D:/git/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(existsSync)
  : 'bash');
assert.ok(bash, 'Set BASH_BIN to your Git Bash executable');
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url.startsWith('/unauthorized/')) {
    res.writeHead(401).end('do-not-log-response-or-key');
  } else if (req.url.startsWith('/partial/')) {
    res.writeHead(200, { 'Content-Length': '1000', Connection: 'close' });
    res.end('incomplete');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'glm-5.2' }] }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const shell = script => new Promise((resolve, reject) => {
  const child = spawn(bash, ['--noprofile', '--norc'], {
    cwd, env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, output }));
  child.stdin.end(`docker() { return 0; }\nsource ./_lib.sh\n${script}\n`);
});
let passed = 0;
async function check(name, script, expectedCode, pattern) {
  const result = await shell(script);
  assert.equal(result.code, expectedCode, `${name}: ${result.output}`);
  assert.match(result.output, pattern, name);
  assert.doesNotMatch(result.output, /200000|000000|do-not-log-response-or-key/, name);
  passed++;
  console.log(`PASS ${name}`);
}

try {
  // A real native curl writes a /tmp file while MSYS conversion is disabled.
  await check('native curl output path', `check_llm_openai local ${base}/ok fake-key glm-5.2`, 0, /\[ok\]/);
  await check('HTTP auth rejection', `check_llm_openai local ${base}/unauthorized fake-key glm-5.2`, 1, /HTTP 401/);
  await check('partial response after HTTP 200', `check_llm_openai local ${base}/partial fake-key glm-5.2`, 1, /HTTP=200，curl_exit=18/);
  await check('Anthropic response path', `check_llm_anthropic local ${base}/ok/v1 fake-key glm-5.2`, 0, /\[ok\]/);
  assert.ok(requests.includes('/ok/v1/messages'));
  for (const [rc, code] of [[23, '200'], [28, '200'], [7, '000']]) {
    for (const protocol of ['openai', 'anthropic']) {
      await check(`${protocol} curl exit ${rc}`, `
fake_curl() { printf '${code}'; return ${rc}; }
CURL=fake_curl
check_llm_${protocol} local http://unused.invalid/v1 fake-key glm-5.2`,
      1, new RegExp(`HTTP=${code}，curl_exit=${rc}`));
    }
  }
  // Load only the container probe, never verify.sh's executable deployment checks.
  const verify = readFileSync(new URL('./verify.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(verify, /^check_llm_(?:openai|anthropic|group)\(\)/m);
  const probe = verify.slice(verify.indexOf('check_llm_from_container()'), verify.indexOf('# 1. docker'));
  assert.ok(probe.includes('exec/curl_exit'));
  await check('container curl failure cannot report success', `${probe}
fake_docker() {
  if [[ "$1" == ps ]]; then printf 'test-container\\n'; else printf '200'; return 28; fi
}
DOCKER=fake_docker
WARNS=0
check_llm_from_container test-container local http://unused.invalid/v1 fake-key glm-5.2
[[ "$WARNS" == 1 ]]`, 0, /HTTP=200，exec\/curl_exit=28/);
  const core = readFileSync(new URL('./start-memory-core.sh', import.meta.url), 'utf8');
  const authProbe = core.slice(core.indexOf('verify_user_key()'), core.indexOf('info "初始化 admin user'));
  assert.ok(authProbe.includes('body.data?.valid === true'));
  for (const [name, response, exit] of [
    ['invalid key with HTTP 200', { code: 0, data: { valid: false } }, 1],
    ['valid key with HTTP 200', { code: 0, data: { valid: true, user: { user_id: 'test-user' } } }, 0],
    ['missing user identity', { code: 0, data: { valid: true } }, 1],
    ['nonzero envelope code', { code: 1, data: { valid: true, user: { user_id: 'test-user' } } }, 1],
  ]) {
    await check(name, `${authProbe}
llm_curl() { printf '%s' '${JSON.stringify(response)}' > "$1"; printf '200'; }
fake_docker() { shift 3; "$@"; }
DOCKER=fake_docker
CONTAINER=test-core
MEMORY_CORE_PORT=8420
printf 'auth envelope checked\\n'
verify_user_key fake-key`, exit, /auth envelope checked/);
  }
  console.log(`${passed} local regression checks passed; no external API or Docker calls.`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
