import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureFileDrop } from '../public/components/skill-prompt-composer.mjs';

describe('agent terminal controls', () => {
  it('renders mobile tmux keys on agent sessions, including Shift+Tab', async () => {
    const terminalKeys = await readFile('public/components/terminal-keys.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    assert.match(terminalKeys, /onclick=\$\{k\('Up'\)\}/);
    assert.match(terminalKeys, /onclick=\$\{k\('Down'\)\}/);
    assert.match(terminalKeys, /onclick=\$\{k\('Left'\)\}/);
    assert.match(terminalKeys, /onclick=\$\{k\('Right'\)\}/);
    assert.match(terminalKeys, /onclick=\$\{k\('Tab'\)\}/);
    assert.match(terminalKeys, /onclick=\$\{k\('BTab'\)\}/);
    assert.match(agentDetail, /import \{ TerminalKeys \} from '\.\.\/components\/terminal-keys\.mjs';/);
    assert.match(agentDetail, /h\(TerminalKeys,\s*\{ onKey: sendTerminalKey \}\)/);
  });

  it('supports custom scheduled-send delays from the control bar', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');

    assert.match(controlBar, /const DELAY_UNITS = \[/);
    assert.match(controlBar, /selectedDelay\.value === 'custom'/);
    assert.match(controlBar, /customDelayAmount\.value/);
    assert.match(controlBar, /Math\.round\(amount \* Number\(customDelayUnit\.value/);
    assert.match(controlBar, /<option value="custom">Custom<\/option>/);
  });

  it('submits running-session sends to the harness while guarding typed dialog answers', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');
    const attentionPage = await readFile('public/pages/attention.mjs', 'utf8');
    const attentionState = await readFile('public/app/attention.mjs', 'utf8');
    const sessions = await readFile('modules/sessions/index.mjs', 'utf8');

    assert.match(controlBar, /state\?\.capabilities\?\.canQueueMessage !== true/);
    assert.match(controlBar, /state\?\.capabilities\?\.canAnswerInteraction === true/);
    assert.doesNotMatch(controlBar, /state\?\.capabilities\?\.sendMessage/);
    assert.match(controlBar, /state\?\.interaction\?\.options/);
    assert.doesNotMatch(controlBar, /needs_approval|needs_confirmation|waiting_for_input/);
    assert.match(agentDetail, /source:\s*'ui_dialog_answer'/);
    assert.match(agentDetail, /expectedRevision:\s*sessionState\.value\.revision/);
    assert.match(agentDetail, /expectedFingerprint:\s*sessionState\.value\.interaction\?\.fingerprint/);
    assert.match(agentDetail, /expectedInteractionKind:\s*sessionState\.value\.interaction\?\.kind/);
    assert.match(agentDetail, /api\.post\(`\$\{path\}\/keys`, \{ keys: text, \.\.\.guards \}\)/);
    assert.match(agentDetail, /source:\s*'ui'/);
    assert.match(agentDetail, /if \(!text\) \{[\s\S]*\/enter`/);
    assert.match(agentDetail, /descriptor\.enterSubmits[\s\S]*mapped\.value === 'Enter'[\s\S]*\/enter`/);
    assert.doesNotMatch(sessions, /allowActiveQueue:\s*config\.id === 'codex'/);
    assert.match(attentionPage, /source:\s*'ui_dialog_answer'/);
    assert.match(attentionPage, /expectedRevision:\s*item\.revision/);
    assert.match(attentionPage, /expectedFingerprint:\s*item\.interactionFingerprint/);
    assert.match(attentionPage, /expectedInteractionKind:\s*item\.interactionKind/);
    assert.match(attentionPage, /api\.post\(`\$\{path\}\/keys`, \{ keys: option\.key, \.\.\.guards \}\)/);
    assert.doesNotMatch(attentionState, /NUMBERED_OPTION|YES_NO_RE|parseAnswerOptions/);
  });

  it('focuses interactive terminal panes on pointer down', async () => {
    const terminal = await readFile('public/components/terminal.mjs', 'utf8');

    assert.match(terminal, /function handlePointerDown\(\)/);
    assert.match(terminal, /onPointerDown: handlePointerDown/);
  });

  it('bounds large image attachments and exposes image-send progress', async () => {
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');

    assert.match(agentDetail, /createImageBitmap\(file\)/);
    assert.match(agentDetail, /const maxDimension = 2048/);
    assert.match(agentDetail, /canvas\.toDataURL\('image\/jpeg', 0\.86\)/);
    assert.match(agentDetail, /if \(imageSending\.value\) return/);
    assert.match(agentDetail, /imageSending: imageSending\.value/);
    assert.match(controlBar, /disabled=\$\{imageSending/);
    assert.match(controlBar, /imageSending \? 'Sending…'/);
  });

  it('cancels advertised file drops even when the FileList is empty', () => {
    const forwarded = [];
    const emptyDrop = {
      dataTransfer: { types: ['Files'], files: [] },
      preventDefault() { this.prevented = true; },
    };
    assert.equal(captureFileDrop(emptyDrop, (files) => forwarded.push(files)), true);
    assert.equal(emptyDrop.prevented, true);
    assert.deepEqual(forwarded, []);

    const file = { type: 'image/png', name: 'shot.png' };
    const fileDrop = {
      dataTransfer: { types: ['Files'], files: [file] },
      preventDefault() { this.prevented = true; },
    };
    assert.equal(captureFileDrop(fileDrop, (files) => forwarded.push(files)), true);
    assert.equal(fileDrop.prevented, true);
    assert.deepEqual(forwarded, [[file]]);

    const textDrop = {
      dataTransfer: { types: ['text/plain'], files: [] },
      preventDefault() { this.prevented = true; },
    };
    assert.equal(captureFileDrop(textDrop, (files) => forwarded.push(files)), false);
    assert.equal(textDrop.prevented, undefined);
    assert.deepEqual(forwarded, [[file]]);
  });

  it('keeps one composer for text and image sends', async () => {
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');

    // A single draft feeds both paths: an attachment turns the message into the caption.
    assert.doesNotMatch(agentDetail, /Optional image context/);
    assert.match(agentDetail, /await sendImageToSession\(\)/);
    assert.match(agentDetail, /const caption = resolveQuickInserts\(raw\)/);
    assert.match(controlBar, /control-row-compose/);
    assert.doesNotMatch(controlBar, /onInsertBootstrap/);
  });

  it('keeps the gated escape and shift-tab actions on the bar', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    // The terminal key row only sends raw keys; POST /escape is the route the
    // server may promote to an interrupt, so it must stay reachable here.
    assert.match(controlBar, /title="Escape \/ interrupt"/);
    assert.match(controlBar, /descriptor\.hasShiftTab \? html`/);
    assert.match(agentDetail, /sessions\/\$\{id\}\/escape/);
  });

  it('pins the attachment preview inside the control bar', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    assert.match(controlBar, /control-row-attachment/);
    assert.match(agentDetail, /imagePreviewUrl: imageDraft\.value\.imageDataUrl/);
    assert.doesNotMatch(agentDetail, /session-image-preview/);
  });

  it('inserts quick-insert ids as tokens resolved at send time', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    assert.match(controlBar, /skillInsert\.current\?\.\(value, 'quick'\)/);
    assert.match(agentDetail, /function resolveQuickInserts\(text\)/);
    assert.match(agentDetail, /expandQuickTokens\(text, \(key\) =>/);
    // A chip whose target vanished must block the send, never fall through to
    // the bare-Enter passthrough.
    assert.match(agentDetail, /if \(missing\.length\) \{[\s\S]*return null;/);
    assert.match(agentDetail, /if \(text === null\) return;/);
    assert.match(agentDetail, /if \(caption === null\) return;/);
  });

  it('keeps the draft when a scheduled send never lands', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');
    const agentDetail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    assert.match(controlBar, /scheduled !== false && inputText\.value === draft/);
    assert.match(agentDetail, /addToast\('Nothing to schedule', 'error'\)/);
  });

  it('never lets an unused custom delay block an image send', async () => {
    const controlBar = await readFile('public/components/agent-control-bar.mjs', 'utf8');

    assert.match(controlBar, /if \(imageAttached\) \{\s*onSendInput\(\);/);
    assert.match(controlBar, /!imageAttached && selectedDelay\.value === 'custom'/);
    // ...but an image still has to clear the same queue capability gate as text.
    assert.match(controlBar, /\(imageAttached \|\| selectedScheduleDelay\(\) === 0\) && state\?\.capabilities\?\.canQueueMessage !== true/);
    assert.match(controlBar, /disabled=\$\{imageAttached\}/);
  });

  it('expands skill tokens in image captions like every other harness text', async () => {
    const sessions = await readFile('modules/sessions/index.mjs', 'utf8');

    assert.match(sessions, /caption: resolveHarnessUserText\(caption\)/);
    assert.match(sessions, /instruction: resolveHarnessUserText\(instruction\)/);
    // The caption is the whole draft now, so it must not name the upload file.
    assert.match(sessions, /filenameHint: filenameHint \|\| `\$\{config\.id\}-\$\{id\}-image`/);
  });
});
