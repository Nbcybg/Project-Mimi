import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

/**
 * Hardens the Electron runtime in the packaged app. RunAsNode stays on because the PC agent
 * and the Workspace terminal start through Electron's own Node. NODE_OPTIONS and CLI inspect
 * arguments are turned off so a shortcut cannot add code or a debugger to the app.
 */
export async function applyFuses(executable, resetAdHocDarwinSignature = false) {
  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  console.log(`[build] Electron fuses applied to ${executable}`);
}
