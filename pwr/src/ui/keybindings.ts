/**
 * PWR UI - keyboard shortcut registry, single source of truth (JHL-15)
 *
 * Every shortcut key literal lives here and ONLY here. Shortcut registration
 * (ui/index.ts), the help text (commands.ts), the run-detail action hints
 * (views.ts) and the tests all derive from this module, so rebinding a key is
 * a one-line change instead of a shotgun edit (PRD 4.3: 键盘和命令均须可达).
 *
 * If you change a key, update the pinning test in tests/ui-commands.test.ts
 * ("shortcut registry pins exact keys") and the AGENTS.md mention.
 *
 * History: `pause` was `ctrl+alt+p` until the installed plan-mode extension
 * claimed the same key (pi keeps the last-registered shortcut and silently
 * breaks the other). The replacement follows the Unix Ctrl+Z suspend mnemonic
 * and stays clear of all pi built-ins (they only use ctrl+alt+]).
 */

/** One keyboard shortcut: the key, its label in help text, and its command twin. */
export interface ShortcutSpec {
	/** Keybinding id accepted by `pi.registerShortcut` (e.g. "ctrl+alt+x"). */
	key: string;
	/** Short action label used in help/detail lines. */
	action: string;
	/** Longer description shown in pi shortcut listings. */
	description: string;
	/** Command that performs the same action (PRD 4.3 parity). */
	command: string;
}

/** PWR global shortcuts. All operate on the last viewed run. */
export const PWR_SHORTCUTS = {
	pause: {
		key: "ctrl+alt+z",
		action: "pause",
		description: "Pause the last viewed PWR run",
		command: "workflows:pause",
	},
	stop: {
		key: "ctrl+alt+x",
		action: "stop",
		description: "Stop the last viewed PWR run",
		command: "workflows:stop",
	},
	restart: {
		key: "ctrl+alt+r",
		action: "restart agent",
		description: "Restart an agent of the last viewed PWR run",
		command: "workflows:restart",
	},
} as const satisfies Record<string, ShortcutSpec>;

export type ShortcutName = keyof typeof PWR_SHORTCUTS;

/** Formatted `[key]` hint for help/detail lines. */
export function shortcutHint(name: ShortcutName): string {
	return `[${PWR_SHORTCUTS[name].key}]`;
}
