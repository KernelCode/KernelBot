import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';

const LOGO = `
 ██╗  ██╗███████╗██████╗ ███╗   ██╗███████╗██╗     ██████╗  ██████╗ ████████╗
 ██║ ██╔╝██╔════╝██╔══██╗████╗  ██║██╔════╝██║     ██╔══██╗██╔═══██╗╚══██╔══╝
 █████╔╝ █████╗  ██████╔╝██╔██╗ ██║█████╗  ██║     ██████╔╝██║   ██║   ██║
 ██╔═██╗ ██╔══╝  ██╔══██╗██║╚██╗██║██╔══╝  ██║     ██╔══██╗██║   ██║   ██║
 ██║  ██╗███████╗██║  ██║██║ ╚████║███████╗███████╗██████╔╝╚██████╔╝   ██║
 ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚═════╝  ╚═════╝    ╚═╝
`;

// Create a vibrant rainbow gradient
const rainbowGradient = gradient([
  '#FF0080', // Hot Pink
  '#FF8C00', // Dark Orange
  '#FFD700', // Gold
  '#00FF00', // Lime Green
  '#00CED1', // Dark Turquoise
  '#1E90FF', // Dodger Blue
  '#9370DB'  // Medium Purple
]);

export function showLogo() {
  console.log(rainbowGradient.multiline(LOGO));
  console.log(chalk.dim('  AI Engineering Agent\n'));
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