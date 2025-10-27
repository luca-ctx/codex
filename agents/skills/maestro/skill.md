---
name: Maestro Mobile Automation
description: Run Maestro flows for the patient and clinic apps, capture screenshots, and stream device logs across Android and iOS.
---

# Maestro Mobile Automation

Complete mobile automation for the Patient and Clinic apps using Maestro CLI. Use this when you need to run `.maestro` flows, capture reproducible screenshots, or stream device logs for debugging on Android emulators and iOS simulators.

**CRITICAL WORKFLOW — Follow in Order**

1. **Install Maestro CLI** (skip if already present)
   ```bash
   curl -Ls "https://get.maestro.mobile.dev" | bash
   export PATH="$PATH:$HOME/.maestro/bin"
   ```
   Verify with `maestro --version`. The skill auto-resolves `$HOME/.maestro/bin/maestro`, or honour `MAESTRO_BINARY_PATH` if you prefer a custom location.

2. **Build the apps once per platform** (artifacts land in `tests/maestro/builds/**` and are reused)
   ```bash
   pnpm maestro:build            # both platforms
   pnpm maestro:build:android    # just Android
   pnpm maestro:build:ios        # macOS only
   ```

3. **Boot target devices**
   - Android: start the AVD named in `tests/maestro/manifest.json` (default `pixel_6`). Ensure `adb devices` lists it.
   - iOS (macOS): boot the simulator listed in the manifest (default `iPhone 15`). `xcrun simctl list | grep Booted` should show it.

4. **Run flows / capture artifacts** using this skill wrapper:
   ```bash
   node run.js /tmp/maestro-script.js
   ```
   The executor exposes helpers via `const helpers = global.__MAESTRO_HELPERS` and sets `process.env.MAESTRO_SKILL_ROOT` so you can resolve repo paths without hardcoding.

References: `tests/maestro/README.md` documents the curated suite orchestrated by `scripts/run-maestro.mjs`. Use this skill for bespoke experiments, one-off screenshots, or to debug flows before baking them into the main runner.

## Helper Overview

`helpers = global.__MAESTRO_HELPERS || require(process.env.MAESTRO_SKILL_HELPERS)` exposes:

- `helpers.resolveMaestroBinary()` → path to the CLI (throws if missing)
- `helpers.runTestFlow({ flow, config, app, device, outputDir, env, includeTags, excludeTags, extraArgs })`
- `helpers.takeScreenshot({ outputPath, device, label })`
- `helpers.startLogCapture({ platform, outputPath, bundleId, deviceName, filters, predicate })`
- `helpers.startAndroidLogCapture(...)`, `helpers.startIosLogCapture(...)` for direct control
- `helpers.ensureDir(path)` convenience mkdir

All paths can be resolved relative to `process.env.MAESTRO_SKILL_ROOT` (e.g. `path.join(process.env.MAESTRO_SKILL_ROOT, '..', '..', 'tests', 'maestro', 'flows', ...)`).

## Execution Pattern

```javascript
// /tmp/maestro-patient-login.js
const path = require('node:path');
const helpers = global.__MAESTRO_HELPERS;

const ROOT = process.env.MAESTRO_SKILL_ROOT;
const WORKSPACE = path.resolve(ROOT, '..', '..');
const FLOWS_DIR = path.join(WORKSPACE, 'tests', 'maestro');
const ARTIFACT_ROOT = path.join('/tmp', `maestro-artifacts-${Date.now()}`);

await helpers.ensureDir(ARTIFACT_ROOT);

const logCapture = await helpers.startLogCapture({
  platform: 'android',
  outputPath: path.join(ARTIFACT_ROOT, 'patient-android-logcat.log'),
  bundleId: 'com.profoundinstitute.patient',
});

try {
  await helpers.runTestFlow({
    flow: path.join(FLOWS_DIR, 'flows/patient/login-and-home.yaml'),
    config: path.join(FLOWS_DIR, 'maestro.config.yaml'),
    app: path.join(WORKSPACE, 'tests/maestro/builds/patient-app/android/app-debug.apk'),
    outputDir: path.join(ARTIFACT_ROOT, 'patient-login'),
  });

  await helpers.takeScreenshot({
    outputPath: path.join(ARTIFACT_ROOT, 'patient-login.png'),
    label: 'patient-login',
  });
} finally {
  if (logCapture?.stop) {
    await logCapture.stop();
  }
}

console.log(`Artifacts saved to ${ARTIFACT_ROOT}`);
```

