import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import gradient from "gradient-string";
import * as p from "@clack/prompts";
import { PROVIDERS } from "../providers/models.js";

export { p };

function getLocalIp() {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const info of iface) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "localhost";
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
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
const monoGradient = gradient(["#00ff41", "#00cc33", "#009926", "#006619"]);

export function showLogo() {
  console.log(monoGradient.multiline(LOGO));
}

export async function showStartupCheck(label, checkFn) {
  const spinner = ora({ text: label, color: "cyan" }).start();
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
    boxen(chalk.green.bold("KernelBot is live"), {
      padding: 1,
      margin: { top: 1 },
      borderStyle: "round",
      borderColor: "green",
    }),
  );
}

export function showSuccess(msg) {
  console.log(
    boxen(chalk.green(msg), {
      padding: 1,
      borderStyle: "round",
      borderColor: "green",
    }),
  );
}

export function showError(msg) {
  console.log(
    boxen(chalk.red(msg), {
      padding: 1,
      borderStyle: "round",
      borderColor: "red",
    }),
  );
}

export function createSpinner(text) {
  return ora({ text, color: "cyan" });
}

/**
 * Display a single character card in the CLI.
 * @param {object} character — character profile with name, emoji, tagline, origin, age, asciiArt
 * @param {boolean} isActive — whether this is the currently active character
 */
export function showCharacterCard(character, isActive = false) {
  const art = character.asciiArt || "";
  const activeTag = isActive ? chalk.green(" (active)") : "";
  const content = [
    `${character.emoji}  ${chalk.bold(character.name)}${activeTag}`,
    chalk.dim(`"${character.tagline}"`),
    "",
    ...(art ? art.split("\n").map((line) => chalk.cyan(line)) : []),
    "",
    chalk.dim(`Origin: ${character.origin || "Unknown"}`),
    chalk.dim(`Age: ${character.age || "Unknown"}`),
  ].join("\n");

  console.log(
    boxen(content, {
      padding: 1,
      borderStyle: "round",
      borderColor: isActive ? "green" : "cyan",
    }),
  );
}

/**
 * Format "Provider / model" label for a config section.
 * @param {object} config — full config
 * @param {'brain'|'orchestrator'} section
 */
export function formatProviderLabel(config, section) {
  const sec = config[section];
  const providerDef = PROVIDERS[sec.provider];
  const name = providerDef ? providerDef.name : sec.provider;
  return `${name} / ${sec.model}`;
}

/**
 * Centralized cancel handler for @clack/prompts.
 * Call after every prompt — exits gracefully on Ctrl+C.
 */
export function handleCancel(value) {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    return true;
  }
  return false;
}

/**
 * Claude Code-inspired info box shown after the logo.
 */
export function showWelcomeScreen(config, characterManager) {
  const version = getVersion();

  const orchLabel = formatProviderLabel(config, "orchestrator");
  const brainLabel = formatProviderLabel(config, "brain");

  let charLabel = "None";
  if (characterManager) {
    const activeId = characterManager.getActiveCharacterId();
    const active = characterManager.getCharacter(activeId);
    if (active) charLabel = `${active.emoji} ${active.name}`;
  }

  const lifeEnabled = config.life?.enabled !== false;
  const dashPort = config.dashboard?.port || 3000;
  const dashEnabled = config.dashboard?.enabled;

  const pad = (label, width = 18) => label.padEnd(width);

  const lines = [
    "",
    `  ${chalk.dim(pad("Orchestrator"))}${orchLabel}`,
    `  ${chalk.dim(pad("Brain"))}${brainLabel}`,
    `  ${chalk.dim(pad("Character"))}${charLabel}`,
    `  ${chalk.dim(pad("Life Engine"))}${lifeEnabled ? chalk.green("enabled") : chalk.yellow("disabled")}`,
    `  ${chalk.dim(pad("Dashboard"))}${dashEnabled ? chalk.green(`http://${getLocalIp()}:${dashPort}/`) : chalk.yellow("off")}`,
    "",
    chalk.dim("  ↑↓ Navigate · Enter Select · Ctrl+C Cancel"),
  ];

  console.log(
    boxen(lines.join("\n"), {
      title: `KERNEL Bot v${version}`,
      titleAlignment: "left",
      padding: { top: 0, bottom: 0, left: 0, right: 2 },
      borderStyle: "round",
      borderColor: "green",
    }),
  );
}

export function showCharacterGallery(characters, activeId = null) {
  console.log("");
  console.log(
    gradient(["#ff6b6b", "#feca57", "#48dbfb", "#ff9ff3"]).multiline(
      "  ═══════════════════════════════\n" + "     CHOOSE YOUR CHARACTER\n" + "  ═══════════════════════════════",
    ),
  );
  console.log("");
  console.log(chalk.dim("  Each character has their own personality,"));
  console.log(chalk.dim("  memories, and story that evolves with you."));
  console.log("");

  for (const c of characters) {
    showCharacterCard(c, c.id === activeId);
  }
}
