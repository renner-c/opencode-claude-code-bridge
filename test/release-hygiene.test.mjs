import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectText } from '../scripts/check-release.mjs';

test('reports private home paths and emails without returning matched text', () => {
  const privatePath = ['path ', '/Users/', 'fixture-person/project'].join('');
  const address = ['fixture-person', 'example.org'].join('@');
  const result = inspectText(privatePath + ' contact ' + address);
  assert.deepEqual(result.map(({ rule }) => rule), ['private-home-path', 'email']);
  assert.ok(result.every(finding => !JSON.stringify(finding).includes('fixture-person')));
});

test('allows only exact synthetic credential fixtures in tests', () => {
  const prefix = ['sk', 'ant', 'oat'].join('-');
  const values = ['fixture_token_123456', 'SYNTHETICACCOUNT123', 'PRIVATE123', 'root_token_123456'].map(suffix => prefix + suffix);
  values.push(['sk', 'ant', 'api03_not-oauth-token'].join('-'));
  for (const value of values) {
    assert.deepEqual(inspectText(value, 'test/example.test.mjs'), []);
    assert.ok(inspectText(value, 'README.md').length > 0);
  }
  assert.ok(inspectText(prefix + 'unlisted_test_credential', 'test/example.test.mjs').length > 0);
});

test('detects multiple credential families and private key markers without returning values', () => {
  const values = [
    ['ghp', 'TESTCREDENTIAL123456789'].join('_'),
    ['github', 'pat', 'TESTCREDENTIAL123456789'].join('_'),
    ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['sk', 'proj', 'TESTCREDENTIAL1234567890123'].join('-'),
  ];
  for (const value of values) assert.deepEqual(inspectText(value), [{ rule: 'credential-token', count: 1 }]);
  assert.deepEqual(inspectText(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')), [{ rule: 'private-key', count: 1 }]);
});
