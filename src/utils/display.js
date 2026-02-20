import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';

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

// White to ~70% black gradient
const monoGradient = gradient([
  '#FFFFFF',
  '#D0D0D0',
  '#A0A0A0',
  '#707070',
  '#4D4D4D',
]);

export function showLogo() {
  console.log(monoGradient.multiline(LOGO));
  console.log(chalk.dim(`  AI Engineering Agent — v${getVersion()}\n`));
  console.log(
    boxen(
      chalk.yellow.bold('WARNING') +
        chalk.yellow(
          '\n\nKernelBot has full access to your operating system.\n' +
            'It can execute commands, read/write files, manage processes,\n' +
            'and interact with external services on your behalf.\n\n' +
            'Only run this on machines you control.\n' +
            'Set OWNER_TELEGRAM_ID in .env or allowed_users in config.yaml.',
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