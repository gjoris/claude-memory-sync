// Terminal output helpers. Colours only when stdout is a TTY, matching the
// original shell installer's behaviour.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const c = (code) => (useColor ? `[${code}m` : "");
const BOLD = c("1");
const RED = c("31");
const GREEN = c("32");
const YELLOW = c("33");
const CYAN = c("36");
const RESET = useColor ? "[0m" : "";

export const colors = { BOLD, RED, GREEN, YELLOW, CYAN, RESET };

export function info(msg = "") {
  process.stdout.write(`${msg}\n`);
}

export function note(msg = "") {
  process.stdout.write(`${CYAN}${msg}${RESET}\n`);
}

export function ok(msg = "") {
  process.stdout.write(`${GREEN}${msg}${RESET}\n`);
}

export function warn(msg = "") {
  process.stderr.write(`${YELLOW}${msg}${RESET}\n`);
}

export function err(msg = "") {
  process.stderr.write(`${RED}${msg}${RESET}\n`);
}

// Print an error and exit non-zero. Used for fatal, user-facing failures.
export function die(msg) {
  err(`error: ${msg}`);
  process.exit(1);
}

// A loud banner so manual steps are impossible to miss.
export function banner(msg) {
  const bar = "------------------------------------------------------------";
  process.stdout.write(`\n${BOLD}${bar}${RESET}\n`);
  process.stdout.write(`${BOLD}${msg}${RESET}\n`);
  process.stdout.write(`${BOLD}${bar}${RESET}\n\n`);
}
