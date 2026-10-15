import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const allowed = new Set([
  '.github/workflows/test.yml', '.gitignore', 'LICENSE', 'README.md', 'INSTALLATION.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', 'bridge-origin.json', 'entry.mjs', 'plugin.mjs', 'auth.mjs', 'transport.mjs', 'sse.mjs',
  'bin/config-snippet.mjs', 'examples/opencode.json', 'test/entry.test.mjs', 'test/source-plugin.test.mjs',
  'test/source-transport.test.mjs', 'test/transport-regression.test.mjs', 'test/release-hygiene.test.mjs',
  'scripts/check-release.mjs',
]);
const oauthPrefix = ['sk', 'ant', 'oat'].join('-');
const fixtures = new Set([
  ...['fixture_token_123456', 'root_token_123456', 'SYNTHETICACCOUNT123',
    'SYNTHETICAUTH123', 'SYNTHETICKEYCHAIN123', 'PRIVATE123', 'PRIVATE'].map(suffix => oauthPrefix + suffix),
  ['sk', 'ant', 'api03_not-oauth-token'].join('-'),
]);

export function inspectText(text, file = '') {
  const findings = [];
  const add = (rule, count) => { if (count) findings.push({ rule, count }); };
  add('private-home-path', (text.match(/(?:\/(?:Users|home)\/(?!example\b|user\b)[A-Za-z0-9_.-]+(?:\/|(?=[\s'"]|$))|[A-Za-z]:\\Users\\(?!example\b|user\b)[A-Za-z0-9_.-]+(?:\\|(?=[\s'"]|$)))/gi) || []).length);
  add('email', (text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || []).filter(e =>
    !(file === 'test/source-transport.test.mjs' && e === ['pass', 'api.anthropic.com'].join('@'))
  ).length);
  const exempt = file.startsWith('test/') ? fixtures : new Set();
  const tokens = text.match(/\b(?:sk-ant-(?:oat|api03)[A-Za-z0-9_-]{7,}|sk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})/g) || [];
  add('credential-token', tokens.filter((token) => !exempt.has(token)).length);
  add('private-key', (text.match(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g) || []).length);
  return findings;
}

export function scan(root) {
  const failures = [];
  const visit = (dir, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (rel === '.git' || rel.startsWith('.git/') || rel === 'node_modules' || rel.startsWith('node_modules/')) continue;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) { failures.push({ file: rel, rule: 'symlink', count: 1 }); continue; }
      if (item.isDirectory()) { visit(full, rel); continue; }
      if (!item.isFile()) { failures.push({ file: rel, rule: 'unexpected-file-type', count: 1 }); continue; }
      if (!allowed.has(rel)) { failures.push({ file: rel, rule: 'unexpected-file', count: 1 }); continue; }
      if (/\.(?:env(?:\..*)?|pem|key|p12|pfx|jks)$/i.test(rel)) {
        failures.push({ file: rel, rule: 'private-artifact', count: 1 }); continue;
      }
      if (fs.statSync(full).size > 256 * 1024) { failures.push({ file: rel, rule: 'oversized-file', count: 1 }); continue; }
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { failures.push({ file: rel, rule: 'unreadable-file', count: 1 }); continue; }
      failures.push(...inspectText(text, rel).map((finding) => ({ file: rel, ...finding })));
    }
  };
  visit(root);
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = scan(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (failures.length) {
    for (const { file, rule, count } of failures) console.error(`${file}: ${rule} (${count})`);
    process.exitCode = 1;
  } else console.log('Release hygiene passed.');
}
