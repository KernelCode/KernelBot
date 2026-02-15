import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const LOGO = `
 ██╗  ██╗███████╗██████╗ ███╗   ██╗███████╗██╗     ██████╗  ██████╗ ████████╗
 ██║ ██╔╝██╔════╝██╔══██╗████╗  ██║██╔════╝██║     ██╔══██╗██╔═══██╗╚══██╔══╝
 █████╔╝ █████╗  ██████╔╝██╔██╗ ██║█████╗  ██║     ██████╔╝██║   ██║   ██║
 ██╔═██╗ ██╔══╝  ██╔══██╗██║╚██╗██║██╔══╝  ██║     ██╔══██╗██║   ██║   ██║
 ██║  ██╗███████╗██║  ██║██║ ╚████║███████╗███████╗██████╔╝╚██████╔╝   ██║
 ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚═════╝  ╚═════╝    ╚═╝
`;

export function showLogo() {
  console.log(chalk.cyan(LOGO));
  console.log(chalk.dim(`  AI Engineering Agent — v${getVersion()}\n`));
  console.log(
    boxen(
      chalk.yellow.bold('WARNING') +
        chalk.yellow(
          '\n\nKernelBot has full access to your operating system.\n' +
            'It can execute commands, read/write files, manage processes,\n' +
            'and interact with external services on your behalf.\n\n' +
            'Only run this on machines you control.\n' +
            'Set allowed_users in config.yaml to restrict access.',
        ),
      {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'yellow',
      },
    ),
  );
  console.log('');
}

export async function showStartupCheck(label, checkFn) {
  const spinner = ora({ text: label, color: 'cyan' }).start();
  try {
    await checkFn();
    spinner.succeed(chalk.green(label));
    return true;
  } catch (err) {
    spinner.fail(chalk.red(`${label} — ${err.message}`));
    return false;
  }
}

export function showStartupComplete() {
  console.log(
    boxen(chalk.green.bold('KernelBot is live'), {
      padding: 1,
      margin: { top: 1 },
      borderStyle: 'round',
      borderColor: 'green',
    }),
  );
}

export function showSuccess(msg) {
  console.log(
    boxen(chalk.green(msg), {
      padding: 1,
      borderStyle: 'round',
      borderColor: 'green',
    }),
  );
}

export function showError(msg) {
  console.log(
    boxen(chalk.red(msg), {
      padding: 1,
      borderStyle: 'round',
      borderColor: 'red',
    }),
  );
}

export function createSpinner(text) {
  return ora({ text, color: 'cyan' });
}
