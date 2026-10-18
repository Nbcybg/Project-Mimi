import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import { MemoryError, MemoryStore } from '../memory/store.ts';
import { loadSettings } from '../providers/settings.ts';
import { formatMemoryEntry, formatMemoryList, MEMORY_NOTE } from './commands.ts';

const USAGE = `Usage: npm run memory -- <command>
  list                                   list memory files
  show <path>                            print a file
  edit <path> [--description "..."]      open a file in $EDITOR (notepad on Windows)
  set <path> --file <file> [--description "..."]   replace a file's content from a text file
  delete <path>                          delete a file`;

/** Opens `initial` in the user's editor and returns the saved text. */
function editInEditor(name: string, initial: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-memory-'));
  const file = path.join(dir, `${name.replaceAll('/', '_')}.md`);
  fs.writeFileSync(file, initial, 'utf8');
  const editor = process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi');
  // One command string, so $EDITOR may carry its own arguments ("code --wait").
  const result = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
  if (result.error) throw new Error(`Could not start editor "${editor}": ${result.error.message}`);
  const edited = fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return edited;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { description: { type: 'string' }, file: { type: 'string' } },
});
const [command, target] = positionals;
const config = loadConfig();
const settings = loadSettings(config.settingsPath);
const db = openDb(config.dbPath);
const memory = new MemoryStore(db, { profileMaxChars: settings.memory.profile_max_chars });

try {
  if (command === undefined || command === 'list') {
    console.log(formatMemoryList(memory));
  } else if (!target) {
    console.log(USAGE);
  } else if (command === 'show') {
    console.log(formatMemoryEntry(memory, target));
  } else if (command === 'delete') {
    console.log(memory.delete(target) ? `Deleted ${target}. ${MEMORY_NOTE}` : `No memory file "${target}".`);
  } else if (command === 'set' && !values.file) {
    console.log(USAGE);
  } else if (command === 'edit' || command === 'set') {
    const before = memory.get(target)?.content ?? '';
    const content = values.file ? fs.readFileSync(values.file, 'utf8') : editInEditor(target, before);
    if (content.trim() === before.trim() && values.description === undefined) {
      console.log('No changes.');
    } else {
      const entry = memory.write({ path: target, description: values.description, content });
      console.log(`Saved ${entry.path} (${entry.content.length} characters). ${MEMORY_NOTE}`);
    }
  } else {
    console.log(USAGE);
  }
} catch (error) {
  if (!(error instanceof MemoryError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
