export interface ComputerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  app?: string;
  bounds?: ComputerBounds;
  focused?: boolean;
  /** A password/secure field: Mimi must never type here. */
  secure?: boolean;
  disabled?: boolean;
  children?: ComputerNode[];
}

export interface ComputerWindow {
  app: string;
  title: string;
  active: boolean;
}

export interface ComputerSnapshot {
  platform: NodeJS.Platform;
  activeApp: string;
  windows: ComputerWindow[];
  nodes: ComputerNode[];
  capturedAt: string;
}

export interface ComputerAppInfo {
  name: string;
  active: boolean;
  windows: string[];
}

/** Everything the tools need from a platform's accessibility/input layer. */
/** A stable ref for one observed element: the path of child indexes from the window. */
export function nodeRef(path: number[]): string {
  return `c${path.join('.')}`;
}

export interface ComputerAdapter {
  observe(options: { app?: string; depth?: number }): Promise<ComputerSnapshot>;
  click(ref: string): Promise<{ ref: string; target: string }>;
  type(ref: string, text: string): Promise<{ ref: string; target: string }>;
  key(key: string): Promise<void>;
  scroll(ref: string | undefined, direction: 'up' | 'down', amount: number): Promise<void>;
  apps(): Promise<ComputerAppInfo[]>;
  activate(app: string): Promise<void>;
  menu(app: string, path: string[]): Promise<void>;
  capture(): Promise<Buffer>;
}
