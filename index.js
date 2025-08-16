// index.js
const [MAJ, MIN] = process.versions.node.split('.').map(n => parseInt(n, 10));
if (MAJ < 18 || (MAJ === 18 && MIN < 17)) {
  console.error(`Node 18.17+ required. You are on ${process.version}.`);
  process.exit(1);
}

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err?.stack || err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err?.stack || err);
  process.exit(1);
});

try {
  await import('./app.js');
} catch (err) {
  console.error('Failed to start:', err?.stack || err);
  process.exit(1);
}
