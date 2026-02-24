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
          ▄▄████████▄▄
       ▄██▀▀        ▀▀██▄
     ▄█▀    ▄██████▄    ▀█▄
    █▀   ▄██▀      ▀██▄   ▀█
   █▀  ▄█▀   ▄████▄  ▀█▄  ▀█
  ▐█  ██   ▄█▀    ▀█▄  ██  █▌
  ▐█  █▌  █▀   ██   ▀█ ▐█  █▌
  ▐█  █▌  ▀█▄  ▀▀██▀  ▐█  █▌
   █▄  ██   ▀▀████▀  ██  ▄█
    █▄  ▀██▄      ▄██▀  ▄█
     ▀█▄   ▀██████▀   ▄█▀
       ▀██▄▄      ▄▄██▀
          ▀▀████████▀▀

 █▄▀ █▀▀ █▀█ █▄ █ █▀▀ █   █▀▄ █▀█ ▀█▀
 █▀▄ █▀▀ █▄▀ █ ██ █▀▀ █   ██▀ █ █  █
 █ █ █▄▄ █ █ █ ▀█ █▄▄ █▄▄ █▄▀ █▄█  █
`;

// Green terminal gradient
const monoGradient = gradient([
  '#00ff41',
  '#00cc33',
  '#009926',
  '#006619',
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

/**
 * Display a single character card in the CLI.
 * @param {object} character — character profile with name, emoji, tagline, origin, age, asciiArt
 * @param {boolean} isActive — whether this is the currently active character
 */
export function showCharacterCard(character, isActive = false) {
  const art = character.asciiArt || '';
  const activeTag = isActive ? chalk.green(' (active)') : '';
  const content = [
    `${character.emoji}  ${chalk.bold(character.name)}${activeTag}`,
    chalk.dim(`"${character.tagline}"`),
    '',
    ...(art ? art.split('\n').map(line => chalk.cyan(line)) : []),
    '',
    chalk.dim(`Origin: ${character.origin || 'Unknown'}`),
    chalk.dim(`Style: ${character.age || 'Unknown'}`),
  ].join('\n');

  console.log(
    boxen(content, {
      padding: 1,
      borderStyle: 'round',
      borderColor: isActive ? 'green' : 'cyan',
    }),
  );
}

/**
 * Display the full character gallery for CLI selection.
 * @param {object[]} characters — array of character profiles
 * @param {string|null} activeId — ID of the currently active character
 */
export function showCharacterGallery(characters, activeId = null) {
  console.log('');
  console.log(
    gradient(['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3']).multiline(
      '  ═══════════════════════════════\n' +
      '     CHOOSE YOUR CHARACTER\n' +
      '  ═══════════════════════════════',
    ),
  );
  console.log('');
  console.log(chalk.dim('  Each character has their own personality,'));
  console.log(chalk.dim('  memories, and story that evolves with you.'));
  console.log('');

  for (const c of characters) {
    showCharacterCard(c, c.id === activeId);
  }
}