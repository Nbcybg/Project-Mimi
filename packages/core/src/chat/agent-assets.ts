import fs from 'node:fs';
import path from 'node:path';

/**
 * The 3D side of an agent: one VRM model (`model.vrm`) and a set of named
 * motion clips (`motion/<name>.fbx`, typically Mixamo exports). Everything
 * lives in the agent's own folder, like the pictures in `agent-images.ts`.
 */
const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
/** Motion names must be safe file names; the UI strips anything else out. */
const MOTION_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_MOTION_NAME = 64;
const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const MAX_MOTION_BYTES = 64 * 1024 * 1024;

export interface MotionView {
  name: string;
  /** mtimeMs of the file, so clients know when to fetch it again. */
  version: string;
}

export class AgentAssets {
  private readonly agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  private folder(agent: string): string | undefined {
    return AGENT_NAME.test(agent) ? path.join(this.agentsDir, agent) : undefined;
  }

  private modelFile(agent: string): string | undefined {
    const folder = this.folder(agent);
    return folder && path.join(folder, 'model.vrm');
  }

  private motionFile(agent: string, name: string): string | undefined {
    const folder = this.folder(agent);
    return folder && MOTION_NAME.test(name) ? path.join(folder, 'motion', `${name}.fbx`) : undefined;
  }

  // ---------- model ----------

  readModel(agent: string): Buffer | undefined {
    const file = this.modelFile(agent);
    return file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  /** Changes whenever the model does, so clients know when to fetch it again; null when there is none. */
  modelVersion(agent: string): string | null {
    const file = this.modelFile(agent);
    return file && fs.existsSync(file) ? String(Math.round(fs.statSync(file).mtimeMs)) : null;
  }

  saveModel(agent: string, data: Buffer): void {
    const folder = this.folder(agent);
    if (!folder) throw new Error('Unknown agent.');
    if (data.length === 0) throw new Error('The file is empty.');
    if (data.length > MAX_MODEL_BYTES) throw new Error('The VRM file must be smaller than 128 MB.');
    this.removeModel(agent);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'model.vrm'), data);
  }

  removeModel(agent: string): void {
    const file = this.modelFile(agent);
    if (file && fs.existsSync(file)) fs.rmSync(file);
  }

  // ---------- motions ----------

  motions(agent: string): MotionView[] {
    const folder = this.folder(agent);
    const dir = folder && path.join(folder, 'motion');
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith('.fbx'))
      .map((entry) => {
        const file = path.join(dir, entry);
        return { name: entry.slice(0, -4), version: String(Math.round(fs.statSync(file).mtimeMs)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readMotion(agent: string, name: string): Buffer | undefined {
    const file = this.motionFile(agent, name);
    return file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  saveMotion(agent: string, name: string, data: Buffer): void {
    const file = this.motionFile(agent, name);
    if (!file) throw new Error('Unknown agent or invalid motion name.');
    if (data.length === 0) throw new Error('The file is empty.');
    if (data.length > MAX_MOTION_BYTES) throw new Error('The FBX file must be smaller than 64 MB.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }

  removeMotion(agent: string, name: string): void {
    const file = this.motionFile(agent, name);
    if (file && fs.existsSync(file)) fs.rmSync(file);
  }

  /** Motion names the client may save; the UI passes them through this first. */
  static cleanMotionName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/\.fbx$/i, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_MOTION_NAME);
  }

  forget(agent: string): void {
    const folder = this.folder(agent);
    if (folder && fs.existsSync(folder)) {
      const dir = path.join(folder, 'motion');
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    this.removeModel(agent);
  }

  /** Moves the model and motions when an agent is renamed; the new folder must already exist. */
  rename(from: string, to: string): void {
    const target = this.folder(to);
    if (!target) return;
    const model = this.modelFile(from);
    if (model && fs.existsSync(model)) {
      this.removeModel(to);
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(model, path.join(target, 'model.vrm'));
    }
    const dir = path.join(this.folder(from) ?? '', 'motion');
    if (dir && fs.existsSync(dir)) {
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(dir, path.join(target, 'motion'));
    }
  }
}
