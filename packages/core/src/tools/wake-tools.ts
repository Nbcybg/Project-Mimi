import dgram from 'node:dgram';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from './registry.ts';

/** The "magic packet": six 0xFF bytes, then the MAC address sixteen times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new Error(`"${mac}" is not a MAC address (12 hex digits, e.g. 1A:2B:3C:4D:5E:6F).`);
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/**
 * Turns a computer on by Wake-on-LAN. It runs in the core, which has to be on the same
 * network and awake (a small always-on host, not the computer being woken). The computer
 * needs Wake-on-LAN switched on in its BIOS and network adapter settings.
 */
export function createWakeTools(): ToolDefinition<any>[] {
  const wake = defineTool({
    name: 'wake_pc',
    description:
      'Turn a computer on with Wake-on-LAN by sending its network adapter a magic packet. Needs the computer\'s MAC address (look in the user\'s profile, e.g. a "pc_mac" field, or ask). The computer must be on the same network as this assistant and have Wake-on-LAN enabled. It takes a minute or so to start.',
    risk: 'network',
    target: 'core',
    inputSchema: z.object({
      mac: z.string().min(12).describe('MAC address, e.g. 1A:2B:3C:4D:5E:6F'),
      broadcast: z.string().optional().describe('Broadcast address of the network (default 255.255.255.255)'),
      port: z.number().int().min(1).max(65535).optional().describe('UDP port (default 9)'),
    }),
    summarize: (input) => `Wake computer ${input.mac}`,
    async execute(input) {
      const packet = magicPacket(input.mac);
      const address = input.broadcast?.trim() || '255.255.255.255';
      const port = input.port ?? 9;
      await new Promise<void>((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', (error) => {
          socket.close();
          reject(error);
        });
        socket.bind(0, () => {
          socket.setBroadcast(true);
          socket.send(packet, port, address, (error) => {
            socket.close();
            if (error) reject(error);
            else resolve();
          });
        });
      });
      return `Sent the wake-up signal to ${input.mac} (via ${address}:${port}). The computer should start within a minute or two if Wake-on-LAN is on.`;
    },
  });
  return [wake];
}