Run it:

```bash
node icp/skills/maestro/run.js /tmp/maestro-patient-login.js
```

The script launches the flow, captures Android logcat filtered to the patient bundle ID, and writes a PNG screenshot. Swap `platform: 'ios'` plus `bundleId: 'com.profoundinstitute.patient'` to capture simulator logs on macOS.

## Clinic App Screenshot & Logs (Android)

```javascript
const path = require('node:path');
const helpers = global.__MAESTRO_HELPERS;
const ROOT = process.env.MAESTRO_SKILL_ROOT;
const WORKSPACE = path.resolve(ROOT, '..', '..');
const ARTIFACT_DIR = path.join('/tmp', 'clinic-artifacts');

await helpers.ensureDir(ARTIFACT_DIR);

const logSession = await helpers.startLogCapture({
  platform: 'android',
  outputPath: path.join(ARTIFACT_DIR, 'clinic-logcat.log'),
  bundleId: 'com.profoundinstitute.clinic',
});

try {
  await helpers.runTestFlow({
    flow: path.join(WORKSPACE, 'tests/maestro/flows/clinic/create-handoff.yaml'),
    config: path.join(WORKSPACE, 'tests/maestro/maestro.config.yaml'),
    app: path.join(WORKSPACE, 'tests/maestro/builds/clinic-app/android/app-debug.apk'),
    outputDir: path.join(ARTIFACT_DIR, 'clinic-handoff'),
  });

  await helpers.takeScreenshot({
    outputPath: path.join(ARTIFACT_DIR, 'clinic-handoff.png'),
  });
} finally {
  await logSession?.stop?.();
}
```

## iOS Simulator Variant

On macOS the same helpers can snapshot the iOS simulator. Provide the bundle identifier and, optionally, a simulator name if you do not want the “booted” default.

```javascript
const path = require('node:path');
const helpers = global.__MAESTRO_HELPERS;

const WORKSPACE = path.resolve(process.env.MAESTRO_SKILL_ROOT, '..', '..');
const OUT_DIR = path.join('/tmp', 'patient-ios-artifacts');
await helpers.ensureDir(OUT_DIR);

const iosLogs = await helpers.startLogCapture({
  platform: 'ios',
  outputPath: path.join(OUT_DIR, 'patient-ios.log'),
  bundleId: 'com.profoundinstitute.patient',
  deviceName: 'iPhone 15',
});

try {
  await helpers.runTestFlow({
    flow: path.join(WORKSPACE, 'tests/maestro/flows/patient/appointment-join.yaml'),
    config: path.join(WORKSPACE, 'tests/maestro/maestro.config.yaml'),
    app: path.join(WORKSPACE, 'tests/maestro/builds/patient-app/ios/ProfoundPatient.app'),
    device: 'iPhone 15',
    outputDir: path.join(OUT_DIR, 'patient-appointment'),
  });
  await helpers.takeScreenshot({
    outputPath: path.join(OUT_DIR, 'patient-appointment.png'),
    device: 'iPhone 15',
  });
} finally {
  await iosLogs?.stop?.();
}
```

This mirrors the behaviour of `scripts/run-maestro.mjs`: artifacts are grouped per flow, screenshots land alongside JUnit output, and device logs stream to the designated files.

## Tips & Troubleshooting

- Set `MAESTRO_BINARY_PATH` if the CLI lives outside `~/.maestro/bin` or the system PATH.
- For Expo-managed development builds, ensure the Metro bundler is running and that the build artifacts point at the local packager URL before running flows.
- Prefer Maestro-native screenshots—add a flow `screenshot` step or call `helpers.takeScreenshot({ ... })` right after reaching the target view so you capture device-resolution pixels instead of cropping afterward.
- When capturing Android screenshots only (without flows), call `helpers.takeScreenshot({ outputPath, device })` after `maestro launchApp` commands.
- To reuse the curated automation: `pnpm test:maestro -- --platform android --flow patient-login-home`. The helper functions accept the same paths and environment variables as the workspace runner.
- Stop log capture sessions in a `finally {}` block to release file handles; otherwise subsequent runs may fail to truncate log files.

With this skill you can iterate quickly on Maestro flows, verify UI states (via screenshots), and collect logs for both the Patient and Clinic applications across Android emulators and iOS simulators.
