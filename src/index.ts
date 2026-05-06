import { runCli } from './cli.js';

runCli(process.argv.slice(2))
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
