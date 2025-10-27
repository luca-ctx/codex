#!/usr/bin/env node
/**
 * Maestro Skill Executor
 *
 * Mirrors the Playwright skill wrapper but for Maestro CLI automation.
 * Allows running standalone Node scripts (from file, inline, or stdin)
 * with helpers available for running flows, capturing screenshots, and logs.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.chdir(__dirname);

const skillRoot = __dirname;
process.env.MAESTRO_SKILL_ROOT = skillRoot;
const helperModulePath = path.join(skillRoot, 'lib', 'helpers.js');

// Expose helpers for downstream scripts
if (fs.existsSync(helperModulePath)) {
  process.env.MAESTRO_SKILL_HELPERS = helperModulePath;
  global.__MAESTRO_HELPERS = require(helperModulePath);
}

// Ensure NODE_PATH includes the skill's node_modules and lib directory
const nodePathEntries = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
const skillNodeModules = path.join(skillRoot, 'node_modules');
if (fs.existsSync(skillNodeModules)) {
  nodePathEntries.unshift(skillNodeModules);
}
const libDir = path.join(skillRoot, 'lib');
if (!nodePathEntries.includes(libDir)) {
  nodePathEntries.unshift(libDir);
}
process.env.NODE_PATH = nodePathEntries.filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

const { resolveMaestroBinary } = global.__MAESTRO_HELPERS ?? require(helperModulePath);

const maestroBinary = resolveMaestroBinary();
if (maestroBinary) {
  process.env.MAESTRO_BINARY_PATH = maestroBinary;
  console.log(`Maestro Skill - Using CLI at ${maestroBinary}\n`);
} else {
  console.warn(
    'Maestro Skill - Warning: Maestro CLI not detected. Install it (https://maestro.mobile.dev/) or set MAESTRO_BINARY_PATH.\n',
  );
}

function getCodeToExecute() {
  const args = process.argv.slice(2);

  if (args.length > 0 && fs.existsSync(args[0])) {
    const filePath = path.resolve(args[0]);
    console.log(`Executing file: ${filePath}`);
    return fs.readFileSync(filePath, 'utf8');
  }

  if (args.length > 0) {
    console.log('Executing inline code');
    return args.join(' ');
  }

  if (!process.stdin.isTTY) {
    console.log('Reading from stdin');
    return fs.readFileSync(0, 'utf8');
  }

  console.error('No code provided. Usage:');
  console.error('  node run.js script.js');
  console.error('  node run.js "// inline code"');
  console.error('  cat script.js | node run.js');
  process.exit(1);
}

function wrapCodeIfNeeded(code) {
  const hasAsyncWrapper = code.includes('(async () =>') || code.includes('(async()=>');
  if (hasAsyncWrapper) {
    return code;
  }

  return `const helpers = global.__MAESTRO_HELPERS || require(process.env.MAESTRO_SKILL_HELPERS);
(async () => {
  try {
${code
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
  } catch (error) {
    console.error('Automation error:', error?.message ?? error);
    if (error?.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
`;
}

function main() {
  const rawCode = getCodeToExecute();
  const wrapped = wrapCodeIfNeeded(rawCode);

  const tempDir = path.join(os.tmpdir(), 'maestro-skill');
  fs.mkdirSync(tempDir, { recursive: true });

  const tempFile = path.join(tempDir, `.temp-execution-${Date.now()}.js`);
  fs.writeFileSync(tempFile, wrapped, 'utf8');

  console.log('Starting Maestro automation...\n');
  require(tempFile);
}

main();
