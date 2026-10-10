/** Prompts for the steps a human does (pairing on the PC, hotspot, reboot, collector switch). */
import { createInterface } from "node:readline/promises";

export interface Step {
  /** stable id, recorded in the report and used by the tests' scripted operator */
  id: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface GateIO {
  log(line: string): void;
  ask(step: Step): Promise<string>;
}

export function terminalIO(): GateIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // On a TTY readline swallows Ctrl-C at a prompt (it only pauses); hand it to the process
  // so the gate's handler writes the report and exits.
  rl.on("SIGINT", () => { process.emit("SIGINT", "SIGINT"); });
  let closed = false;
  return {
    log: (line) => console.log(line),
    async ask(step) {
      console.log("");
      for (const l of step.text.split("\n")) console.log(`  ${l}`);
      return (await rl.question("> ")).trim();
    },
    close: () => { if (!closed) { closed = true; rl.close(); } },
  };
}
