import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db/db.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { createDefaultRecipes } from '../tasks/recipes.ts';
import { TaskRepo } from '../tasks/repo.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { FakeBroker, collect, eventsOf } from './helpers.ts';

const SNAPSHOT = `Page: Upload
URL: https://www.youtube.com/upload
Elements you can use (refs change when the page does):
[e1] input(file) "Select files"
[e2] textbox "Add a title"
[e3] textbox "Tell viewers about your video"
[e4] radio "Unlisted"
[e5] radio "No, it's not made for kids"
[e6] button "Save"

Text on the page:
Upload your video`;

function fakeBrowser(handoff = false) {
  let uploaded = false;
  const calls: Array<{ tool: string; input: any }> = [];
  const execute = async (tool: string, input: any) => {
    calls.push({ tool, input });
    switch (tool) {
      case 'file_info':
        return 'path: video.mp4\ntype: file\nsize: 1 B';
      case 'browser_open':
        return 'Opened: YouTube - https://www.youtube.com/upload';
      case 'browser_check':
        return JSON.stringify(
          handoff
            ? { ok: true, url: 'https://www.youtube.com/upload', title: 'Sign in', handoff: { kind: 'login', detail: 'The page asks for a password.' }, summary: 'login' }
            : {
                ok: true,
                url: uploaded ? 'https://studio.youtube.com/video/abc12345678/edit' : 'https://www.youtube.com/upload',
                title: 'Upload',
                handoff: null,
                summary: 'No handoff.',
              },
        );
      case 'browser_snapshot':
        return SNAPSHOT;
      case 'browser_upload':
        if (handoff) return 'Handoff: The page asks for a password.';
        uploaded = true;
        return 'Uploaded 1 file(s) to e1. Now: Upload - https://www.youtube.com/upload';
      case 'browser_type':
      case 'browser_select':
      case 'browser_click':
        return `OK: ${tool} ${input.ref}`;
      case 'browser_wait':
        return 'Wait finished: Edit video - https://studio.youtube.com/video/abc12345678/edit';
      default:
        throw new Error(`Unexpected tool ${tool}`);
    }
  };
  return { execute, calls };
}

function runnerFor(browser: ReturnType<typeof fakeBrowser>) {
  const repo = new TaskRepo(openDb(':memory:'));
  const gate = new PermissionGate(new FakeBroker(true), { timeoutMs: 2_000 });
  const runner = new TaskRunner({
    repo,
    recipes: createDefaultRecipes(),
    gate,
    execute: async (tool, input) => browser.execute(tool, input),
  });
  return { repo, runner };
}

test('youtube recipe: upload an unlisted video, fill metadata and verify the URL', async () => {
  const browser = fakeBrowser();
  const { runner, repo } = runnerFor(browser);
  const events = await collect(
    runner.run({
      recipe: 'youtube-upload',
      goal: 'upload the demo',
      input: { path: 'video.mp4', title: 'Demo video', description: 'A demo', visibility: 'unlisted' },
      traceId: 'youtube-trace',
      thread: 'main',
      agent: 'mimi',
    }),
  );
  const finish = eventsOf(events, 'task-finish')[0]!;
  assert.equal(finish.status, 'completed', finish.receipt?.summary ?? '');
  const receipt = eventsOf(events, 'task-receipt')[0]!;
  assert.match(receipt.receipt.summary, /https:\/\/youtu\.be\/abc12345678/);
  assert.equal(receipt.receipt.undoable, false);
  assert.equal(eventsOf(events, 'permission-request').length, 1, 'unlisted needs one approval');
  assert.equal(browser.calls.some((call) => call.tool === 'browser_type' && call.input.text === 'Demo video'), true);
  assert.equal(browser.calls.some((call) => call.tool === 'browser_upload' && call.input.paths[0] === 'video.mp4'), true);
  const stored = repo.get(eventsOf(events, 'task-start')[0]!.task.id)!;
  assert.equal(stored.status, 'completed');
  assert.equal(stored.verification?.ok, true);
});

test('youtube recipe: a public publish needs a second confirmation', async () => {
  const browser = fakeBrowser();
  const { runner } = runnerFor(browser);
  const events = await collect(
    runner.run({
      recipe: 'youtube-upload',
      goal: 'publish the demo',
      input: { path: 'video.mp4', title: 'Demo video', visibility: 'public' },
      traceId: 'youtube-public',
      thread: 'main',
      agent: 'mimi',
    }),
  );
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'completed');
  assert.equal(eventsOf(events, 'permission-request').length, 2, 'upload + public publish');
});

test('youtube recipe: a login handoff stops before uploading', async () => {
  const browser = fakeBrowser(true);
  const { runner } = runnerFor(browser);
  const events = await collect(
    runner.run({
      recipe: 'youtube-upload',
      goal: 'upload the demo',
      input: { path: 'video.mp4', title: 'Demo video', visibility: 'unlisted' },
      traceId: 'youtube-handoff',
      thread: 'main',
      agent: 'mimi',
    }),
  );
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'cancelled');
  assert.equal(browser.calls.some((call) => call.tool === 'browser_upload'), false);
});
