// One image, two roles. Normally this starts a core (run-core.ts). With MIMI_MODE=gateway
// it starts the accounts gateway instead: the public entry that signs people in and passes
// them on to their own core (docs/hosting.md, "Railway: several people").
if (process.env.MIMI_MODE === 'gateway') {
  await import('../gateway/main.ts');
} else {
  await import('./run-core.ts');
}
