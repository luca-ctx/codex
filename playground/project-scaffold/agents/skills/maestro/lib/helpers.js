const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const { promises: fsp } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');

const MAESTRO_BINARY_ENV = 'MAESTRO_BINARY_PATH';

function resolveBinaryFromEnv() {
  const candidate = process.env[MAESTRO_BINARY_ENV];
  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function resolveBinaryFromWhich(binaryName) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(locator, [binaryName], { encoding: 'utf8' });
    if (result.status === 0) {
      const lines = (result.stdout || '').split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        return lines[0].trim();
      }
    }
  } catch (error) {
    // Ignore resolution failures and fall back to default paths.
  }
  return null;
}

function resolveBinaryFromDefault(binaryName) {
  const home = os.homedir();
  if (!home) {
    return null;
  }
  const defaultPath = path.join(home, '.maestro', 'bin', binaryName);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  return null;
}

function resolveMaestroBinary() {
  const binaryName = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  return (
    resolveBinaryFromEnv() ||
    resolveBinaryFromWhich(binaryName) ||
    resolveBinaryFromDefault(binaryName)
  );
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function runMaestro(args, options = {}) {
  const binary = resolveMaestroBinary();
  if (!binary) {
    throw new Error(
      'Maestro CLI not found. Install via "curl -Ls \"https://get.maestro.mobile.dev\" | bash" or set MAESTRO_BINARY_PATH.',
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      stdio: options.stdio ?? 'inherit',
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    });

    child.on('error', (error) => rejectPromise(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ code, args });
      } else {
        rejectPromise(new Error(`Maestro command failed with exit code ${code ?? -1}`));
      }
    });
  });
}

async function runTestFlow({
  flow,
  config,
  app,
  outputDir,
  device,
  format = 'junit',
  env = {},
  includeTags,
  excludeTags,
  extraArgs = [],
}) {
  if (!flow) {
    throw new Error('runTestFlow requires a path to a Maestro flow (YAML file or directory).');
  }

  const args = ['test', flow];

  if (config) {
    args.push('--config', config);
  }
  if (format) {
    args.push('--format', format);
  }
  if (outputDir) {
    await ensureDir(outputDir);
    args.push('--output', outputDir);
  }
  if (device) {
    args.push('--device', device);
  }
  if (app) {
    args.push('--app', app);
  }
  if (includeTags && includeTags.length) {
    args.push('--include-tags', includeTags.join(','));
  }
  if (excludeTags && excludeTags.length) {
    args.push('--exclude-tags', excludeTags.join(','));
  }
  if (extraArgs.length) {
    args.push(...extraArgs);
  }

  await runMaestro(args, { env: { ...process.env, ...env } });

  return { flow, outputDir };
}

async function takeScreenshot({ outputPath, device, label }) {
  if (!outputPath) {
    throw new Error('takeScreenshot requires an outputPath');
  }
  await ensureDir(path.dirname(outputPath));

  const args = ['screenshot', outputPath];
  if (device) {
    args.push('--device', device);
  }
  if (label) {
    args.push('--label', label);
  }

  await runMaestro(args);
  return outputPath;
}

async function clearAndroidLogcat() {
  try {
    const result = spawnSync('adb', ['logcat', '-c']);
    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Failed to clear logcat');
    }
  } catch (error) {
    console.warn(`[maestro-skill] Unable to clear Android logcat: ${error.message ?? error}`);
  }
}

async function startAndroidLogCapture({ outputPath, deviceId, filters = [] }) {
  const args = [];
  if (deviceId) {
    args.push('-s', deviceId);
  }
  args.push('logcat');

  if (filters.length) {
    args.push(...filters);
  } else {
    args.push('ReactNativeJS:V', 'ReactNative*:V', '*:S');
  }

  await clearAndroidLogcat();
  return spawnWithFile('adb', args, outputPath);
}

async function resolveIosDeviceId(preferredName) {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json']);
    const parsed = JSON.parse(stdout);
    const devices = Object.values(parsed.devices ?? {}).flat();
    if (!devices.length) {
      return null;
    }

    if (preferredName) {
      const namedBooted = devices.find((device) => device.state === 'Booted' && device.name === preferredName);
      if (namedBooted) {
        return namedBooted.udid;
      }

      const namedAvailable = devices.find((device) => device.isAvailable && device.name === preferredName);
      if (namedAvailable) {
        return namedAvailable.udid;
      }
    }

    const booted = devices.find((device) => device.state === 'Booted');
    return booted?.udid ?? null;
  } catch (error) {
    console.warn(`[maestro-skill] Unable to query iOS simulators: ${error.message ?? error}`);
    return null;
  }
}

async function startIosLogCapture({ outputPath, bundleId, deviceName, predicate }) {
  if (process.platform !== 'darwin') {
    console.warn('[maestro-skill] iOS log capture requires macOS.');
    return null;
  }

  const deviceId = await resolveIosDeviceId(deviceName);
  if (!deviceId) {
    console.warn('[maestro-skill] No booted iOS simulator found for log capture.');
    return null;
  }

  const effectivePredicate = predicate ?? (bundleId ? `process == "${bundleId}"` : null);
  const args = ['simctl', 'spawn', deviceId, 'log', 'stream', '--style', 'compact'];
  if (effectivePredicate) {
    args.push('--predicate', effectivePredicate);
  }

  return spawnWithFile('xcrun', args, outputPath);
}

function spawnWithFile(command, args, outputPath) {
  return new Promise((resolvePromise) => {
    const stream = fs.createWriteStream(outputPath, { flags: 'w' });
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;

    const resolveOnce = (value) => {
      if (!resolved) {
        resolved = true;
        resolvePromise(value);
      }
    };

    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });

    child.on('error', (error) => {
      console.warn(`[maestro-skill] Unable to start ${command} ${args.join(' ')}: ${error.message ?? error}`);
      stream.end();
      resolveOnce(null);
    });

    child.once('spawn', () => {
      resolveOnce({
        command,
        args,
        outputPath,
        stop: async () => {
          if (!child.killed) {
            child.kill('SIGINT');
            setTimeout(() => {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            }, 1000);
          }
          await once(child, 'close').catch(() => {});
          stream.end();
        },
      });
    });

    child.on('close', () => {
      if (!resolved) {
        stream.end();
        resolveOnce(null);
      }
    });
  });
}

function execFileAsync(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

async function startLogCapture({ platform, outputPath, bundleId, deviceName, filters, predicate }) {
  if (platform === 'android') {
    return startAndroidLogCapture({ outputPath, deviceId: deviceName, filters });
  }
  if (platform === 'ios') {
    return startIosLogCapture({ outputPath, bundleId, deviceName, predicate });
  }
  throw new Error(`Unsupported platform for log capture: ${platform}`);
}

module.exports = {
  resolveMaestroBinary,
  runMaestro,
  runTestFlow,
  takeScreenshot,
  startLogCapture,
  startAndroidLogCapture,
  startIosLogCapture,
  ensureDir,
};
