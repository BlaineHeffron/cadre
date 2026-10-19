#!/usr/bin/env node
// Machine pairing CLI. Like the service (WorkingDirectory=), it runs in its own checkout, so config reads that
// checkout's .env (values already set in the shell win) and the state dir is that instance's.
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const { config } = await import('../config.mjs');
const { runtimeStatePath } = await import('../modules/ops/runtime-state.mjs');
const { addMachine, forgetMachine, machineState, pairLink } = await import('../modules/machines/index.mjs');

const store = machineState(runtimeStatePath('machines'));
const [command, sub, ...rest] = process.argv.slice(2);
try {
  if (command === 'pair') {
    if (config.role !== 'worker') throw new Error('Run `cadre pair` on a worker (CADRE_ROLE=worker).');
    console.log(pairLink(store, config.host, config.port));
    console.error('One-time link, valid for 5 minutes. Treat it like a password.');
  } else if (command === 'unpair') {
    store.unpair();
    console.log('Unpaired: this worker no longer accepts its hub.');
  } else if (command === 'machine' && sub === 'add' && rest.length === 2) {
    const { id, label, warning } = await addMachine(store, rest[0], rest[1], { hubMcpUrl: config.machines.hubMcpUrl });
    console.log(`Paired ${id} (${label}).`);
    if (warning) console.warn(`warning: ${warning}`);
  } else if (command === 'machine' && sub === 'forget' && rest.length === 1) {
    const pending = await forgetMachine(store, rest[0]);
    console.log(pending.length ? `Revoked on the hub. Pending on unreachable workers: ${pending.join(', ')}; re-run forget when they are back.` : 'Revoked on both sides.');
  } else {
    console.error('usage: cadre pair | cadre unpair | cadre machine add <name> <link> | cadre machine forget <name>');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
