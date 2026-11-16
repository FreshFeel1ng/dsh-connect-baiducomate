'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const files = [
  path.join(root, 'comate-shim.js'),
  ...fs
    .readdirSync(path.join(root, 'src'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(root, 'src', file)),
  ...fs
    .readdirSync(path.join(root, 'lib'))
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => path.join(root, 'lib', file)),
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`syntax ok: ${files.length} files`);
