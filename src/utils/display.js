import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';

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
  console.log(chalk.dim('  AI Engineering Agent\n'));
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

export function showHelp() {
  showLogo();
  console.log(
    boxen(
      [
        chalk.bold('Commands:'),
        '',
        `  ${chalk.cyan('kernelbot start')}          ${chalk.dim('Launch the Telegram bot')}`,
        `  ${chalk.cyan('kernelbot run')} ${chalk.yellow('"prompt"')}   ${chalk.dim('One-off agent call (no Telegram)')}`,
        `  ${chalk.cyan('kernelbot check')}          ${chalk.dim('Validate config & test APIs')}`,
        `  ${chalk.cyan('kernelbot init')}           ${chalk.dim('Interactive setup wizard')}`,
        '',
        chalk.dim(`  kernelbot --help         Show all options`),
      ].join('\n'),
      {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
      },
    ),
  );
}

export function createSpinner(text) {
  return ora({ text, color: 'cyan' });
}
