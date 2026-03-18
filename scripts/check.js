const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['bot.js', 'commands', 'handlers', 'services', 'utils', 'scripts'];
const files = [];

function collect(target) {
  const full = path.join(process.cwd(), target);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile() && full.endsWith('.js')) {
    files.push(full);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(full)) {
    collect(path.join(target, entry));
  }
}

for (const root of roots) collect(root);

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} JavaScript file(s).`);
